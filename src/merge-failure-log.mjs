import { redactSecretLines } from "./leakage.mjs";

const MAX_BOARD_MESSAGE_LENGTH = 2_000;
const MAX_LOG_DETAIL_LENGTH = 16_000;

function truncateEnd(text, maximumLength) {
  if (text.length <= maximumLength) return text;
  return `[truncated ${text.length - maximumLength} chars]\n${text.slice(-maximumLength)}`;
}

function errorText(error, { includeStack = false } = {}) {
  if (error instanceof Error) {
    return includeStack && error.stack ? error.stack : error.message;
  }
  return String(error);
}

export function mergeFailureMessage(error) {
  return truncateEnd(
    redactSecretLines(errorText(error)),
    MAX_BOARD_MESSAGE_LENGTH,
  );
}

export function writeMergeFailureLog({
  error,
  repository,
  pullRequest,
  mergeRootPath = null,
  now = () => new Date().toISOString(),
  stream = process.stderr,
}) {
  const record = {
    timestamp: now(),
    level: "error",
    event: "local_pr_merge_failed",
    repository: repository.repository,
    localPrId: pullRequest.id,
    number: pullRequest.number,
    headRef: pullRequest.headRef,
    baseRef: pullRequest.baseRef,
    mergeRootPath,
    errorName: error instanceof Error ? error.name : "Error",
    detail: truncateEnd(
      redactSecretLines(errorText(error, { includeStack: true })),
      MAX_LOG_DETAIL_LENGTH,
    ),
  };
  stream.write(`${JSON.stringify(record)}\n`);
  return record;
}
