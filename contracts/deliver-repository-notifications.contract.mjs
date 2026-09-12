export default {
  pre: (input) => Array.isArray(input?.targets) || "targets is an array",
  post: (result) => Array.isArray(result)
    && result.every((entry) => typeof entry?.target === "string" && typeof entry?.sent === "boolean")
    || "delivery results retain each supported target and its boolean delivery state",
};
