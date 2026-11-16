export default {
  post: (result) => (typeof result?.authorization === "string"
    && /^Bearer \S+$/.test(result.authorization)
    && Object.keys(result).length === 1)
    || "workflow authorization must be a single non-empty Bearer header",
};