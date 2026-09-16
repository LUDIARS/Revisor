export default {
  pre: (input) => input && typeof input === "object" && typeof input.worktreePath === "string"
    && typeof input.headSha === "string" || "experience evidence requires a worktree and head SHA",
  post: (result) => result && typeof result === "object"
    && (result.status === "recorded" || result.status === "unverified")
    && Number.isInteger(result.count) && result.count >= 0
    || "experience evidence distinguishes recorded evidence from unverified evidence",
};
