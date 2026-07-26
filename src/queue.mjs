import { randomUUID } from "node:crypto";

export class PrReviewQueue {
  #jobs = new Map();
  #jobsByKey = new Map();
  #submissions = new Map();
  #pending = [];
  #running = 0;

  constructor(run, {
    concurrency = 1,
    maxJobs = 100,
    createId = randomUUID,
    now = () => new Date().toISOString(),
    reporter,
  } = {}) {
    if (typeof run !== "function") throw new TypeError("PR review queue requires a runner.");
    if (
      !reporter
      || typeof reporter.queued !== "function"
      || typeof reporter.running !== "function"
      || typeof reporter.completed !== "function"
      || typeof reporter.failed !== "function"
    ) {
      throw new TypeError("PR review queue requires a lifecycle reporter.");
    }
    if (!Number.isInteger(concurrency) || concurrency < 1) {
      throw new TypeError("PR review queue concurrency must be a positive integer.");
    }
    this.run = run;
    this.reporter = reporter;
    this.concurrency = concurrency;
    this.maxJobs = maxJobs;
    this.createId = createId;
    this.now = now;
  }

  async submit(request) {
    const key = `${request.repository}#${request.number}@${request.headSha}`;
    const submitting = this.#submissions.get(key);
    if (submitting) return submitting;
    const existingId = this.#jobsByKey.get(key);
    const existing = existingId ? this.#jobs.get(existingId) : undefined;
    if (existing) return existing;
    const submission = this.#create(request, key);
    this.#submissions.set(key, submission);
    try {
      return await submission;
    } finally {
      this.#submissions.delete(key);
    }
  }

  async #create(request, key) {
    const timestamp = this.now();
    const job = {
      id: this.createId(),
      key,
      request,
      status: "queued",
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await this.reporter.queued(job);
    this.#jobs.set(job.id, job);
    this.#jobsByKey.set(key, job.id);
    this.#pending.push(job.id);
    this.#trim();
    queueMicrotask(() => this.#drain());
    return job;
  }

  get(id) {
    return this.#jobs.get(id) ?? null;
  }

  list() {
    return [...this.#jobs.values()].sort((left, right) =>
      right.createdAt.localeCompare(left.createdAt));
  }

  state() {
    return {
      queued: this.#pending.length,
      running: this.#running,
      jobs: this.list(),
    };
  }

  #drain() {
    while (this.#running < this.concurrency && this.#pending.length > 0) {
      const id = this.#pending.shift();
      if (!id) return;
      this.#running += 1;
      void this.#execute(id);
    }
  }

  async #execute(id) {
    const job = this.#jobs.get(id);
    if (!job) {
      this.#running -= 1;
      this.#drain();
      return;
    }
    job.status = "running";
    job.updatedAt = this.now();
    try {
      await this.reporter.running(job);
      job.result = await this.run(job.request);
      job.status = "completed";
      job.updatedAt = this.now();
      await this.reporter.completed(job);
    } catch (error) {
      job.status = "failed";
      job.error = error instanceof Error ? error.message : String(error);
      job.updatedAt = this.now();
      try {
        await this.reporter.failed(job);
      } catch (reportError) {
        const message = reportError instanceof Error ? reportError.message : String(reportError);
        job.error = `${job.error}; GitHub check update failed: ${message}`;
      }
    } finally {
      job.updatedAt = this.now();
      this.#running -= 1;
      this.#trim();
      this.#drain();
    }
  }

  #trim() {
    if (this.#jobs.size <= this.maxJobs) return;
    for (const [id, job] of this.#jobs) {
      if (job.status === "queued" || job.status === "running") continue;
      this.#jobs.delete(id);
      this.#jobsByKey.delete(job.key);
      if (this.#jobs.size <= this.maxJobs) break;
    }
  }
}
