import { randomUUID } from "node:crypto";
import { claudeSessionCapacityUnavailable } from "./claude-capacity.mjs";
import { forcedReviewerFor } from "./forced-review-model.mjs";
import { codexSandboxArgs, runCodexAwareCli } from "./codex-runtime.mjs";

// Persisted reviewer ids identify a provider family for config compatibility.
// The review strategy chooses its concrete economy/strong model and effort;
// keeping that choice explicit prevents every stored Claude id from silently
// becoming Opus again.
/** @implements SPEC-CODEX-SANDBOX-MODE */
export function reviewerInvocation(reviewer, {
  readOnly = false,
  tier = "economy",
  effort = "medium",
  sessionId = null,
  forcedModel = "",
  env = process.env,
  platform = process.platform,
} = {}) {
  // A forced model replaces the tier-derived one but must belong to the
  // reviewer being invoked; the callers resolve the reviewer from the same
  // registry, so a mismatch here is a wiring bug rather than bad config.
  if (forcedModel && forcedReviewerFor(forcedModel) !== reviewer) {
    throw new Error(
      `Forced review model '${forcedModel}' does not belong to reviewer '${reviewer}'.`,
    );
  }
  if (reviewer === "claude-opus") {
    return {
      name: "claude",
      args: [
        "--model",
        forcedModel || (tier === "strong" ? "opus" : "sonnet"),
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
        forcedModel || (tier === "strong" ? "gpt-5.6-sol" : "gpt-5.6-terra"),
        "-c",
        `model_reasoning_effort=${effort}`,
        ...codexSandboxArgs(readOnly, env, platform),
        "-",
      ],
    };
  }
  throw new Error(`Unsupported reviewer '${reviewer}'.`);
}

// 反対モデルレビュー (作成者と別系列のモデルへ審査させる) は既定で行う
// (defaults().oppositeModelReviewEnabled)。Codex の推論コストを抑える目的で
// 一時的に既定を無効にしたが、Claude 主体の実装を Claude 自身が審査する形に
// なるため既定を有効へ戻した。コストを寄せたい運用だけ設定で無効にする。
// 設定の読み取りと解釈は config 側の責務なので、ここは解釈済みの真偽値だけを
// 受け取り、選択規則そのものに徹する。引数の既定が false なのは
// 「オプションを渡さない呼び出しは provider を見ない」という関数単体の取り決めで、
// 製品の既定ではない。運用の既定は必ず settings 経由で渡すこと。
/**
 * 反対モデルレビューが有効なときだけ作成者の provider から相手系列を選ぶ。
 *
 * @implements SPEC-OPPOSITE-MODEL-REVIEW
 */
export function reviewerForProvider(provider, fallbackReviewer, {
  oppositeModelReviewEnabled = false,
} = {}) {
  if (!oppositeModelReviewEnabled) return fallbackReviewer;
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
  // 呼び出し側が明示的に渡す。既定を「設定ファイルを読む」にすると、
  // レビューを呼ぶだけのテストがマシンの設定に左右される。注入点は
  // review-work.mjs の REVIEW ステージ 1 箇所に集約する。
  forcedModel = "",
  forcedEffort = "",
}, {
  runCli = runCodexAwareCli,
  sessionIdFactory = randomUUID,
  detectClaudeCapacity = claudeSessionCapacityUnavailable,
} = {}) {
  // Every review path — judge, investigator, test autofix, narrative and the
  // plan advisor — funnels into this function, so resolving the override here
  // is what makes "forced" mean forced. Doing it at the selection sites would
  // leave whichever caller was missed quietly running the old model.
  const activeReviewer = forcedReviewerFor(forcedModel) ?? reviewer;
  const sessionId = activeReviewer === "claude-opus" ? sessionIdFactory() : null;
  const invocation = reviewerInvocation(activeReviewer, {
    readOnly,
    tier,
    effort: forcedEffort || effort,
    sessionId,
    forcedModel,
  });
  const result = await runCli({
    ...invocation,
    cwd,
    stdin: prompt,
    timeoutMs,
  });
  if (result.ok || activeReviewer !== "claude-opus") return result;
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
