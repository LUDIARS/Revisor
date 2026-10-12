export default {
  pre: (line) => typeof line === "string" || "line must be a string",
  post: (result) => typeof result === "boolean" || "local-path detector returns a boolean",
};
