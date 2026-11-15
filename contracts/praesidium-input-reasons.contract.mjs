const codes = new Set(["source.nul", "source.invalid-utf8", "source.size-limit", "source.file-count-limit"]);

export default {
  post: (result) => {
    if (result.status !== "error" || !Object.hasOwn(result, "reason")) return true;
    return (result.reason === "inspection incomplete: check repository files, limits and praesidium.json"
      && result.findings.length === 0 && result.checks.length === 0
      && (!Object.hasOwn(result, "reasonCode") || codes.has(result.reasonCode))
      && Object.keys(result).every(key => ["tool", "version", "status", "findings", "checks", "reason", "reasonCode", "durationMs"].includes(key)))
      || "incomplete inspection must retain only the fixed reason and allowlisted code";
  },
};
