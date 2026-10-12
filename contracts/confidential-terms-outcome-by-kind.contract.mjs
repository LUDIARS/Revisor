const KINDS = /\[種類: ([^\]]*)\]/;

export default {
  pre: (input) => (input && typeof input === "object") || "outcome input is required",
  // Messages carry counts, locations and kind names only, and a kind breakdown
  // names only the fixed kind vocabulary.
  post: (result) => {
    if (!result || !("advisory" in result) || !("reason" in result)) return "outcome has advisory and reason";
    for (const message of [result.advisory, result.reason]) {
      if (message === null) continue;
      if (typeof message !== "string") return "outcome messages are strings or null";
      const kinds = KINDS.exec(message)?.[1];
      if (kinds && !kinds.split(", ").every((part) => /^(語|private-ip|local-path|machine-name|site-name) \d+$/.test(part))) {
        return "kind breakdown uses the fixed kind vocabulary";
      }
    }
    return true;
  },
};
