// @spec SPEC-RISK-REASSESSMENT: 高スコアPRの再審査と通知
import { effectiveMergeRisk } from "./merge-risk.mjs";
import { pullRequestLifecycleMessage } from "./pr-lifecycle-notice.mjs";

/** @implements SPEC-RISK-REASSESSMENT */
export function riskNoticeText(event, pr) {
  const score = effectiveMergeRisk(pr)?.score;
  const label = event === "merged" ? "60以上のスコアでマージしました" : "自動修正・再審査で解決しないため人間の確認が必要です";
  const report = event === "merged" ? pr : { ...pr, reasons: [
    ...(pr.reasons ?? []),
    ...(pr.mergeRisk?.factors ?? []).slice(0, 3).map((factor) => String(factor.detail ?? factor.code ?? "")),
    ...(pr.riskReassessment?.failure ? [pr.riskReassessment.failure] : []),
  ] };
  // The existing formatter removes injected mentions and secrets from PR text.
  return [label, "マージリスク: " + (Number.isFinite(score) ? score : "未確認"),
    pullRequestLifecycleMessage(event === "merged" ? "merged" : "review_failed", report),
    "Rv local PR: " + String(pr.number),
    "対象head: " + String(pr.reviewedHeadSha ?? pr.headSha ?? "未確認").replace(/[^a-fA-F0-9]/g, "").slice(0, 40),
  ].join("\n");
}

/** @implements SPEC-RISK-REASSESSMENT */
export async function notifyRiskSystem({ baseUrl, event, pullRequest, transport = fetch }) {
  if (!baseUrl) return "unavailable";
  try {
    const response = await transport(baseUrl.replace(/\/$/, "") + "/v1/chat", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ channel: "system", session_id: null, author_label: "Revisor",
        metadata: { source: "revisor-risk-notice", local_pr_id: pullRequest.id },
        text: riskNoticeText(event, pullRequest).slice(0, 2000), mention_admin: true }),
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return "rejected";
    const result = await response.json();
    // Older Cc accepts unknown fields. Do not claim a mention without its acknowledgement.
    return result.mention_admin_resolved === true ? "accepted" : "mention_unconfirmed";
  } catch { return "unknown"; /* HTTP timeout does not prove that the message was not accepted. */ }
}
