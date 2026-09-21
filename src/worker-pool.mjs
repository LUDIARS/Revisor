/** @implements SPEC-COMPLETE-DISCORD-REVIEW-REPORT */
import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  fastLaneReservation,
  normalizeReviewLane,
  REVIEW_LANES,
} from "./review-lane.mjs";
import { serviceLog } from "./service-log.mjs";
import { selectAuxiliaryReviewer } from "./auxiliary-model-selection.mjs";

const WORKER_ENTRY = fileURLToPath(new URL("./worker-entry.mjs", import.meta.url));

/** @implements SPEC-REVIEW-FAST-LANE-CAPACITY */
export class PrReviewWorkerPool {
  #workers = new Set();
  #idle = [];
  #waiting = [];
  #active = new Map();
  #closing = false;
  #nextWorkerId = 1;
  #workerIds = new WeakMap();

  constructor({
    size,
    cwd,
    env = process.env,
    createId = randomUUID,
    now = () => new Date().toISOString(),
    onStateChange = () => {},
    fastLaneSlots,
    log = serviceLog,
    forkWorker = () => fork(WORKER_ENTRY, [], {
      cwd,
      env,
      windowsHide: true,
      stdio: ["ignore", "inherit", "inherit", "ipc"],
    }),
  }) {
    if (!Number.isInteger(size) || size < 1) {
      throw new TypeError("PR review worker count must be a positive integer.");
    }
    this.size = size;
    this.fastLaneReservation = fastLaneReservation(size, fastLaneSlots);
    this.createId = createId;
    this.now = now;
    this.onStateChange = onStateChange;
    this.log = log;
    this.forkWorker = forkWorker;
    for (let index = 0; index < size; index += 1) this.#spawn();
  }

  run(request, { priority = 1, reviewLane = REVIEW_LANES.STANDARD, onProgress } = {}) {
    if (this.#closing) return Promise.reject(new Error("PR review worker pool is closing."));
    if (!Number.isInteger(priority) || priority < 0) {
      return Promise.reject(new TypeError("PR review task priority must be a non-negative integer."));
    }
    return new Promise((resolve, reject) => {
      const task = {
        id: this.createId(),
        request,
        priority,
        reviewLane: normalizeReviewLane(reviewLane),
        status: "queued",
        createdAt: this.now(),
        startedAt: null,
        workerId: null,
        onProgress,
        progress: Promise.resolve(),
        resolve,
        reject,
      };
      // Stable priority insertion: a ready model review must not wait behind
      // diagnostics that were queued first, while equal-priority tasks retain
      // their arrival order.
      const index = this.#waiting.findIndex((candidate) => {
        if (candidate.reviewLane !== task.reviewLane) {
          return task.reviewLane === REVIEW_LANES.FAST;
        }
        return candidate.priority > priority;
      });
      if (index === -1) this.#waiting.push(task);
      else this.#waiting.splice(index, 0, task);
      this.#notifyState();
      this.#dispatch();
    });
  }

  state() {
    return {
      workers: {
        configured: this.size,
        fastLaneReserved: this.fastLaneReservation,
        idle: this.#idle.length,
        running: this.#active.size,
      },
      queued: this.#waiting.map((task) => this.#taskState(task)),
      running: [...this.#active.values()].map((task) => this.#taskState(task)),
    };
  }

  async close() {
    this.#closing = true;
    const error = new Error("PR review worker pool closed.");
    for (const task of this.#waiting.splice(0)) task.reject(error);
    for (const task of this.#active.values()) task.reject(error);
    this.#active.clear();
    const exits = [...this.#workers].map((worker) => new Promise((resolve) => {
      if (worker.exitCode !== null || worker.signalCode !== null) {
        resolve();
        return;
      }
      worker.once("exit", resolve);
      worker.kill();
    }));
    await Promise.all(exits);
    this.#workers.clear();
    this.#idle.length = 0;
    this.#notifyState();
  }

  #spawn() {
    if (this.#closing) return;
    const worker = this.forkWorker();
    this.#workers.add(worker);
    this.#idle.push(worker);
    this.#workerIds.set(worker, `worker-${this.#nextWorkerId++}`);
    worker.on("message", (message) => this.#handleMessage(worker, message));
    worker.once("error", (error) => this.#handleExit(worker, error));
    this.log("review_worker_spawned", {
      workerId: this.#workerIds.get(worker),
      workerPid: worker.pid ?? null,
      workers: this.#workers.size,
    });
    worker.once("exit", (code, signal) => {
      // ワーカーが黙って死んで再生成される様子は、 これまでどこにも残らなかった。
      // 本体の再起動ループと同じ形の問題がワーカー側にもあるのかを見分けたい。
      this.log("review_worker_exited", {
        workerId: this.#workerIds.get(worker),
        workerPid: worker.pid ?? null,
        code: code ?? null,
        signal: signal ?? null,
        closing: this.#closing,
      }, { level: this.#closing ? "info" : "warn" });
      this.#handleExit(
        worker,
        new Error(`PR review worker exited (${signal ?? code ?? "unknown"}).`),
      );
    });
    this.#dispatch();
  }

  #handleMessage(worker, message) {
    if (!message || !["progress", "result", "error"].includes(message.type)) return;
    const task = this.#active.get(message.id);
    if (!task || task.worker !== worker) return;
    if (message.type === "progress") {
      task.progress = task.progress.then(() => task.onProgress?.(message.progress)).catch((error) => {
        this.log("review_progress_failed", { localPrId: task.request?.localPrId, error: String(error) }, { level: "warn" });
      });
      return;
    }
    this.#active.delete(message.id);
    this.#idle.push(worker);
    task.status = message.type === "result" ? "completed" : "failed";
    task.progress.then(() => {
      if (message.type === "result") task.resolve(message.result);
      else task.reject(new Error(message.error || "PR review worker failed."));
    });
    this.#notifyState();
    this.#dispatch();
  }

  #handleExit(worker, error) {
    if (!this.#workers.delete(worker)) return;
    this.#idle = this.#idle.filter((candidate) => candidate !== worker);
    for (const [id, task] of this.#active) {
      if (task.worker !== worker) continue;
      this.#active.delete(id);
      task.status = "failed";
      task.progress.then(() => task.reject(error));
      break;
    }
    this.#notifyState();
    if (!this.#closing) this.#spawn();
  }

  #dispatch() {
    while (!this.#closing && this.#idle.length > 0 && this.#waiting.length > 0) {
      const standardRunning = [...this.#active.values()].filter((task) =>
        task.reviewLane === REVIEW_LANES.STANDARD).length;
      const fastRunning = this.#active.size - standardRunning;
      const standardCapacity = this.size - this.fastLaneReservation;
      const fastCapacity = this.fastLaneReservation;
      const taskIndex = this.#waiting.findIndex((task) =>
        task.reviewLane === REVIEW_LANES.FAST
          ? fastRunning < fastCapacity
          : standardRunning < standardCapacity);
      if (taskIndex === -1) return;
      const worker = this.#idle.shift();
      const [task] = this.#waiting.splice(taskIndex, 1);
      if (task.request?.stage === "reviewer" && task.request.options?.purpose === "auxiliary") {
        const reviewer = selectAuxiliaryReviewer(
          [...this.#active.values()].map((active) => active.request),
        );
        task.request = { ...task.request, options: {
          ...task.request.options, reviewer, forcedModel: "", forcedEffort: "",
        } };
        this.log("auxiliary_model_selected", {
          reviewer, localPrId: task.request.localPrId ?? null,
          reason: "fewest_active_review_calls",
        });
      }
      task.worker = worker;
      task.workerId = this.#workerIds.get(worker) ?? "worker";
      task.status = "running";
      task.startedAt = this.now();
      this.#active.set(task.id, task);
      this.#notifyState();
      worker.send(
        { type: "run", id: task.id, request: task.request },
        (error) => {
          if (!error) return;
          const active = this.#active.get(task.id);
          if (active !== task) return;
          this.#active.delete(task.id);
          this.#idle.push(worker);
          task.status = "failed";
          task.reject(error);
          this.#notifyState();
          this.#dispatch();
        },
      );
    }
  }

  #taskState(task) {
    const request = task.request && typeof task.request === "object" ? task.request : {};
    return {
      id: task.id,
      stage: typeof request.stage === "string" ? request.stage : "review",
      repository: typeof request.repository === "string" ? request.repository : null,
      number: Number.isInteger(request.number) ? request.number : null,
      localPrId: typeof request.localPrId === "string" ? request.localPrId : null,
      priority: task.priority,
      reviewLane: task.reviewLane,
      status: task.status,
      createdAt: task.createdAt,
      startedAt: task.startedAt,
      workerId: task.workerId,
    };
  }

  #notifyState() {
    try {
      this.onStateChange(this.state());
    } catch {
      // Worker observability is best-effort; a dashboard listener must never
      // interrupt review execution or strand a queued task.
    }
  }
}
