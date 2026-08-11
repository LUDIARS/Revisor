import { JobStore, resolveJobsPath } from "./job-store.mjs";
import { ensureReviewWorker } from "./worker-spawn.mjs";

/** @implements SPEC-DAEMONLESS-PERSISTENT-QUEUE */
function ignoreWorkerError() {}

/**
 * `PrReviewQueue` と同じ投入面を持つが、実行はしない永続キュー。
 *
 * 投入したプロセスは job を記録してワーカーの起動を確かめたら終わってよい。
 * 提出コマンドが審査の完了まで生き続ける必要が無くなり、常駐バックエンドも要らなくなる。
 * `LocalPrService` から見た契約 (`submit` / `get` / `list` / `state`) は変えていない。
 *
 * @implements SPEC-DAEMONLESS-PERSISTENT-QUEUE
 */
export class PersistentPrReviewQueue {
  constructor({
    jobs = new JobStore(),
    reporter,
    startWorker = ensureReviewWorker,
    cwd = process.cwd(),
    env = process.env,
    onWorkerError = ignoreWorkerError,
  } = {}) {
    if (
      !reporter
      || typeof reporter.queued !== "function"
    ) {
      throw new TypeError("The persistent review queue requires a lifecycle reporter.");
    }
    this.jobs = jobs;
    this.reporter = reporter;
    this.startWorker = startWorker;
    this.cwd = cwd;
    this.env = env;
    this.onWorkerError = onWorkerError;
  }

  /** @implements SPEC-DAEMONLESS-PERSISTENT-QUEUE */
  async submit(request, { force = false } = {}) {
    const { job, created } = await this.jobs.enqueue(request, { force });
    // enqueue 後・state の jobId 記録前に投入プロセスが落ちた場合は、既存 queued job の
    // reporter を再実行して state を補修する。running を queued へ巻き戻してはいけない。
    if (created || job.status === "queued") await this.reporter.queued(job);
    await this.#wake();
    return job;
  }

  /** @implements SPEC-REVIEW-FAST-LANE-AUTHORITY */
  async promote(localPrId) {
    const job = await this.jobs.promote(localPrId);
    await this.#wake();
    return job;
  }

  /**
   * ワーカーの起動失敗で投入そのものを失敗させない。 job は記録済みなので、次の投入や
   * `revisor run-worker` の手動実行、`revisor sweep` から必ず拾い直せる。
   *
   * @implements SPEC-DAEMONLESS-PERSISTENT-QUEUE
   */
  async #wake() {
    try {
      await this.startWorker({ jobsPath: this.jobs.path, cwd: this.cwd, env: this.env });
    } catch (error) {
      this.onWorkerError(error instanceof Error ? error : new Error(String(error)));
    }
  }

  /** @implements SPEC-DAEMONLESS-PERSISTENT-QUEUE */
  get(id) {
    return this.jobs.get(id);
  }

  /** @implements SPEC-DAEMONLESS-PERSISTENT-QUEUE */
  list() {
    return this.jobs.list();
  }

  /** @implements SPEC-DAEMONLESS-PERSISTENT-QUEUE */
  state() {
    return this.jobs.state();
  }
}

export { resolveJobsPath };
