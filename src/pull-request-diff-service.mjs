import { git } from "./workspace.mjs";

const SHA = /^[0-9a-f]{7,64}$/i;
const MAX_CACHED_FILE_LISTINGS = 32;

function assertRevision(value, label) {
  if (typeof value !== "string" || !SHA.test(value)) {
    throw new Error(`Local PR has an invalid ${label} revision.`);
  }
}

function changeKind(status) {
  const kind = status[0];
  if (kind === "A") return "added";
  if (kind === "D") return "deleted";
  if (kind === "R") return "renamed";
  if (kind === "C") return "copied";
  return "modified";
}

export function parseChangedFiles(output) {
  const fields = String(output).split("\0").filter(Boolean);
  const files = [];
  for (let index = 0; index < fields.length;) {
    const status = fields[index++];
    if (!status) break;
    const kind = changeKind(status);
    const previousPath = kind === "renamed" || kind === "copied" ? fields[index++] : null;
    const path = fields[index++];
    if (!path) throw new Error("Git returned an incomplete changed-file record.");
    files.push({ status: kind, path, previousPath });
  }
  return files;
}

/**
 * Reads one submitted local PR's immutable base/head comparison.
 *
 * The local branch may move while another review is queued. This reader always
 * uses the PR's stored SHAs, so the operator sees the same bytes that Revisor
 * is reviewing instead of whatever the branch happens to contain later.
 */
export class PullRequestDiffService {
  constructor({
    getPullRequest,
    getRepository,
    runGit = git,
  }) {
    if (typeof getPullRequest !== "function" || typeof getRepository !== "function") {
      throw new TypeError("Pull-request diff service requires local PR and repository readers.");
    }
    if (typeof runGit !== "function") {
      throw new TypeError("Pull-request diff service requires a Git runner.");
    }
    this.getPullRequest = getPullRequest;
    this.getRepository = getRepository;
    this.runGit = runGit;
    this.fileListings = new Map();
  }

  async files(id) {
    const context = this.#context(id);
    return this.#files(context);
  }

  async fileDiff(id, path) {
    if (typeof path !== "string" || !path) {
      throw new TypeError("A changed file path is required.");
    }
    const context = this.#context(id);
    const listing = await this.#files(context);
    // Exact membership in the Git-generated list is the path authorization
    // boundary before this value is passed to Git after `--` below.
    const file = listing.files.find((entry) => entry.path === path);
    if (!file) throw new Error("Requested path is not part of this local PR.");
    const diff = await this.runGit(context.repository.rootPath, [
      "diff",
      "--no-ext-diff",
      "--no-color",
      "--find-renames",
      "--unified=3",
      context.pullRequest.baseSha,
      context.pullRequest.headSha,
      "--",
      file.path,
    ]);
    return {
      pullRequestId: context.pullRequest.id,
      file,
      diff,
    };
  }

  async #files(context) {
    const key = `${context.pullRequest.id}:${context.pullRequest.baseSha}:${context.pullRequest.headSha}`;
    const cached = this.fileListings.get(key);
    if (cached) return cached;
    const listing = this.#readFiles(context);
    this.fileListings.set(key, listing);
    if (this.fileListings.size > MAX_CACHED_FILE_LISTINGS) {
      this.fileListings.delete(this.fileListings.keys().next().value);
    }
    try {
      return await listing;
    } catch (error) {
      if (this.fileListings.get(key) === listing) this.fileListings.delete(key);
      throw error;
    }
  }

  async #readFiles(context) {
    const output = await this.runGit(context.repository.rootPath, [
      "diff",
      "--no-ext-diff",
      "--name-status",
      "-z",
      "--find-renames",
      context.pullRequest.baseSha,
      context.pullRequest.headSha,
      "--",
    ]);
    return {
      pullRequestId: context.pullRequest.id,
      baseSha: context.pullRequest.baseSha,
      headSha: context.pullRequest.headSha,
      files: parseChangedFiles(output),
    };
  }

  #context(id) {
    const pullRequest = this.getPullRequest(id);
    if (!pullRequest) throw new Error("Local PR was not found.");
    assertRevision(pullRequest.baseSha, "base");
    assertRevision(pullRequest.headSha, "head");
    const repository = this.getRepository(pullRequest.repository);
    if (!repository?.rootPath) throw new Error("Local PR repository is not registered.");
    return { pullRequest, repository };
  }
}
