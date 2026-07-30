import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { autoMergeDecision, autoMergeRecord } from "./auto-merge.mjs";
import { readSettings } from "./config.mjs";
import { installPushGuard } from "./push-guard.mjs";
import { pendingReviewProjection } from "./local-reporter.mjs";
import { squashMergeLocalPullRequest } from "./local-merge.mjs";
import { decidePullRequest, decidePullRequests } from "./pr-disposition.mjs";
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
    securityScan,
    cliPath = CLI_PATH,
    env = process.env,
    loadSettings = () => readSettings(env),
  }) {
    if (!store || !queue) {
      throw new TypeError("Local PR service requires a state store and review queue.");
    }
    this.store = store;
    this.queue = queue;
    this.installGuard = installGuard;
    this.merge = merge;
    this.securityScan = securityScan;
    this.env = env;
    this.cliPath = cliPath;
    // Read on every decision, not cached: moving the accepted risk threshold has
    // to re-colour and re-sort the dashboard without restarting the service.
    this.loadSettings = loadSettings;
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
    const pullRequest = this.store.getPullRequest(id);
    return pullRequest ? decidePullRequest(pullRequest, this.loadSettings()) : null;
  }

  // Ordered so the pull requests that need a human decision come first. Everything
  // else is a queue that hides the one row a person actually has to look at.
  listPullRequests() {
    return decidePullRequests(this.store.listPullRequests(), this.loadSettings());
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
    const mergeCommitSha = await this.merge({
      repository,
      pullRequest,
      env: this.env,
      ...(this.securityScan ? { scan: this.securityScan } : {}),
    });
    return this.store.updatePullRequest(id, {
      status: "merged",
      checkStatus: "test_ok",
      mergeCommitSha,
      mergedAt: new Date().toISOString(),
    });
  }

  // Called once per completed review. The outcome is always recorded, including a
  // refusal, so the dashboard can say why a PR the human expected to disappear is
  // still waiting.
  async autoMergeIfEligible(id) {
    const pullRequest = this.store.getPullRequest(id);
    if (!pullRequest) return null;
    const settings = this.loadSettings();
    const decision = autoMergeDecision(pullRequest, settings);
    if (!decision.merge) {
      if (!settings.autoMergeEnabled) return pullRequest;
      return this.store.updatePullRequest(id, {
        autoMerge: autoMergeRecord({ merged: false, reason: decision.reason }),
      });
    }
    try {
      await this.mergePullRequest(id);
      return this.store.updatePullRequest(id, {
        autoMerge: autoMergeRecord({ merged: true, reason: decision.reason }),
      });
    } catch (error) {
      return this.store.updatePullRequest(id, {
        autoMerge: autoMergeRecord({
          merged: false,
          reason: `自動マージに失敗しました: ${
            error instanceof Error ? error.message : String(error)
          }`,
        }),
      });
    }
  }
}
