import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { JobStore } from "../../src/job-store.mjs";
import { drainReviewJobs } from "../../src/review-job-scheduler.mjs";

/**
 * 審査を実行するワーカーのテスト用実行体。
 *
 * production の投入面は `PersistentPrReviewQueue`、実行面は `runReviewWorker` に分かれて
 * おり、両者は別プロセスで動く。テストは 1 プロセスで「投入したら審査が回る」を観測したい
 * ので、その 2 つを `JobStore` の周りで束ね直したものがこの harness である。
 *
 * 投入の admit 条件 (同一ヘッドの重複投入・force 再投入・settled job の扱い) は `JobStore`
 * 自身が持ち、実行順と同時実行数は `drainReviewJobs` が持つ。harness は独自の判断を持たない
 * — ここに条件を足すと、production と違う意味論のキューがテストの中に生まれてしまう。
 */
class TestReviewQueue {
  #draining = null;
  #wakePending = false;
  #failure = null;

  constructor({ jobs, reporter, run, concurrency }) {
    this.jobs = jobs;
    this.reporter = reporter;
    this.run = run;
    this.concurrency = concurrency;
  }

  /** `PersistentPrReviewQueue.submit` と同じ投入面。 */
  async submit(request, { force = false } = {}) {
    const { job, created } = await this.jobs.enqueue(request, { force });
    if (created || job.status === "queued") await this.reporter.queued(job);
    this.#wake();
    return job;
  }

  async promote(localPrId) {
    const job = await this.jobs.promote(localPrId);
    this.#wake();
    return job;
  }

  get(id) {
    return this.jobs.get(id);
  }

  list() {
    return this.jobs.list();
  }

  state() {
    return this.jobs.state();
  }

  /**
   * 走っている審査が無くなるまで待つ。 fixture の後始末で使う。
   *
   * drain 自体が落ちていたらここで投げ直す。 `submit` は drain を待たない (production の
   * 投入面と同じ) ので、握り潰すと scheduler の故障が unhandled rejection になって
   * 本来の assert 失敗を覆い隠してしまう。
   */
  async idle() {
    while (this.#draining) await this.#draining;
    if (this.#failure) {
      const failure = this.#failure;
      this.#failure = null;
      throw failure;
    }
  }

  #wake() {
    if (this.#draining) {
      this.#wakePending = true;
      return;
    }
    // drain の失敗はここで受け止めて `idle()` まで持ち越す。 `#draining` を
    // rejected のまま放置すると、待ち手が付く前に unhandled rejection になる。
    this.#draining = this.#drain()
      .catch((error) => { this.#failure ??= error; })
      .finally(() => { this.#draining = null; });
  }

  async #drain() {
    do {
      this.#wakePending = false;
      await drainReviewJobs({
        jobs: this.jobs,
        concurrency: this.concurrency,
        reservation: 0,
        run: (job) => this.#runOne(job),
        queueCheckIntervalMs: 5,
      });
    } while (this.#wakePending);
  }

  // `worker-command.mjs` の `runOne` と同じ終局手順。 job の終局を先に記録してから
  // reporter へ渡すので、通知側の失敗が job の状態を巻き戻すことはない。
  async #runOne(job) {
    try {
      await this.reporter.running(job);
      const result = await this.run(job.request);
      await this.jobs.settle(job.id, { status: "completed" });
      await this.reporter.completed({ ...job, result });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.jobs.settle(job.id, { status: "failed", error: message });
      try {
        await this.reporter.failed({ ...job, error: message });
      } catch {
        // 通知は best-effort。 job の終局は記録済み。
      }
    }
  }
}

/**
 * 一時ディレクトリ上の `JobStore` と、それを回す実行体を組み立てる。
 *
 * @param {object} options
 * @param {string} options.directory 一時ディレクトリ (キューの database を置く)
 * @param {object} options.reporter `LocalPrReporter` などのライフサイクル reporter
 * @param {(request: object) => Promise<object>} options.run 1 件の審査
 * @param {number} [options.concurrency] 同時実行数 (fast lane は予約しない)
 */
export function createReviewQueueHarness({ directory, reporter, run, concurrency = 1 }) {
  const jobs = new JobStore({
    path: join(directory, "revisor.jobs.db"),
    legacyPath: join(directory, "revisor.jobs.json"),
    createId: randomUUID,
  });
  return new TestReviewQueue({ jobs, reporter, run, concurrency });
}
