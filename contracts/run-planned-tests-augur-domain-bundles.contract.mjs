function validRun(result) {
  return result
    && typeof result.name === "string"
    && typeof result.status === "string"
    && Number.isFinite(result.durationMs);
}

export default {
  pre: (input) => input && typeof input === "object" || "planned tests require an input object",
  post: (result) => Array.isArray(result) && result.every(validRun)
    || "planned tests return complete run records",
};
