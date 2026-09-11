export default {
  pre: (repository, request) => typeof repository?.repository === "string"
    && (request?.kind === "major" || request?.kind === "minor")
    && typeof request.expectedVersion === "string"
    || "manual release requires a repository and canonical major/minor request",
  post: (result) => typeof result?.tag === "string" && /^v\d+\.\d+\.\d+$/.test(result.tag)
    || "manual release result has a canonical tag",
};
