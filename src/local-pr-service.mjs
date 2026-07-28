import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { installPushGuard } from "./push-guard.mjs";
import { pendingReviewProjection } from "./local-reporter.mjs";
import { squashMergeLocalPullRequest } from "./local-merge.mjs";
import { inspectLocalPullRequest, git } from "./workspace.mjs";

const CLI_PATH = fileURLToPath(new URL("./cli.mjs", import.meta.url));

function reviewRequest(repository, pullRequest) {
  return {
    localPrId: pullRequest.id,
    repository: repository.repository,
    number: pullRequest.number,
    headSha: pullRequest.headSha,
    headRef: pullRequest.headRef,
    headRepository: repository.repository,
    baseRef: pullRequest.baseRef,
    baseSha: pullRequest.baseSha,
    rootPath: repository.rootPath,
    testCases: repository.testCases,
    reviewMode: "full",
  };
}

export class LocalPrService {
  constructor({
    store,
    queue,
    installGuard = installPushGuard,
    merge = squashMergeLocalPullRequest,
    cliPath = CLI_PATH,
  }) {
    if (!store || !queue) {
      throw new TypeError("Local PR service requires a state store and review queue.");
    }
    this.store = store;
    this.queue = queue;
    this.installGuard = installGuard;
    this.merge = merge;
    this.cliPath = cliPath;
  }

  async registerRepository(registration) {
    await access(registration.rootPath);
    const topLevel = await git(registration.rootPath, ["rev-parse", "--show-toplevel"]);
    if (
      topLevel.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase()
      !== registration.rootPath.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase()
    ) {
      throw new Error("root_path must be the root of a Git working tree.");
    }
    await git(registration.rootPath, [
      "rev-parse",
      "--verify",
      `refs/heads/${registration.baseRef}`,
    ]);
    const hookPath = await this.installGuard({
      repoPath: registration.rootPath,
      cliPath: this.cliPath,
      statePath: this.store.path,
    });
    return this.store.registerRepository({ ...registration, hookPath });
  }

  listRepositories() {
    return this.store.listRepositories();
  }

  async submitPullRequest(submission) {
    const repository = this.store.getRepository(submission.repository);
    if (!repository) {
      throw new Error(`Repository '${submission.repository}' is not registered.`);
    }
    const baseRef = submission.baseRef ?? repository.baseRef;
    if (baseRef !== repository.baseRef) {
      throw new Error(
        `Local PR base_ref must match the registered base '${repository.baseRef}'.`,
      );
    }
    const refs = await inspectLocalPullRequest(
      repository.rootPath,
      submission.headRef,
      baseRef,
    );
    const existing = this.store.findExactPullRequest(
      repository.repository,
      refs.headSha,
    );
    if (existing) return existing;
    const pullRequest = this.store.createPullRequest({
      repository: repository.repository,
      title: submission.title,
      body: submission.body,
      author: submission.author,
      draft: submission.draft === true,
      labels: submission.labels ?? [],
      assignees: submission.assignees ?? [],
      reviewers: submission.reviewers ?? [],
      headRef: submission.headRef,
      baseRef,
      headSha: refs.headSha,
      baseSha: refs.baseSha,
    });
    return this.#enqueue(repository, pullRequest);
  }

  async retryPullRequest(id) {
    const pullRequest = this.store.getPullRequest(id);
    if (!pullRequest) throw new Error(`Local PR '${id}' was not found.`);
    if (pullRequest.status !== "open") {
      throw new Error("Only an open local PR can be reviewed again.");
    }
    const repository = this.store.getRepository(pullRequest.repository);
    if (!repository) {
      throw new Error(`Repository '${pullRequest.repository}' is not registered.`);
    }
    // The branch may have moved since the failed run, so re-resolve both refs.
    const refs = await inspectLocalPullRequest(
      repository.rootPath,
      pullRequest.headRef,
      pullRequest.baseRef,
    );
    return this.#enqueue(
      repository,
      this.store.updatePullRequest(id, {
        ...pendingReviewProjection(),
        headSha: refs.headSha,
        baseSha: refs.baseSha,
        checkStatus: "queued",
        error: null,
      }),
      // The refs may be unchanged, and the queue caches settled jobs by exact
      // head, so an unforced re-review would resolve to the run being retried.
      { force: true },
    );
  }

  async #enqueue(repository, pullRequest, options) {
    try {
      await this.queue.submit(reviewRequest(repository, pullRequest), options);
    } catch (error) {
      this.store.updatePullRequest(pullRequest.id, {
        checkStatus: "failed",
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
    return this.store.getPullRequest(pullRequest.id);
  }

  getPullRequest(id) {
    return this.store.getPullRequest(id);
  }

  listPullRequests() {
    return this.store.listPullRequests();
  }

  testWorkflowProducts() {
    return this.store.testWorkflowProducts();
  }

  async mergePullRequest(id) {
    const pullRequest = this.store.getPullRequest(id);
    if (!pullRequest) throw new Error(`Local PR '${id}' was not found.`);
    const repository = this.store.getRepository(pullRequest.repository);
    if (!repository) {
      throw new Error(`Repository '${pullRequest.repository}' is not registered.`);
    }
    const mergeCommitSha = await this.merge({ repository, pullRequest });
    return this.store.updatePullRequest(id, {
      status: "merged",
      checkStatus: "test_ok",
      mergeCommitSha,
      mergedAt: new Date().toISOString(),
    });
  }
}
