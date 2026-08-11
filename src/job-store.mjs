import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { RevisorError } from "./errors.mjs";
import { withFileLock } from "./file-lock.mjs";
import { normalizeReviewLane, REVIEW_LANES } from "./review-lane.mjs";
import { resolveStatePath } from "./state-store.mjs";

// 審査キューの正本。 常駐プロセスの in-memory キューだったものをファイルへ移した。
// 投入する CLI と実行するワーカーが別プロセスなので、キューが記憶ではなく記録である
// ことが前提になる。 PR 本体の state とは別ファイルにして、キューの入れ替えが
// PR 記録の schema を触らないようにする。

// 1 つの job を実行し直す上限。 ワーカーが落ちた分の拾い直しは必要だが、
// 落ち続ける job を無限に拾い直すと、そのままキューが自己増殖する。
const MAX_ATTEMPTS = 2;

export function resolveJobsPath(env = process.env) {
  return join(dirname(resolveStatePath(env)), "revisor.jobs.json");
}

function emptyJobs() {
  return { version: 1, nextFastLaneSequence: 1, jobs: [] };
}

function storedFastLaneSequence(job) {
  return Number.isSafeInteger(job.fastLaneSequence) && job.fastLaneSequence > 0
    ? job.fastLaneSequence
    : null;
}

function canonicalizeFastLaneSequence(value) {
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
}

function takeFastLaneSequence(value) {
  const sequence = value.nextFastLaneSequence;
  value.nextFastLaneSequence += 1;
  return sequence;
}

function readJobs(path) {
  if (!existsSync(path)) return emptyJobs();
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
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
    canonicalizeFastLaneSequence(value);
    return value;
  } catch (error) {
    throw new RevisorError(`Revisor job queue is unreadable: ${path}`, { cause: error });
  }
}

function writeJobs(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
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
  constructor({
    path = resolveJobsPath(),
    now = () => new Date().toISOString(),
    createId = randomUUID,
    maxJobs = 200,
  } = {}) {
    this.path = path;
    this.now = now;
    this.createId = createId;
    this.maxJobs = maxJobs;
  }

  #mutate(run, label) {
    return withFileLock(this.path, () => {
      const value = readJobs(this.path);
      const outcome = run(value);
      writeJobs(this.path, value);
      return outcome;
    }, { label });
  }

  /**
   * 投入する。 同じ (repo, number, head) の job が未終了なら、それが既に求められている
   * 実行なのでそのまま返す。 `force` は終了済み job を捨てて必ず新しい実行を作る
   * (同一ヘッドの再審査がここで握り潰されないようにするため)。
   */
  async enqueue(request, { force = false } = {}) {
    const key = jobKey(request);
    return this.#mutate((value) => {
      const existing = value.jobs.find((job) => job.key === key);
      if (existing && (!force || existing.status === "queued" || existing.status === "running")) {
        return { job: structuredClone(existing), created: false };
      }
      if (existing) value.jobs.splice(value.jobs.indexOf(existing), 1);
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
          ? takeFastLaneSequence(value)
          : null,
      };
      value.jobs.push(job);
      trim(value, this.maxJobs);
      return { job: structuredClone(job), created: true };
    }, "enqueue");
  }

  /**
   * 実行できる job を 1 つ確保する。 確保と同時に pid を書くので、ワーカーが死んだ job は
   * `reclaimAbandoned` から見分けられる。
   */
  async claimNext({ reviewLane = null } = {}) {
    const selectedLane = reviewLane === null ? null : normalizeReviewLane(reviewLane);
    return this.#mutate((value) => {
      const job = value.jobs
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
      return structuredClone(job);
    }, "claim");
  }

  /** @implements SPEC-REVIEW-FAST-LANE-DURABILITY */
  async promote(localPrId) {
    return this.#mutate((value) => {
      const job = value.jobs.find((candidate) =>
        candidate.localPrId === localPrId && candidate.status === "queued");
      if (!job) {
        throw new RevisorError(`Queued review job for local PR '${localPrId}' was not found.`);
      }
      if (job.reviewLane === REVIEW_LANES.FAST) return structuredClone(job);
      job.reviewLane = REVIEW_LANES.FAST;
      job.request = { ...job.request, reviewLane: REVIEW_LANES.FAST };
      // Promotion joins the tail of the existing fast FIFO instead of jumping
      // ahead based on the older standard-lane submission timestamp.
      const timestamp = this.now();
      job.fastLaneEnteredAt = timestamp;
      job.fastLaneSequence = takeFastLaneSequence(value);
      job.updatedAt = timestamp;
      return structuredClone(job);
    }, "promote-fast-lane");
  }

  async settle(id, { status, error = null }) {
    return this.#mutate((value) => {
      const job = value.jobs.find((candidate) => candidate.id === id);
      if (!job) throw new RevisorError(`Review job '${id}' was not found.`);
      job.status = status;
      job.error = error;
      job.claimedPid = null;
      job.updatedAt = this.now();
      return structuredClone(job);
    }, "settle");
  }

  /**
   * 死んだワーカーが抱えたまま終わった job を拾い直す。
   *
   * ワーカーは短命なので「running なのに保持プロセスが居ない」がそのまま中断の証拠に
   * なり、時間しきい値は要らない。 試行上限を超えたものは queued に戻さず failed で
   * 終局させる — ここを無条件に戻すと、落ち続ける job がキューに永住する。
   */
  async reclaimAbandoned() {
    return this.#mutate((value) => {
      const requeued = [];
      const exhausted = [];
      for (const job of value.jobs) {
        if (job.status !== "running" || !processIsGone(job.claimedPid)) continue;
        job.claimedPid = null;
        job.updatedAt = this.now();
        if (job.attempts >= MAX_ATTEMPTS) {
          job.status = "failed";
          job.error = `The review worker died ${job.attempts} time(s); Revisor stopped retrying it.`;
          exhausted.push(structuredClone(job));
          continue;
        }
        job.status = "queued";
        requeued.push(structuredClone(job));
      }
      return { requeued, exhausted };
    }, "reclaim");
  }

  get(id) {
    const job = readJobs(this.path).jobs.find((candidate) => candidate.id === id);
    return job ? structuredClone(job) : null;
  }

  list() {
    return structuredClone(readJobs(this.path).jobs)
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
}

// 終局した job だけを古い順に落とす。 未終了の job を数合わせで消すと、実行中の
// ワーカーが自分の job を見失う。
function trim(value, maxJobs) {
  if (value.jobs.length <= maxJobs) return;
  const settled = value.jobs
    .filter((job) => job.status === "completed" || job.status === "failed")
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  for (const job of settled) {
    if (value.jobs.length <= maxJobs) return;
    value.jobs.splice(value.jobs.indexOf(job), 1);
  }
}
