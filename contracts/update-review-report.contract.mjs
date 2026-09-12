export default {
  pre: (report, entry) => (
    (report === null || typeof report === "object")
    && entry && typeof entry === "object"
    && typeof entry.id === "string"
  ) || "review report update requires an optional report and a stable entry id",
  post: (result) => (
    result?.version === 1
    && typeof result.attemptId === "string"
    && typeof result.headSha === "string"
    && Array.isArray(result.entries)
  ) || "review report update returns a versioned attempt report",
};
