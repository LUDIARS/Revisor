// Only the files a build needs leave the machine.  Databases, keys and env
// files are refused by name so a careless --input cannot ship secrets.
export const MAX_INPUT_BYTES = 64 * 1024 * 1024;

const SECRET_PATTERNS = [
  /(^|\/)\.env($|\.)/i,
  /\.pem$/i,
  /\.key$/i,
  /\.pfx$/i,
  /\.p12$/i,
  /(^|\/)credentials[^/]*$/i,
  /(^|\/)id_(rsa|ed25519|ecdsa)[^/]*$/i,
  /\.sqlite[^/]*$/i,
  /\.db$/i,
];

export function normalizeInputPath(value) {
  if (typeof value !== "string" || !value.trim()) throw new Error("input path must be a non-empty string.");
  const path = value.trim().replaceAll("\\", "/");
  if (path.startsWith("/") || /^[a-z]:/i.test(path)) throw new Error(`input '${value}' must be relative to the repository.`);
  const segments = path.split("/");
  if (segments.some((segment) => segment === ".." || segment === "." || segment === "")) {
    throw new Error(`input '${value}' must not contain empty, '.' or '..' segments.`);
  }
  if (segments[0] === ".git") throw new Error(`input '${value}' is inside .git.`);
  if (SECRET_PATTERNS.some((pattern) => pattern.test(path))) {
    throw new Error(`input '${value}' looks like a secret or database and is not transferred.`);
  }
  return path;
}

export function assertInputSize(path, size) {
  if (!Number.isInteger(size) || size < 0) throw new Error(`input '${path}' has an invalid size.`);
  if (size > MAX_INPUT_BYTES) throw new Error(`input '${path}' exceeds ${MAX_INPUT_BYTES} bytes.`);
}
