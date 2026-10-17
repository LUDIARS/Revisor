const STATUSES = new Set(["fetched", "cached", "stale", "unavailable"]);

export default {
  pre: (options) => (options == null || typeof options === "object")
    || "Elegantia anti-pattern fetch takes an optional options object",
  post: (result) => (
    STATUSES.has(result?.status)
    && Array.isArray(result.items)
    && result.items.every((item) => typeof item?.id === "string" && /^AP/.test(item.id)
      && typeof item.title === "string" && Array.isArray(item.detect) && typeof item.fix === "string")
    && ((result.status === "stale" || result.status === "unavailable")
      ? typeof result.reason === "string" && result.reason.length > 0
      : result.reason === null)
    && (result.status !== "unavailable" || result.items.length === 0)
  ) || "Elegantia anti-pattern fetch never throws and states the reason of every failure",
};
