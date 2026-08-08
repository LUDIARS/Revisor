import { PrReviewWorkerPool } from "./worker-pool.mjs";
import { REVIEW_WORK_STAGES } from "./review-work.mjs";

const STAGE_QUEUES = Object.freeze([
  {
    id: "anatomia",
    label: "Anatomia",
    stages: new Set([REVIEW_WORK_STAGES.ANALYZE, REVIEW_WORK_STAGES.INITIAL_ANALYZE]),
  },
  {
    id: "tests",
    label: "登録テスト",
    stages: new Set([REVIEW_WORK_STAGES.TEST]),
  },
  {
    id: "review",
    label: "モデルレビュー",
    stages: new Set([REVIEW_WORK_STAGES.REVIEW]),
  },
  {
    id: "security",
    label: "セキュリティ診断",
    stages: new Set([REVIEW_WORK_STAGES.SECURITY]),
  },
]);

function queueForStage(stage) {
  return STAGE_QUEUES.find((queue) => queue.stages.has(stage)) ?? null;
}

/**
 * Own independent worker pools for mutually blocking review concerns.
 *
 * A long model call cannot consume the worker reserved for registered tests or
 * Anatomia. `size` is intentionally applied per queue: it represents the
 * configured parallel capacity for each review concern, not one shared global
 * pool that can again be monopolized by a slow concern.
 */
export class ReviewStageWorkers {
  constructor({
    size,
    cwd,
    env = process.env,
    createPool = (options) => new PrReviewWorkerPool(options),
    onStateChange = () => {},
  }) {
    if (typeof onStateChange !== "function") {
      throw new TypeError("Review-stage worker state listener must be a function.");
    }
    this.onStateChange = onStateChange;
    this.pools = new Map(STAGE_QUEUES.map((definition) => [
      definition.id,
      createPool({
        size,
        cwd,
        env,
        onStateChange: () => this.#notifyState(),
      }),
    ]));
  }

  run(work, { priority = 1 } = {}) {
    const queue = queueForStage(work?.stage);
    if (!queue) return Promise.reject(new Error(`Unsupported review work stage '${work?.stage}'.`));
    const pool = this.pools.get(queue.id);
    return pool.run(work, { priority });
  }

  state() {
    return {
      queues: STAGE_QUEUES.map((definition) => ({
        id: definition.id,
        label: definition.label,
        ...this.pools.get(definition.id).state(),
      })),
    };
  }

  async close() {
    await Promise.all([...this.pools.values()].map((pool) => pool.close()));
  }

  #notifyState() {
    try {
      this.onStateChange(this.state());
    } catch {
      // UI invalidation must not change review scheduling or worker lifetime.
    }
  }
}
