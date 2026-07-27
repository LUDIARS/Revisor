import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

const WORKER_ENTRY = fileURLToPath(new URL("./worker-entry.mjs", import.meta.url));

export class PrReviewWorkerPool {
  #workers = new Set();
  #idle = [];
  #waiting = [];
  #active = new Map();
  #closing = false;

  constructor({
    size,
    cwd,
    env = process.env,
    createId = randomUUID,
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
    this.createId = createId;
    this.forkWorker = forkWorker;
    for (let index = 0; index < size; index += 1) this.#spawn();
  }

  run(request) {
    if (this.#closing) return Promise.reject(new Error("PR review worker pool is closing."));
    return new Promise((resolve, reject) => {
      this.#waiting.push({
        id: this.createId(),
        request,
        resolve,
        reject,
      });
      this.#dispatch();
    });
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
  }

  #spawn() {
    if (this.#closing) return;
    const worker = this.forkWorker();
    this.#workers.add(worker);
    this.#idle.push(worker);
    worker.on("message", (message) => this.#handleMessage(worker, message));
    worker.once("error", (error) => this.#handleExit(worker, error));
    worker.once("exit", (code, signal) => {
      this.#handleExit(
        worker,
        new Error(`PR review worker exited (${signal ?? code ?? "unknown"}).`),
      );
    });
    this.#dispatch();
  }

  #handleMessage(worker, message) {
    if (!message || (message.type !== "result" && message.type !== "error")) return;
    const task = this.#active.get(message.id);
    if (!task || task.worker !== worker) return;
    this.#active.delete(message.id);
    this.#idle.push(worker);
    if (message.type === "result") task.resolve(message.result);
    else task.reject(new Error(message.error || "PR review worker failed."));
    this.#dispatch();
  }

  #handleExit(worker, error) {
    if (!this.#workers.delete(worker)) return;
    this.#idle = this.#idle.filter((candidate) => candidate !== worker);
    for (const [id, task] of this.#active) {
      if (task.worker !== worker) continue;
      this.#active.delete(id);
      task.reject(error);
      break;
    }
    if (!this.#closing) this.#spawn();
  }

  #dispatch() {
    while (!this.#closing && this.#idle.length > 0 && this.#waiting.length > 0) {
      const worker = this.#idle.shift();
      const task = this.#waiting.shift();
      task.worker = worker;
      this.#active.set(task.id, task);
      worker.send(
        { type: "run", id: task.id, request: task.request },
        (error) => {
          if (!error) return;
          const active = this.#active.get(task.id);
          if (active !== task) return;
          this.#active.delete(task.id);
          this.#idle.push(worker);
          task.reject(error);
          this.#dispatch();
        },
      );
    }
  }
}
