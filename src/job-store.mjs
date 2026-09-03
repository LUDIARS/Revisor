import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { RevisorError } from "./errors.mjs";
import { workerLogPath } from "./worker-spawn.mjs";
import { normalizeReviewLane, REVIEW_LANES } from "./review-lane.mjs";
import { resolveStatePath } from "./state-store.mjs";
import {
  archiveLegacyJson,
  displaceLegacyJson,
  getMeta,
  openRevisorDatabase,
  resolveDbPath,
  setMeta,
  takeCounter,
  withImmediateTransaction,
} from "./revisor-db.mjs";

// 審査キューの正本。 PR 記録と同じ database に置く — 投入する CLI と実行するワーカーが
// 別プロセスなので、キューが記憶ではなく記録であることが前提になる。 テーブルは PR 記録と
// 分かれており、キューの入れ替えが PR 記録の schema を触ることはない。

// 1 つの job を実行し直す上限。 ワーカーが落ちた分の拾い直しは必要だが、
// 落ち続ける job を無限に拾い直すと、そのままキューが自己増殖する。
const MAX_ATTEMPTS = 2;

const LEGACY_JOBS_FILE = "revisor.jobs.json";
const JOBS_IMPORTED_KEY = "jobs_imported";
const NEXT_FAST_LANE_KEY = "nextFastLaneSequence";

/**
 * キューの座標。 database 本体のパスであり、ワーカーの presence lock / log /
 * 状態ファイルの名前もここから派生する。
 */
export function resolveJobsPath(env = process.env) {
  return resolveDbPath(env);
}

function resolveLegacyJobsPath(env = process.env) {
  return join(dirname(resolveStatePath(env)), LEGACY_JOBS_FILE);
}

function storedFastLaneSequence(job) {
  return Number.isSafeInteger(job.fastLaneSequence) && job.fastLaneSequence > 0
    ? job.fastLaneSequence
    : null;
}

// 旧 JSON の jobs を取り込み可能な形へ正規化する。 lane の欠けた記録は標準レーンへ、
// 順序番号の無い fast job には投入時刻順で番号を振り直す。
function canonicalizeLegacyJobs(value) {
  if (!value || value.version !== 1 || !Array.isArray(value.jobs)) {
    throw new Error("invalid schema");
  }
  for (const job of value.jobs) {
    job.reviewLane = normalizeReviewLane(job.reviewLane ?? job.request?.reviewLane);
    job.request = { ...job.request, reviewLane: job.reviewLane };
    if (job.reviewLane === REVIEW_LANES.FAST && !job.fastLaneEnteredAt) {
      job.fastLaneEnteredAt = job.createdAt;
    }
  }
  let lastSequence = value.jobs.reduce(
    (maximum, job) => Math.max(maximum, storedFastLaneSequence(job) ?? 0),
    0,
  );
  const missing = value.jobs
    .filter((job) => job.reviewLane === REVIEW_LANES.FAST && !storedFastLaneSequence(job))
    .sort((left, right) => {
      const leftTime = left.fastLaneEnteredAt ?? left.createdAt;
      const rightTime = right.fastLaneEnteredAt ?? right.createdAt;
      return leftTime.localeCompare(rightTime);
    });
  for (const job of missing) job.fastLaneSequence = ++lastSequence;
  value.nextFastLaneSequence = Number.isSafeInteger(value.nextFastLaneSequence)
    && value.nextFastLaneSequence > lastSequence
    ? value.nextFastLaneSequence
    : lastSequence + 1;
  return value;
}

function processIsGone(pid) {
  if (!Number.isInteger(pid)) return true;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return error.code === "ESRCH";
  }
}

function jobKey(request) {
  return `${request.repository}#${request.number}@${request.headSha}`;
}

export class JobStore {
  #database = null;

  constructor({
    path = resolveJobsPath(),
    legacyPath,
    now = () => new Date().toISOString(),
    createId = randomUUID,
    maxJobs = 200,
  } = {}) {
    this.path = path;
    this.legacyPath = legacyPath ?? resolveLegacyJobsPath();
    this.now = now;
    this.createId = createId;
    this.maxJobs = maxJobs;
  }

  #db() {
    if (this.#database) return this.#database;
    try {
      const displaced = displaceLegacyJson(this.path);
      const database = openRevisorDatabase(this.path);
      this.#importLegacy(database, displaced);
      this.#database = database;
    } catch (error) {
      throw new RevisorError(`Revisor job queue is unreadable: ${this.path}`, { cause: error });
    }
    return this.#database;
  }

  /** 旧 JSON キューを一度だけ取り込む。 取り込み済みかは database 自身が記憶する。 */
  #importLegacy(database, displaced) {
    let renameLegacyAside = false;
    const imported = withImmediateTransaction(database, () => {
      if (getMeta(database, JOBS_IMPORTED_KEY)) return false;
      let legacy = displaced;
      if (!legacy && this.legacyPath !== this.path && existsSync(this.legacyPath)) {
        legacy = JSON.parse(readFileSync(this.legacyPath, "utf8"));
        renameLegacyAside = true;
      }
      if (legacy) {
        const value = canonicalizeLegacyJobs(legacy);
        const save = database.prepare("INSERT OR REPLACE INTO jobs (id, record) VALUES (?, ?)");
        for (const job of value.jobs) save.run(job.id, JSON.stringify(job));
        setMeta(database, NEXT_FAST_LANE_KEY, value.nextFastLaneSequence);
      }
      setMeta(database, JOBS_IMPORTED_KEY, "1");
      return true;
    });
    if (imported && renameLegacyAside) {
      try {
        archiveLegacyJson(this.legacyPath);
      } catch {
        // 退避できなくても取り込みは確定済み。 残った旧ファイルは二度と読まれない。
      }
    }
  }

  #mutate(run) {
    const database = this.#db();
    return withImmediateTransaction(database, () => run(database));
  }

  #allJobs(database) {
    return database.prepare("SELECT record FROM jobs").all()
      .map((row) => JSON.parse(row.record));
  }

  #saveJob(database, job) {
    database
      .prepare("INSERT OR REPLACE INTO jobs (id, record) VALUES (?, ?)")
      .run(job.id, JSON.stringify(job));
  }

  #deleteJob(database, id) {
    database.prepare("DELETE FROM jobs WHERE id = ?").run(id);
  }

  /**
   * 投入する。 同じ (repo, number, head) の job が未終了なら、それが既に求められている
   * 実行なのでそのまま返す。 `force` は終了済み job の履歴を残したまま新しい実行を作る
   * (同一ヘッドの再審査がここで握り潰されず、停滞 job の終局理由も失わないため)。
   */
  async enqueue(request, { force = false } = {}) {
    const key = jobKey(request);
    return this.#mutate((database) => {
      const matching = this.#allJobs(database)
        .filter((job) => job.key === key)
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
      const active = matching.find((job) => job.status === "queued" || job.status === "running");
      if (active) return { job: active, created: false };
      if (matching[0] && !force) return { job: matching[0], created: false };
      const timestamp = this.now();
      const reviewLane = normalizeReviewLane(request.reviewLane);
      const job = {
        id: this.createId(),
        key,
        localPrId: request.localPrId,
        reviewLane,
        request: {
          ...request,
          reviewLane,
        },
        status: "queued",
        attempts: 0,
        claimedPid: null,
        error: null,
        createdAt: timestamp,
        updatedAt: timestamp,
        fastLaneEnteredAt: reviewLane === REVIEW_LANES.FAST
          ? timestamp
          : null,
        fastLaneSequence: reviewLane === REVIEW_LANES.FAST
          ? takeCounter(database, NEXT_FAST_LANE_KEY)
          : null,
      };
      this.#saveJob(database, job);
      this.#trim(database);
      return { job, created: true };
    });
  }

  /**
   * 実行できる job を 1 つ確保する。 確保と同時に pid を書くので、ワーカーが死んだ job は
   * `reclaimAbandoned` から見分けられる。
   */
  async claimNext({ reviewLane = null } = {}) {
    const selectedLane = reviewLane === null ? null : normalizeReviewLane(reviewLane);
    return this.#mutate((database) => {
      const job = this.#allJobs(database)
        .filter((candidate) => candidate.status === "queued"
          && (selectedLane === null
            || normalizeReviewLane(candidate.reviewLane ?? candidate.request?.reviewLane)
              === selectedLane))
        .sort((left, right) => {
          if (selectedLane === null) {
            const leftLane = normalizeReviewLane(left.reviewLane ?? left.request?.reviewLane);
            const rightLane = normalizeReviewLane(right.reviewLane ?? right.request?.reviewLane);
            if (leftLane !== rightLane) return leftLane === REVIEW_LANES.FAST ? -1 : 1;
          }
          const orderedLane = selectedLane
            ?? normalizeReviewLane(left.reviewLane ?? left.request?.reviewLane);
          const leftOrder = orderedLane === REVIEW_LANES.FAST
            ? storedFastLaneSequence(left)
            : left.createdAt;
          const rightOrder = orderedLane === REVIEW_LANES.FAST
            ? storedFastLaneSequence(right)
            : right.createdAt;
          return orderedLane === REVIEW_LANES.FAST
            ? leftOrder - rightOrder
            : leftOrder.localeCompare(rightOrder);
        })[0];
      if (!job) return null;
      job.status = "running";
      job.attempts += 1;
      job.claimedPid = process.pid;
      job.updatedAt = this.now();
      this.#saveJob(database, job);
      return job;
    });
  }

  /** @implements SPEC-REVIEW-FAST-LANE-DURABILITY */
  async promote(localPrId) {
    return this.#mutate((database) => {
      const job = this.#allJobs(database).find((candidate) =>
        candidate.localPrId === localPrId && candidate.status === "queued");
      if (!job) {
        throw new RevisorError(`Queued review job for local PR '${localPrId}' was not found.`);
      }
      if (job.reviewLane === REVIEW_LANES.FAST) return job;
      job.reviewLane = REVIEW_LANES.FAST;
      job.request = { ...job.request, reviewLane: REVIEW_LANES.FAST };
      // Promotion joins the tail of the existing fast FIFO instead of jumping
      // ahead based on the older standard-lane submission timestamp.
      const timestamp = this.now();
      job.fastLaneEnteredAt = timestamp;
      job.fastLaneSequence = takeCounter(database, NEXT_FAST_LANE_KEY);
      job.updatedAt = timestamp;
      this.#saveJob(database, job);
      return job;
    });
  }

  async settle(id, { status, error = null }) {
    return this.#mutate((database) => {
      const row = database.prepare("SELECT record FROM jobs WHERE id = ?").get(id);
      if (!row) throw new RevisorError(`Review job '${id}' was not found.`);
      const job = JSON.parse(row.record);
      // A worker may finish after an operator has abandoned its job. Terminal
      // state is monotonic: that late completion must not erase the recorded
      // intervention (or resurrect a job reclaimed after worker death).
      if (job.status === "completed" || job.status === "failed") return job;
      job.status = status;
      job.error = error;
      job.claimedPid = null;
      job.updatedAt = this.now();
      this.#saveJob(database, job);
      return job;
    });
  }

  /**
   * 死んだワーカーが抱えたまま終わった job を拾い直す。
   *
   * ワーカーは短命なので「running なのに保持プロセスが居ない」がそのまま中断の証拠に
   * なり、時間しきい値は要らない。 試行上限を超えたものは queued に戻さず failed で
   * 終局させる — ここを無条件に戻すと、落ち続ける job がキューに永住する。
   */
  async reclaimAbandoned() {
    return this.#mutate((database) => {
      const requeued = [];
      const exhausted = [];
      for (const job of this.#allJobs(database)) {
        if (job.status !== "running" || !processIsGone(job.claimedPid)) continue;
        job.claimedPid = null;
        job.updatedAt = this.now();
        if (job.attempts >= MAX_ATTEMPTS) {
          job.status = "failed";
          // 死因はワーカーの出力にしか出ない。 どこを見ればよいかを文言に含める
          // (これが無かったため、 死んだ事実だけが残って追跡できなかった)。
          // This error is persisted and sent through the lifecycle reporter;
          // never expose the workstation's absolute state path there.
          job.error = `The review worker died ${job.attempts} time(s); Revisor stopped retrying it.`
            + ` See the local ${basename(workerLogPath(this.path))} for the worker output.`;
          this.#saveJob(database, job);
          exhausted.push(job);
          continue;
        }
        job.status = "queued";
        this.#saveJob(database, job);
        requeued.push(job);
      }
      return { requeued, exhausted };
    });
  }

  /**
   * 進まなくなった job を人手の指示で終局させる。
   *
   * `reclaimAbandoned` は「保持プロセスが死んでいる」ことを中断の証拠にする。 保持者が
   * 短命ワーカーだった頃はそれで足りたが、 いまの保持者はキューを空にするまで生き続ける
   * コーディネータなので、 審査が途中で止まっても保持者は生存し続け、 job は running の
   * まま誰にも拾われない。 その状態では retry も close もガードに弾かれ、 Revisor を
   * 落とす以外の回復手段が無くなる (実例: LUDIARS/Concordia#1269 が 1 時間 running)。
   *
   * 時間しきい値で自動判定はしない — 長い審査を勝手に殺さないという既存方針は保つ。
   * 「止まっている」と判断するのは人間で、 ここはその判断を実行するだけの口。
   *
   * @implements SPEC-MANUAL-STALLED-REVIEW-RECOVERY
   */
  async abandonForLocalPr(localPrId, reason) {
    if (typeof localPrId !== "string" || !localPrId.trim()) {
      throw new RevisorError("Abandoning review jobs requires a local PR id.");
    }
    if (typeof reason !== "string" || !reason.trim()) {
      throw new RevisorError("Abandoning review jobs requires a reason.");
    }
    return this.#mutate((database) => {
      const abandoned = [];
      for (const job of this.#allJobs(database)) {
        if (job.localPrId !== localPrId && job.request?.localPrId !== localPrId) continue;
        if (job.status !== "queued" && job.status !== "running") continue;
        job.status = "failed";
        job.error = reason;
        job.claimedPid = null;
        job.updatedAt = this.now();
        this.#saveJob(database, job);
        abandoned.push(job);
      }
      return abandoned;
    });
  }

  get(id) {
    const row = this.#db().prepare("SELECT record FROM jobs WHERE id = ?").get(id);
    return row ? JSON.parse(row.record) : null;
  }

  list() {
    return this.#allJobs(this.#db())
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  state() {
    const jobs = this.list();
    return {
      queued: jobs.filter((job) => job.status === "queued").length,
      running: jobs.filter((job) => job.status === "running").length,
      lanes: {
        standard: jobs.filter((job) =>
          (job.status === "queued" || job.status === "running")
          && job.reviewLane === REVIEW_LANES.STANDARD).length,
        fast: jobs.filter((job) =>
          (job.status === "queued" || job.status === "running")
          && job.reviewLane === REVIEW_LANES.FAST).length,
      },
      jobs,
    };
  }

  // 終局した job だけを古い順に落とす。 未終了の job を数合わせで消すと、実行中の
  // ワーカーが自分の job を見失う。
  #trim(database) {
    const jobs = this.#allJobs(database);
    if (jobs.length <= this.maxJobs) return;
    let count = jobs.length;
    const settled = jobs
      .filter((job) => job.status === "completed" || job.status === "failed")
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    for (const job of settled) {
      if (count <= this.maxJobs) return;
      this.#deleteJob(database, job.id);
      count -= 1;
    }
  }
}
