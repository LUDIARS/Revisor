/** @implements RV-PRAESIDIUM-02 — negative examples exercise the same guard used at ingress. */
import { compileRouteGuard } from "./input-guard.mjs";

export function checkWebContracts(entries = []) {
  if (!Array.isArray(entries) || entries.length > 256) throw new Error("invalid web contracts");
  const names = new Set();
  return entries.map(entry => {
    if (!entry || Object.keys(entry).some(key => !["name", "contract", "cases"].includes(key))
        || typeof entry.name !== "string" || !/^[a-zA-Z0-9._-]{1,80}$/.test(entry.name) || names.has(entry.name)
        || !Array.isArray(entry.cases) || entry.cases.length > 256
        || !entry.cases.some(item => item.accept === true) || !entry.cases.some(item => item.accept === false)) throw new Error("positive and negative cases required");
    names.add(entry.name);
    const guard = compileRouteGuard(entry.contract);
    const validCases = entry.cases.every(item => {
      if (!item || typeof item.accept !== "boolean" || Object.keys(item).some(key => !["request", "accept"].includes(key))) throw new Error("invalid boundary example");
      return guard(item.request).ok === item.accept;
    });
    // Always challenge parser ambiguity even when a project supplies weak examples.
    const positive = entry.cases.find(item => item.accept === true).request;
    const probes = [
      { ...positive, target: "/%2e%2e/" },
      { ...positive, target: "/%252e%252e/" },
      { ...positive, target: "/%ZZ" },
      { ...positive, target: positive.target.split("?")[0] + "?__proto__=x" },
      { ...positive, bodyText: "x".repeat(entry.contract.maxBodyBytes + 1) },
      { ...positive, bodyText: '{"__proto__":{"admin":true}}', contentType: "application/json" },
    ];
    return { rule: "web.boundary-contract", contract: entry.name,
      status: validCases && probes.every(request => !guard(request).ok) ? "passed" : "failed" };
  });
}
