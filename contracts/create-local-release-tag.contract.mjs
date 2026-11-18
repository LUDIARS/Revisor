export default {
  pre: (request) => (typeof request?.tag === "string"
    && typeof request?.mergeCommitSha === "string"
    && request.mergeCommitSha.length > 0)
    || "release tag request needs a tag and a target commit",
  post: (result) => (result !== null
    && typeof result === "object"
    && typeof result.created === "boolean"
    && Object.keys(result).length === 1)
    || "createLocalReleaseTag must report only whether it created the tag",
};
