import { scanAddedDiffForLeaks, scanTextForLeaks } from "./leakage.mjs";
import { assertSafeSha, git } from "./workspace.mjs";
import {
  confidentialTermsPath,
  isConfidentialKindEnforced,
  loadConfidentialPolicy,
  scanTextForConfidentialTerms,
} from "./confidential-terms.mjs";
import { enabledBuiltinDetectors } from "./host-identifiers.mjs";

const ZERO_SHA = /^0+$/;
const FULL_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

// New remote refs can expose their complete ancestry, including the local base.
// Findings and diagnostics never retain message text.
export function scanCommitMessageLog(stdout, { confidentialPolicy = null, repository = null } = {}) {
  const findings = [];
  const terms = (confidentialPolicy?.terms ?? [])
    .filter(term => !term.category || confidentialPolicy.categories?.[term.category] !== "off");
  const detectors = confidentialPolicy ? enabledBuiltinDetectors(confidentialPolicy.categories) : [];
  for (const record of stdout.split("\0")) {
    if (!record.trim()) continue;
    const newline = record.indexOf("\n");
    const sha = (newline < 0 ? record : record.slice(0, newline)).trim();
    if (!FULL_SHA.test(sha)) throw new Error("Invalid outgoing commit message record.");
    const message = newline < 0 ? "" : record.slice(newline + 1);
    findings.push(...scanTextForLeaks(message, `commit/${sha}/message`).findings);
    const confidential = scanTextForConfidentialTerms(
      message, terms, `commit/${sha}/message`, detectors,
      { workspaceRoots: confidentialPolicy?.workspaceRoots ?? [] },
    ).filter(finding => isConfidentialKindEnforced(confidentialPolicy, repository, finding.kind));
    for (const finding of confidential) {
      findings.push({ rule: "confidential-term", ...finding });
    }
  }
  return findings;
}

export async function scanOutgoingHistory(repoPath, record, { repository = null, env = process.env } = {}) {
  assertSafeSha(record.localSha, "Push source");
  assertSafeSha(record.remoteSha, "Push destination");
  // Preserve the existing optional dictionary contract; configured read failures block publication.
  const confidentialPolicy = loadConfidentialPolicy(confidentialTermsPath(env));
  const range = ZERO_SHA.test(record.remoteSha)
    ? record.localSha : `${record.remoteSha}..${record.localSha}`;
  const patches = await git(repoPath, ["log", "--format=", "--patch", "--no-ext-diff", range, "--"]);
  const messages = await git(repoPath, ["log", "-z", "--format=%H%n%B", range, "--"]);
  const result = scanAddedDiffForLeaks(patches);
  const messageFindings = scanCommitMessageLog(messages, { confidentialPolicy, repository });
  return {
    ...result,
    findings: [...result.findings, ...messageFindings],
    totalFindings: result.totalFindings + messageFindings.length,
  };
}
