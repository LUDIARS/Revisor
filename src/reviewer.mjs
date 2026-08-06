import { randomUUID } from "node:crypto";
import { claudeSessionCapacityUnavailable } from "./claude-capacity.mjs";
import { runNamedCli } from "./process.mjs";

// Persisted reviewer ids identify a provider family for config compatibility.
// The review strategy chooses its concrete economy/strong model and effort;
// keeping that choice explicit prevents every stored Claude id from silently
// becoming Opus again.
export function reviewerInvocation(reviewer, {
  readOnly = false,
  tier = "economy",
  effort = "medium",
  sessionId = null,
} = {}) {
  if (reviewer === "claude-opus") {
    return {
      name: "claude",
      args: [
        "--model",
        tier === "strong" ? "opus" : "sonnet",
        "--effort",
        effort,
        "--permission-mode",
        readOnly ? "plan" : "acceptEdits",
        ...(sessionId ? ["--session-id", sessionId] : []),
        "--print",
      ],
    };
  }
  if (reviewer === "codex-sol") {
    return {
      name: "codex",
      args: [
        "exec",
        "--model",
        tier === "strong" ? "gpt-5.6-sol" : "gpt-5.6-terra",
        "-c",
        `model_reasoning_effort=${effort}`,
        "--sandbox",
        readOnly ? "read-only" : "workspace-write",
        "-",
      ],
    };
  }
  throw new Error(`Unsupported reviewer '${reviewer}'.`);
}

export function reviewerForProvider(provider, fallbackReviewer) {
  if (provider === "codex") return "claude-opus";
  if (provider === "claude") return "codex-sol";
  return fallbackReviewer;
}

// `readOnly` is for callers that only want an answer, never an edit — the review
// plan advisor being the one. It asks a question about the diff and consumes a
// JSON reply, so granting it write access to a worktree whose contents are later
// committed would be privilege it has no use for, guarded only by the prompt.
export async function runReviewer({
  reviewer,
  cwd,
  prompt,
  timeoutMs,
  readOnly = false,
  tier = "economy",
  effort = "medium",
}, {
  runCli = runNamedCli,
  sessionIdFactory = randomUUID,
  detectClaudeCapacity = claudeSessionCapacityUnavailable,
} = {}) {
  const sessionId = reviewer === "claude-opus" ? sessionIdFactory() : null;
  const invocation = reviewerInvocation(reviewer, {
    readOnly,
    tier,
    effort,
    sessionId,
  });
  const result = await runCli({
    ...invocation,
    cwd,
    stdin: prompt,
    timeoutMs,
  });
  if (result.ok || reviewer !== "claude-opus") return result;
  const unavailable = await detectClaudeCapacity({ cwd, sessionId });
  if (!unavailable) return result;
  return {
    ...result,
    stderr: `${result.stderr ?? ""}\nClaude capacity unavailable: rate_limit (HTTP 429)`.trim(),
  };
}

export function alternateReviewer(reviewer) {
  if (reviewer === "claude-opus") return "codex-sol";
  if (reviewer === "codex-sol") return "claude-opus";
  throw new Error(`Unsupported reviewer '${reviewer}'.`);
}

export function reviewerCapacityUnavailable(result) {
  if (result?.ok) return false;
  const output = `${result?.stdout ?? ""}\n${result?.stderr ?? ""}`;
  return /monthly spend limit|you(?:'ve| have) hit your limit|rate[_ -]?limit|\b429\b|quota|usage limit|credit balance|overloaded|process timed out/i
    .test(output);
}
