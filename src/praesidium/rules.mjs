/** @implements RV-PRAESIDIUM-01 — bounded syntactic tripwires, not a full parser. */
// Keep newlines/offsets so a finding never needs to retain source text or secrets.
export function maskCommentsAndLiterals(source) {
  return source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\r\n]*|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|`(?:\\[\s\S]|[^`\\])*`/g,
    (text) => text.replace(/[^\r\n]/g, " "));
}

export function sourceFindings(file, source) {
  const native = /\.(?:c|cc|cpp|cxx|h|hh|hpp|hxx)$/i.test(file);
  const script = /\.(?:js|jsx|mjs|cjs|ts|tsx)$/i.test(file);
  if (!native && !script) return [];
  const code = maskCommentsAndLiterals(source);
  const rules = native ? [
    ["native.unbounded-copy", /\b(?:gets|strcpy|strcat|sprintf|vsprintf|wcscpy|wcscat)\s*\(/g],
  ] : [
    ["web.dynamic-code", /\b(?:eval|Function)\s*\(/g],
    ["web.request-to-html", /\.innerHTML\s*=\s*(?:req|request|ctx|location)\s*[.[]/g],
    ["web.request-to-shell", /\b(?:exec|execSync)\s*\(\s*(?:req|request|ctx)\s*[.[]/g],
  ];
  const findings = [];
  for (const [rule, pattern] of rules) {
    let cursor = 0, line = 1;
    for (const match of code.matchAll(pattern)) {
      // Advance once per character rather than rescanning the prefix for each finding.
      while (cursor < match.index) if (code[cursor++] === "\n") line++;
      findings.push({ rule, file, line, severity: "high" });
      if (findings.length === 200) {
        findings.push({ rule: "inspection.finding-limit", file, line, severity: "high" });
        return findings; // Already failing; never turn truncated output into a pass.
      }
    }
  }
  return findings;
}
