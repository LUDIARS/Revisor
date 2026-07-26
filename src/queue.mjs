import { randomUUID } from "node:crypto";

export class PrReviewQueue {
  #jobs = new Map();
  #jobsByKey = new Map();
  #pending = [];
  #running = 0;

  constructor(run, {
    concurrency = 1,
    maxJobs = 100,
    createId = randomUUID,
    now = () => new Date().toISOString(),
  } = {}) {
    if (typeof run !== "function") throw new TypeError("PR review queue requires a runner.");
    if (!Number.isInteger(concurrency) || concurrency < 1) {
      throw new TypeError("PR review queue concurrency must be a positive integer.");
    }
    this.run = run;
    this.concurrency = concurrency;
    this.maxJobs = maxJobs;
    this.createId = createId;
    this.now = now;
  }

  submit(request) {
    const key = `${request.repository}#${request.number}@${request.headSha}`;
    const existingId = this.#jobsByKey.get(key);
    const existing = existingId ? this.#jobs.get(existingId) : undefined;
    if (existing) return existing;
    const timestamp = this.now();
    const job = {
      id: this.createId(),
      key,
      request,
      status: "queued",
      createdAt: timestamp,
      updatedAt: timestamp,
    };
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
      job.result = await this.run(job.request);
      job.status = "completed";
    } catch (error) {
      job.status = "failed";
      job.error = error instanceof Error ? error.message : String(error);
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
