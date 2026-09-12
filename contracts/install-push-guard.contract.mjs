export default {
  pre: (options) => typeof options?.repoPath === "string" || "push guard requires a repository path",
  post: (result) => typeof result === "string" && result.endsWith("pre-push") || "push guard returns its managed hook path",
};
