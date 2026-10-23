const OUTCOMES = new Set(["advanced", "already", "source_behind", "diverged"]);

export default {
  pre: (input) => Boolean(input?.mergeRoot && input?.sourceRoot && input?.baseRef)
    || "merge root, source root, and base ref are required",
  post: (result) => Boolean(result && OUTCOMES.has(result.status)
    && typeof result.mergeBaseSha === "string"
    && typeof result.sourceBaseSha === "string"
    && (result.status !== "advanced" || result.mergeBaseSha === result.sourceBaseSha))
    || "catch-up returns a known outcome and advances only to the source base",
};
