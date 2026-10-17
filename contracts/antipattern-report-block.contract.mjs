export default {
  pre: (perspective) => (perspective == null || typeof perspective === "object")
    || "anti-pattern report block takes an optional perspective",
  post: (result) => {
    const failed = result?.status === "stale" || result?.status === "unavailable";
    return (
      typeof result?.summary === "string"
      && (!failed || result.summary.startsWith("アンチパターン観点: 取得失敗"))
      && Array.isArray(result.findings)
      && result.findings.every((finding) => result.ids.includes(finding.id))
    ) || "anti-pattern report block states fetch failure and only cites catalog AP IDs";
  },
};
