export default {
  pre: (line) => typeof line === "string" || "line must be a string",
  // A detector answers only whether it matched; it never hands the value back.
  post: (result) => typeof result === "boolean" || "private-ip detector returns a boolean",
};
