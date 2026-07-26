import { runNamedCli } from "./process.mjs";

export function reviewerForProvider(provider, fallbackReviewer) {
  if (provider === "codex") return "claude-opus";
  if (provider === "claude") return "codex-sol";
  return fallbackReviewer;
}

export async function runReviewer({ reviewer, cwd, prompt, timeoutMs }) {
  if (reviewer === "claude-opus") {
    return runNamedCli({
      name: "claude",
      args: ["--model", "opus", "--permission-mode", "acceptEdits", "--print"],
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
        "workspace-write",
        "-",
      ],
      cwd,
      stdin: prompt,
      timeoutMs,
    });
  }
  throw new Error(`Unsupported reviewer '${reviewer}'.`);
}
