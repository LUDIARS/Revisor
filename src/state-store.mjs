import { existsSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { resolveConfigPath } from "./config.mjs";
import { RevisorError } from "./errors.mjs";
import {
  archiveLegacyJson,
  displaceLegacyJson,
  getMeta,
  openRevisorDatabase,
  resolveDbPath,
  setMeta,
  takeCounter,
  withImmediateTransaction,
  withReadTransaction,
} from "./revisor-db.mjs";
import {
  detachAnatomia,
  needsAnatomiaSplit,
  readAnatomia,
  splitInlineAnatomia,
  writeAnatomia,
} from "./pull-request-anatomia.mjs";

const STATE_PATH_ENV = "REVISOR_STATE_PATH";
const QA_ELIGIBLE_CHECK_STATUSES = new Set(["queued", "running", "test_ok"]);
const MAX_PULL_REQUEST_EVENTS = 50;
const LEGACY_STATE_FILE = "revisor.state.json";
const STATE_IMPORTED_KEY = "state_imported";
const NEXT_PR_NUMBER_KEY = "nextPullRequestNumber";

function testWorkflowStatus(checkStatus) {
  return checkStatus === "test_ok" ? "Open / Test OK" : "Open / In Review";
}

/** 旧 JSON state の置き場。 database への取り込み元としてだけ残っている。 */
export function resolveStatePath(env = process.env) {
  return env[STATE_PATH_ENV]
    ?? join(dirname(resolveConfigPath(env)), LEGACY_STATE_FILE);
}

/**
 * 配布済み pre-push hook には旧 `revisor.state.json` のパスが焼き込まれている。
 * hook を再インストールしなくても guard が動くよう、旧パスは同じディレクトリの
 * database へ読み替える。
 */
export function redirectLegacyStorePath(path) {
  return basename(path) === LEGACY_STATE_FILE
    ? join(dirname(path), "revisor.db")
    : path;
}

// v1 はリポジトリごとの連番だった。 番号は横断利用 (Rv#xxx だけで PR を特定して
// ワークフローを回す) が前提になったので、 全リポジトリ共通の 1 本へ振り直す。
function migrateToGlobalNumbering(state) {
  const ordered = [...state.pullRequests].sort((left, right) =>
    left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
  ordered.forEach((pullRequest, index) => {
    pullRequest.number = index + 1;
  });
  return {
    ...state,
    version: 2,
    nextPullRequestNumber: ordered.length + 1,
  };
}

function validateLegacyState(value) {
  if (
    !value
    || (value.version !== 1 && value.version !== 2)
    || !Array.isArray(value.repositories)
    || !Array.isArray(value.pullRequests)
  ) {
    throw new Error("invalid schema");
  }
  if (value.version === 1) return migrateToGlobalNumbering(value);
  if (!Number.isInteger(value.nextPullRequestNumber) || value.nextPullRequestNumber < 1) {
    throw new Error("invalid schema");
  }
  return value;
}

function parseRecords(rows) {
  return rows.map((row) => JSON.parse(row.record));
}

// Legacy JSON and databases predate external verification. Normalize that
// absence at the persistence boundary so every current full PR shape includes
// the field without rewriting imported evidence.
function parsePullRequestRecord(record) {
  const pullRequest = JSON.parse(record);
  return {
    ...pullRequest,
    externalVerification: pullRequest.externalVerification ?? null,
  };
}

/**
 * 解析結果 (`anatomia`) を付け戻した記録。 本体に残っている値 (旧コードの書き込み) が
 * あればそれを、 無ければ別テーブルの値を使う。 どちらにも無ければキーを作らない。
 */
function attachAnatomia(loaded, database, id) {
  const anatomia = loaded.inline ? loaded.anatomia : readAnatomia(database, id);
  return anatomia === undefined ? loaded.light : { ...loaded.light, anatomia };
}

export class LocalPrStore {
  #database = null;
  #writes = 0;

  constructor({
    path = resolveDbPath(),
    legacyPath,
    now = () => new Date().toISOString(),
    createId = randomUUID,
    onEvent = () => {},
  } = {}) {
    this.path = path;
    this.legacyPath = legacyPath
      ?? process.env[STATE_PATH_ENV]
      ?? join(dirname(path), LEGACY_STATE_FILE);
    this.now = now;
    this.createId = createId;
    this.onEvent = onEvent;
  }

  #db() {
    if (this.#database) return this.#database;
    try {
      // 同じパスに旧 JSON が居る場合は database を作る前に読む必要がある
      // (JSON の上に SQLite は開けない)。 妥当な JSON だけが退避される。
      const displaced = displaceLegacyJson(this.path);
      const database = openRevisorDatabase(this.path);
      this.#importLegacy(database, displaced);
      this.#splitAnatomia(database);
      this.#database = database;
    } catch (error) {
      throw new RevisorError(`Revisor state is unreadable: ${this.path}`, { cause: error });
    }
    return this.#database;
  }

  /** 旧 JSON state を一度だけ取り込む。 取り込み済みかは database 自身が記憶する。 */
  #importLegacy(database, displaced) {
    let renameLegacyAside = false;
    const imported = withImmediateTransaction(database, () => {
      if (getMeta(database, STATE_IMPORTED_KEY)) return false;
      let legacy = displaced;
      if (!legacy && this.legacyPath !== this.path && existsSync(this.legacyPath)) {
        legacy = JSON.parse(readFileSync(this.legacyPath, "utf8"));
        renameLegacyAside = true;
      }
      if (legacy) {
        const state = validateLegacyState(legacy);
        const saveRepository = database.prepare(
          "INSERT OR REPLACE INTO repositories (id, record) VALUES (?, ?)");
        for (const record of state.repositories) {
          saveRepository.run(record.id, JSON.stringify(record));
        }
        const savePullRequest = database.prepare(
          "INSERT OR REPLACE INTO pull_requests (id, record) VALUES (?, ?)");
        for (const record of state.pullRequests) {
          savePullRequest.run(record.id, JSON.stringify(record));
        }
        setMeta(database, NEXT_PR_NUMBER_KEY, state.nextPullRequestNumber);
      }
      setMeta(database, STATE_IMPORTED_KEY, "1");
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

  /**
   * 本体に入っている解析結果を別テーブルへ一度だけ移す。 移行済みかは読むだけで判定し、
   * 済んだ database を開くたびに書き込みロックを取らない (審査ワーカーは頻繁に開く)。
   */
  #splitAnatomia(database) {
    if (!needsAnatomiaSplit(database)) return;
    withImmediateTransaction(database, () => splitInlineAnatomia(database));
  }

  #mutate(run) {
    const database = this.#db();
    const result = withImmediateTransaction(database, () => run(database));
    this.#writes += 1;
    return result;
  }

  #allRepositories(database) {
    return parseRecords(database.prepare("SELECT record FROM repositories").all());
  }

  #findRepositoryRecord(database, repository) {
    const key = String(repository).toLowerCase();
    return this.#allRepositories(database)
      .find((candidate) => candidate.repository.toLowerCase() === key) ?? null;
  }

  #saveRepository(database, record) {
    database
      .prepare("INSERT OR REPLACE INTO repositories (id, record) VALUES (?, ?)")
      .run(record.id, JSON.stringify(record));
  }

  /** 一覧用の記録。 解析結果 (`anatomia`) は持たない — 単一 PR の取得で読む。 */
  #allPullRequests(database) {
    return database.prepare("SELECT record FROM pull_requests").all()
      .map((row) => detachAnatomia(parsePullRequestRecord(row.record)).light);
  }

  #loadPullRequest(database, id) {
    const row = database.prepare("SELECT record FROM pull_requests WHERE id = ?").get(id);
    return row ? detachAnatomia(parsePullRequestRecord(row.record)) : null;
  }

  #getPullRequestRecord(database, id) {
    const loaded = this.#loadPullRequest(database, id);
    return loaded ? attachAnatomia(loaded, database, id) : null;
  }

  /**
   * 記録を保存する。 解析結果は `anatomiaTouched` のときだけ書き直す — 状態遷移や
   * イベント追記のたびに数 MB の解析結果を書き直さないため。
   */
  #savePullRequest(database, record, { anatomiaTouched = true } = {}) {
    const { light, anatomia } = detachAnatomia(record);
    database
      .prepare("INSERT OR REPLACE INTO pull_requests (id, record) VALUES (?, ?)")
      .run(record.id, JSON.stringify(light));
    if (anatomiaTouched) writeAnatomia(database, record.id, anatomia);
  }

  emitPullRequest(type, record) {
    try {
      this.onEvent({
        type,
        pullRequestId: record.id,
        repository: record.repository,
        number: record.number,
        status: record.status,
        checkStatus: record.checkStatus,
        updatedAt: record.updatedAt,
      });
    } catch {
      // Persistence succeeded already; an observer is never allowed to undo it.
    }
  }

  registerRepository(repository) {
    return this.#mutate((database) => {
      const timestamp = this.now();
      const existing = this.#findRepositoryRecord(database, repository.repository);
      if (existing) {
        const merged = {
          ...existing,
          ...repository,
          id: existing.id,
          createdAt: existing.createdAt,
          updatedAt: timestamp,
        };
        this.#saveRepository(database, merged);
        return merged;
      }
      const record = {
        id: this.createId(),
        ...repository,
        pushGuard: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      this.#saveRepository(database, record);
      return record;
    });
  }

  // 公開ワークフローだけを差し替える。 再登録 (`repo register`) を通すと test_cases
  // など登録本文の全項目を書き直す必要があり、 属性 1 つの変更には重すぎる。
  updateRepositoryWorkflow(repository, workflow) {
    return this.#mutate((database) => {
      const existing = this.#findRepositoryRecord(database, repository);
      if (!existing) return null;
      existing.workflow = workflow;
      existing.updatedAt = this.now();
      this.#saveRepository(database, existing);
      return existing;
    });
  }

  getRepository(repository) {
    return this.#findRepositoryRecord(this.#db(), repository);
  }

  findRepositoryByPath(rootPath) {
    const normalized = String(rootPath).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
    return this.#allRepositories(this.#db()).find((candidate) =>
      candidate.rootPath.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase()
        === normalized) ?? null;
  }

  listRepositories() {
    return this.#allRepositories(this.#db())
      .sort((left, right) => left.repository.localeCompare(right.repository));
  }

  createPullRequest(pullRequest) {
    return this.#persistPullRequest(pullRequest, { deduplicate: false }).pullRequest;
  }

  /** @implements SPEC-DAEMONLESS-PROCESS-LOCKS */
  createPullRequestIfAbsent(pullRequest) {
    return this.#persistPullRequest(pullRequest, { deduplicate: true });
  }

  /** @implements SPEC-DAEMONLESS-PROCESS-LOCKS */
  #persistPullRequest(pullRequest, { deduplicate }) {
    const outcome = this.#mutate((database) => {
      if (deduplicate) {
        const existing = this.#allPullRequests(database).find((candidate) =>
          candidate.status === "open"
          && candidate.repository.toLowerCase() === pullRequest.repository.toLowerCase()
          && candidate.headSha.toLowerCase() === pullRequest.headSha.toLowerCase());
        if (existing) {
          // 相乗り先は再投入に使われるので、 引き継ぐ段階の成果まで揃えて返す。
          return { pullRequest: this.#getPullRequestRecord(database, existing.id), created: false };
        }
      }
      const timestamp = this.now();
      const number = takeCounter(database, NEXT_PR_NUMBER_KEY);
      const record = {
        id: this.createId(),
        number,
        ...pullRequest,
        status: "open",
        checkStatus: "queued",
        mergeCommitSha: null,
        mergeError: null,
        lifecycleEvents: [],
        releaseTag: null,
        releaseUrl: null,
        // GitHub まで届いたか保留中か。 マージするまでどちらでもない。
        publication: null,
        deferredPublishReason: null,
        publishedAt: null,
        externalVerification: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      this.#savePullRequest(database, record);
      return { pullRequest: record, created: true };
    });
    if (outcome.created) this.emitPullRequest("pull_request.created", outcome.pullRequest);
    return outcome;
  }

  getPullRequest(id) {
    return this.#getPullRequestRecord(this.#db(), id);
  }

  /** 1 件の解析結果だけ。 一覧の記録から提案を導くときに使う。 無ければ null。 */
  getPullRequestAnatomia(id) {
    const database = this.#db();
    const loaded = this.#loadPullRequest(database, id);
    if (!loaded) return null;
    return (loaded.inline ? loaded.anatomia : readAnatomia(database, id)) ?? null;
  }

  findExactPullRequest(repository, headSha) {
    const database = this.#db();
    const found = this.#allPullRequests(database).find((candidate) =>
      candidate.status === "open"
      && candidate.repository.toLowerCase() === repository.toLowerCase()
      && candidate.headSha.toLowerCase() === headSha.toLowerCase());
    return found ? this.#getPullRequestRecord(database, found.id) : null;
  }

  /**
   * 一覧。 記録は解析結果 (`anatomia`) を持たない。 解析結果が要る処理は
   * {@link getPullRequest} で 1 件ずつ読むこと。
   */
  listPullRequests() {
    return this.#allPullRequests(this.#db())
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  /**
   * 一覧キャッシュの無効化トークン。data_version は他コネクションの commit で変わり、
   * 自コネクションの書き込みでは変わらないため、自前の書き込み回数を併記する。
   * PR 記録と審査キューは同じ database なので、どちらの変化でもトークンが変わる。
   */
  listVersion() {
    const database = this.#db();
    const { data_version: dataVersion } = database.prepare("PRAGMA data_version").get();
    return `${dataVersion}:${this.#writes}`;
  }

  updatePullRequest(id, patch) {
    return this.updatePullRequestWith(id, () => patch);
  }

  /** @implements SPEC-DAEMONLESS-PROCESS-LOCKS */
  updatePullRequestWith(id, createPatch) {
    const outcome = this.#mutate((database) => {
      const loaded = this.#loadPullRequest(database, id);
      if (!loaded) throw new RevisorError(`Local PR '${id}' was not found.`);
      const record = attachAnatomia(loaded, database, id);
      // patch 関数へはコピーを渡す。 返り値だけが反映され、引数への直接変更は捨てられる
      // — という契約を JSON ファイル時代から変えない。
      const patch = createPatch(structuredClone(record));
      if (!patch || Object.keys(patch).length === 0) {
        return { pullRequest: record, updated: false };
      }
      const merged = { ...record, ...patch, id: record.id, updatedAt: this.now() };
      // 本体に残っていた解析結果は、 この書き込みで別テーブルへ移す。
      this.#savePullRequest(database, merged, {
        anatomiaTouched: loaded.inline || Object.hasOwn(patch, "anatomia"),
      });
      return { pullRequest: merged, updated: true };
    });
    if (outcome.updated) this.emitPullRequest("pull_request.updated", outcome.pullRequest);
    return outcome.pullRequest;
  }

  appendPullRequestEvent(id, event) {
    const updated = this.#mutate((database) => {
      const loaded = this.#loadPullRequest(database, id);
      if (!loaded) throw new RevisorError(`Local PR '${id}' was not found.`);
      const record = attachAnatomia(loaded, database, id);
      const lifecycleEvents = Array.isArray(record.lifecycleEvents)
        ? record.lifecycleEvents
        : [];
      lifecycleEvents.push({
        event: String(event.event),
        message: String(event.message),
        tone: String(event.tone ?? "idle"),
        at: this.now(),
      });
      record.lifecycleEvents = lifecycleEvents.slice(-MAX_PULL_REQUEST_EVENTS);
      record.updatedAt = this.now();
      this.#savePullRequest(database, record, { anatomiaTouched: loaded.inline });
      return record;
    });
    this.emitPullRequest("pull_request.updated", updated);
    return updated;
  }

  updatePushGuard(repository, pushGuard) {
    return this.#mutate((database) => {
      const record = this.#findRepositoryRecord(database, repository);
      if (!record) throw new RevisorError(`Repository '${repository}' is not registered.`);
      record.pushGuard = pushGuard;
      record.updatedAt = this.now();
      this.#saveRepository(database, record);
      return record;
    });
  }

  testWorkflowProducts() {
    const database = this.#db();
    // リポジトリと PR は別テーブルになったので、同じスナップショットで読む。
    const { repositories, pullRequests } = withReadTransaction(database, () => ({
      repositories: this.#allRepositories(database),
      pullRequests: this.#allPullRequests(database),
    }));
    return repositories.flatMap((repository) => {
      const latest = pullRequests
        .filter((pullRequest) =>
          pullRequest.repository.toLowerCase() === repository.repository.toLowerCase()
          && pullRequest.status === "open"
          && QA_ELIGIBLE_CHECK_STATUSES.has(pullRequest.checkStatus))
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
      if (!latest) return [];
      // 審査を通ったかどうかがこの射影の唯一の分岐。 状態名・QA モード・reviewed head
      // を 1 か所で判定し、 3 つが食い違わないようにする。
      const approved = latest.checkStatus === "test_ok";
      return [{
        repository: repository.repository,
        pullRequestId: latest.id,
        number: latest.number,
        title: latest.title,
        status: testWorkflowStatus(latest.checkStatus),
        checkStatus: latest.checkStatus,
        qaMode: approved ? "approved" : "early",
        headSha: latest.headSha,
        // 審査中は reviewed head を出さない。 出すと先行QAの記録が審査済みの証拠に
        // 化ける。
        reviewedHeadSha: approved ? (latest.reviewedHeadSha ?? null) : null,
        externalVerification: latest.externalVerification ?? null,
        updatedAt: latest.updatedAt,
      }];
    });
  }
}
