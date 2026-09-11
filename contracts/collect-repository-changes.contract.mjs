export default {
  pre: (input) => Boolean(input?.repository?.repository && input?.repository?.rootPath)
    || "repository is required",
  post: (result) => Array.isArray(result?.commits) && Array.isArray(result?.pullRequests)
    && typeof result?.markdown === "string" && typeof result?.notice === "string"
    || "changes response has public fields",
};
