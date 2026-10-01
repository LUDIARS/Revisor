export default {
  pre: (pullRequests, options) => (
    Array.isArray(pullRequests)
    && options && typeof options === "object"
    && (options.view === "full" || options.view === "summary")
  ) || "list response requires records and a full|summary view",
  // The full list must not carry review report bodies unless explicitly included,
  // and every projected record keeps its review report version.
  post: (body, pullRequests, options) => {
    const parsed = JSON.parse(body);
    if (!Array.isArray(parsed?.pullRequests)) return "list response returns a pullRequests array";
    if (options.view === "full" && options.includeReviewReport) return true;
    return parsed.pullRequests.every((pullRequest) => (
      !("reviewReport" in pullRequest) && "reviewReportVersion" in pullRequest
    )) || "full list omits review report bodies and keeps reviewReportVersion";
  },
};
