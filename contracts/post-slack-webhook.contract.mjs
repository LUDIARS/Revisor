export default {
  pre: (input) => typeof input?.url === "string" && typeof input?.text === "string"
    || "Slack request has url and text",
  post: (result) => typeof result === "boolean" || "delivery result is boolean",
};
