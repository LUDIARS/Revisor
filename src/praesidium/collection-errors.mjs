/** @implements RV-PRAESIDIUM-05 — only collector-created failures carry public codes. */
const messages = new Map([
  ["source.nul", "non-text source"],
  ["source.invalid-utf8", "invalid UTF-8 source"],
  ["source.size-limit", "source size limit"],
  ["source.file-count-limit", "file count limit"],
]);
const codes = new WeakMap();

export function collectionError(code) {
  if (!messages.has(code)) throw new Error("unknown collection error code");
  const error = new Error(messages.get(code));
  codes.set(error, code);
  return error;
}

// Do not read exception messages/properties: arbitrary thrown objects may contain secrets or getters.
export function collectionErrorCode(error) {
  return codes.get(error);
}
