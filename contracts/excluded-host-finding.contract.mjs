const HOST_KINDS = new Set(["private-ip", "local-path", "machine-name", "site-name"]);

export default {
  pre: (finding) => (finding && typeof finding === "object") || "finding is required",
  // Legacy keywords (no kind) are never excluded; the predicate answers only true/false.
  post: (result, finding) => {
    if (typeof result !== "boolean") return "exclusion returns a boolean";
    if (result && !HOST_KINDS.has(finding?.kind)) return "only host-category findings can be excluded";
    return true;
  },
};
