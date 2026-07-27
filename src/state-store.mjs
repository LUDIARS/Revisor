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

function emptyState() {
  return {
    version: 1,
    repositories: [],
    pullRequests: [],
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
      || value.version !== 1
      || !Array.isArray(value.repositories)
      || !Array.isArray(value.pullRequests)
    ) {
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
  } = {}) {
    this.path = path;
    this.now = now;
    this.createId = createId;
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
    const number = state.pullRequests
      .filter((candidate) =>
        candidate.repository.toLowerCase() === pullRequest.repository.toLowerCase())
      .reduce((maximum, candidate) => Math.max(maximum, candidate.number), 0) + 1;
    const record = {
      id: this.createId(),
      number,
      ...pullRequest,
      status: "open",
      checkStatus: "queued",
      mergeCommitSha: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    state.pullRequests.push(record);
    writeState(this.path, state);
    return structuredClone(record);
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
    return structuredClone(record);
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
          && pullRequest.draft !== true
          && pullRequest.checkStatus === "test_ok")
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
      return latest
        ? [{
            repository: repository.repository,
            pullRequestId: latest.id,
            number: latest.number,
            title: latest.title,
            status: "Open / Test OK",
            reviewedHeadSha: latest.reviewedHeadSha,
            updatedAt: latest.updatedAt,
          }]
        : [];
    });
  }
}
