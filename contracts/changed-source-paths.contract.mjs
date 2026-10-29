export default {
  pre: (root, base) => (typeof root === "string" && root.length > 0
    && typeof base === "string" && base.length > 0)
    || "repository root and base ref are required",
  post: (result) => (Array.isArray(result)
    && result.every(path => typeof path === "string" && path.length > 0)
    && new Set(result).size === result.length)
    || "changed paths are a duplicate-free list of repository-relative paths",
};
