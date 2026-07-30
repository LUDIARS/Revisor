import { runNamedCli } from "./process.mjs";

export function reviewerForProvider(provider, fallbackReviewer) {
  if (provider === "codex") return "claude-opus";
  if (provider === "claude") return "codex-sol";
  return fallbackReviewer;
}

// `readOnly` is for callers that only want an answer, never an edit — the review
// plan advisor being the one. It asks a question about the diff and consumes a
// JSON reply, so granting it write access to a worktree whose contents are later
// committed would be privilege it has no use for, guarded only by the prompt.
export async function runReviewer({ reviewer, cwd, prompt, timeoutMs, readOnly = false }) {
  if (reviewer === "claude-opus") {
    return runNamedCli({
      name: "claude",
      args: [
        "--model",
        "opus",
        "--permission-mode",
        readOnly ? "plan" : "acceptEdits",
        "--print",
      ],
      cwd,
      stdin: prompt,
      timeoutMs,
    });
  }
  if (reviewer === "codex-sol") {
    return runNamedCli({
      name: "codex",
      args: [
        "exec",
        "--model",
        "gpt-5.6-sol",
        "--sandbox",
        readOnly ? "read-only" : "workspace-write",
        "-",
      ],
      cwd,
      stdin: prompt,
      timeoutMs,
    });
  }
  throw new Error(`Unsupported reviewer '${reviewer}'.`);
}
