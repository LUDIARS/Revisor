const hasJapanese = (entries) => entries.every((entry) => /[\u3040-\u30ff\u3400-\u9fff]/.test(String(entry)));

export default {
  pre: (input) => input && typeof input === "object" || "gate outcome requires review input",
  post: (result) => (
    Array.isArray(result?.reasons)
    && Array.isArray(result?.advisories)
    && hasJapanese([...result.reasons, ...result.advisories])
  ) || "gate outcome returns Japanese display messages",
};
