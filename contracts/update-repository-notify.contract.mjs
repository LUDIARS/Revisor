export default {
  pre: (repository, notify) => typeof repository === "string" && (notify === null || typeof notify === "object") || "notification update requires repository and notify object",
  post: (result) => result === null || typeof result?.repository === "string" || "notification update returns repository or null",
};
