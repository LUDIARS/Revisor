import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

function record(message, context) {
  try {
    const directory = process.env.VESTIGIUM_LOGS_DIR ?? join(process.cwd(), ".contracts-logs");
    mkdirSync(directory, { recursive: true });
    appendFileSync(join(directory, "contracts.jsonl"), `${JSON.stringify({
      time: new Date().toISOString(), msg: message, ctx: context,
    })}\n`, "utf8");
  } catch {
    // Observability must not change the wrapped operation.
  }
}

function outcome(value) {
  return value === true || value === undefined ? null : typeof value === "string" ? value : "predicate failed";
}

// Local compatibility runtime for Augur contract instrumentation. It preserves
// the wrapped function's result and records no payload values, so the optional
// observation layer cannot expose webhook URLs or release-note input.
export function contract(fn, { pre, post, contractId, id, where }) {
  return function contracted(...args) {
    const context = { contract: contractId, id, where, observed_at: new Date().toISOString() };
    try {
      const preReason = outcome(pre?.(...args));
      if (preReason) record("contract violated", { ...context, phase: "pre", reason: preReason });
      const observe = (result) => {
        const postReason = outcome(post?.(result, ...args));
        if (postReason) record("contract violated", { ...context, phase: "post", reason: postReason });
        else if (!preReason) record("contract observed", { ...context, phase: "ok" });
        return result;
      };
      const result = fn.apply(this, args);
      if (result && typeof result.then === "function") return result.then(observe);
      return observe(result);
    } catch (error) {
      record("contract predicate threw", { ...context, phase: "predicate", reason: "wrapped operation threw" });
      throw error;
    }
  };
}
