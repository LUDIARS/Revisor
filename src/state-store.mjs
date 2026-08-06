import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { resolveConfigPath } from "./config.mjs";
import { RevisorError } from "./errors.mjs";

const STATE_PATH_ENV = "REVISOR_STATE_PATH";
const QA_ELIGIBLE_CHECK_STATUSES = new Set(["queued", "running", "test_ok"]);

function testWorkflowStatus(checkStatus) {
  return checkStatus === "test_ok" ? "Open / Test OK" : "Open / In Review";
}

function emptyState() {
  return {
    version: 2,
    nextPullRequestNumber: 1,
    repositories: [],
    pullRequests: [],
  };
}

// v1 はリポジトリごとの連番だった。 番号は横断利用 (Rv#xxx だけで PR を特定して
// ワークフローを回す) が前提になったので、 全リポジトリ共通の 1 本へ振り直す。
// createdAt 昇順 (同時刻は id で安定化) なので、 同じ v1 状態からは常に同じ番号に
// 落ちる — 読み取りは write を伴わないため、 決定的でないと読むたびに番号が揺れる。
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

export function resolveStatePath(env = process.env) {
  return env[STATE_PATH_ENV]
    ?? join(dirname(resolveConfigPath(env)), "revisor.state.json");
}

function readState(path) {
  if (!existsSync(path)) return emptyState();
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
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
  } catch (error) {
    throw new RevisorError(`Revisor state is unreadable: ${path}`, { cause: error });
  }
}

function writeState(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    renameSync(temporaryPath, path);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}

export class LocalPrStore {
  constructor({
    path = resolveStatePath(),
    now = () => new Date().toISOString(),
    createId = randomUUID,
    onEvent = () => {},
  } = {}) {
    this.path = path;
    this.now = now;
    this.createId = createId;
    this.onEvent = onEvent;
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
    const state = readState(this.path);
    const timestamp = this.now();
    const existing = state.repositories.find((candidate) =>
      candidate.repository.toLowerCase() === repository.repository.toLowerCase());
    if (existing) {
      Object.assign(existing, repository, {
        id: existing.id,
        createdAt: existing.createdAt,
        updatedAt: timestamp,
      });
      writeState(this.path, state);
      return structuredClone(existing);
    }
    const record = {
      id: this.createId(),
      ...repository,
      pushGuard: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    state.repositories.push(record);
    writeState(this.path, state);
    return structuredClone(record);
  }

  getRepository(repository) {
    const record = readState(this.path).repositories.find((candidate) =>
      candidate.repository.toLowerCase() === String(repository).toLowerCase());
    return record ? structuredClone(record) : null;
  }

  findRepositoryByPath(rootPath) {
    const normalized = String(rootPath).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
    const record = readState(this.path).repositories.find((candidate) =>
      candidate.rootPath.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase()
        === normalized);
    return record ? structuredClone(record) : null;
  }

  listRepositories() {
    return structuredClone(readState(this.path).repositories)
      .sort((left, right) => left.repository.localeCompare(right.repository));
  }

  createPullRequest(pullRequest) {
    const state = readState(this.path);
    const timestamp = this.now();
    const number = state.nextPullRequestNumber;
    state.nextPullRequestNumber = number + 1;
    const record = {
      id: this.createId(),
      number,
      ...pullRequest,
      status: "open",
      checkStatus: "queued",
      mergeCommitSha: null,
      mergeError: null,
      releaseTag: null,
      releaseUrl: null,
      publishedAt: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    state.pullRequests.push(record);
    writeState(this.path, state);
    const created = structuredClone(record);
    this.emitPullRequest("pull_request.created", created);
    return created;
  }

  getPullRequest(id) {
    const record = readState(this.path).pullRequests.find((candidate) => candidate.id === id);
    return record ? structuredClone(record) : null;
  }

  findExactPullRequest(repository, headSha) {
    const record = readState(this.path).pullRequests.find((candidate) =>
      candidate.status === "open"
      && candidate.repository.toLowerCase() === repository.toLowerCase()
      && candidate.headSha.toLowerCase() === headSha.toLowerCase());
    return record ? structuredClone(record) : null;
  }

  listPullRequests() {
    return structuredClone(readState(this.path).pullRequests)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  updatePullRequest(id, patch) {
    const state = readState(this.path);
    const record = state.pullRequests.find((candidate) => candidate.id === id);
    if (!record) throw new RevisorError(`Local PR '${id}' was not found.`);
    Object.assign(record, patch, { id: record.id, updatedAt: this.now() });
    writeState(this.path, state);
    const updated = structuredClone(record);
    this.emitPullRequest("pull_request.updated", updated);
    return updated;
  }

  updatePushGuard(repository, pushGuard) {
    const state = readState(this.path);
    const record = state.repositories.find((candidate) =>
      candidate.repository.toLowerCase() === repository.toLowerCase());
    if (!record) throw new RevisorError(`Repository '${repository}' is not registered.`);
    record.pushGuard = pushGuard;
    record.updatedAt = this.now();
    writeState(this.path, state);
    return structuredClone(record);
  }

  testWorkflowProducts() {
    const state = readState(this.path);
    return state.repositories.flatMap((repository) => {
      const latest = state.pullRequests
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
        updatedAt: latest.updatedAt,
      }];
    });
  }
}
