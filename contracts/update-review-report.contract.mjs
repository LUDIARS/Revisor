export default {
  // `report` は任意。まだ `reviewReport` を持たない PR レコードは `undefined` を渡すため、
  // `== null` で null と undefined の両方を通す (`typeof null === "object"` なので
  // `=== null` の分岐は元から null を拾えており、弾かれていたのは undefined だけだった)。
  pre: (report, entry) => (
    (report == null || typeof report === "object")
    && entry && typeof entry === "object"
    && typeof entry.id === "string"
  ) || "review report update requires an optional report and a stable entry id",
  post: (result) => (
    result?.version === 1
    && typeof result.attemptId === "string"
    && typeof result.headSha === "string"
    && Array.isArray(result.entries)
  ) || "review report update returns a versioned attempt report",
};
