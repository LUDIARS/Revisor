const MAX_FINDINGS = 100;

const CONTENT_RULES = [
  {
    rule: "private-key",
    pattern: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/,
  },
  {
    rule: "github-token",
    pattern: /\b(?:github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{20,})\b/,
  },
  {
    rule: "aws-access-key",
    pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/,
  },
  {
    rule: "openai-api-key",
    pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/,
  },
  {
    rule: "slack-token",
    pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,
  },
  {
    rule: "discord-webhook",
    pattern: /https:\/\/(?:discord(?:app)?\.com)\/api\/webhooks\/\d+\/[A-Za-z0-9._-]{10,}/,
  },
];

const CREDENTIAL_ASSIGNMENT =
  /\b(?:api[_-]?key|secret|token|password|passwd|client[_-]?secret)\b\s*[:=]\s*["'`]([^"'`]{16,})["'`]/i;
const PLACEHOLDER =
  /(?:example|dummy|placeholder|change-?me|redacted|mock|process\.env|secrets\.|\$\{|<[^>]+>|your[_-])/i;
const SENSITIVE_PATH =
  /(?:^|\/)(?:\.env(?:\.[^/]+)?|id_(?:rsa|dsa|ecdsa|ed25519)|credentials\.json|service-account[^/]*\.json|secrets?\.(?:json|ya?ml|toml)|[^/]+\.(?:key|p12|pfx|jks|keystore))$/i;
const SAFE_ENV_TEMPLATE = /(?:^|\/)\.env\.(?:example|sample|template)$/i;

function diffPath(raw) {
  if (raw === "/dev/null") return null;
  let value = raw;
  if (value.startsWith("\"")) {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  return value.startsWith("b/") ? value.slice(2) : value;
}

function isEmbeddedCredential(line) {
  const match = CREDENTIAL_ASSIGNMENT.exec(line);
  if (!match || PLACEHOLDER.test(match[1])) return false;
  const value = match[1];
  const classes = [
    /[a-z]/.test(value),
    /[A-Z]/.test(value),
    /\d/.test(value),
    /[^A-Za-z0-9]/.test(value),
  ].filter(Boolean).length;
  return value.length >= 24 || classes >= 3;
}

function rulesForLine(line) {
  const rules = CONTENT_RULES
    .filter(({ pattern }) => pattern.test(line))
    .map(({ rule }) => rule);
  if (rules.length === 0 && isEmbeddedCredential(line)) {
    rules.push("embedded-credential");
  }
  return rules;
}

function safeFindingPath(path) {
  return rulesForLine(path).length > 0 ? "[redacted-path]" : path;
}

// Text that Revisor stores verbatim — failed test output, for one — has to obey the
// same boundary as the findings above: locations and rule names are persisted, the
// matched value never is. Redaction is per line rather than per match because a line
// that already proved to carry a secret may carry the rest of it around the match.
export function redactSecretLines(text) {
  if (typeof text !== "string") return "";
  return text
    .split("\n")
    .map((line) => {
      const rules = rulesForLine(line);
      return rules.length === 0 ? line : `[redacted: ${rules.join(", ")}]`;
    })
    .join("\n");
}

export function scanAddedDiffForLeaks(unifiedDiff) {
  if (typeof unifiedDiff !== "string") {
    throw new TypeError("Leakage scan requires a unified diff string.");
  }
  const findings = [];
  const findingKeys = new Set();
  const sensitivePaths = new Set();
  let path = null;
  let addedLine = 0;
  let scannedAddedLines = 0;
  let totalFindings = 0;

  const addFinding = (rule, findingPath, line) => {
    const key = `${rule}\0${findingPath}\0${line}`;
    if (findingKeys.has(key)) return;
    findingKeys.add(key);
    totalFindings += 1;
    if (findings.length < MAX_FINDINGS) {
      findings.push({ rule, path: safeFindingPath(findingPath), line });
    }
  };

  for (const diffLine of unifiedDiff.split(/\r?\n/)) {
    if (diffLine.startsWith("+++ ")) {
      path = diffPath(diffLine.slice(4));
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(diffLine);
    if (hunk) {
      addedLine = Number(hunk[1]);
      continue;
    }
    if (!path || diffLine.startsWith("\\ No newline")) continue;
    if (diffLine.startsWith("+")) {
      scannedAddedLines += 1;
      if (
        SENSITIVE_PATH.test(path)
        && !SAFE_ENV_TEMPLATE.test(path)
        && !sensitivePaths.has(path)
      ) {
        sensitivePaths.add(path);
        addFinding("sensitive-file", path, addedLine);
      }
      const content = diffLine.slice(1);
      for (const rule of rulesForLine(content)) addFinding(rule, path, addedLine);
      addedLine += 1;
      continue;
    }
    if (!diffLine.startsWith("-")) addedLine += 1;
  }

  return {
    scannedAddedLines,
    findings,
    truncated: totalFindings > findings.length,
    totalFindings,
  };
}
