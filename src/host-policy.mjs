const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
const MAX_ALLOWED_HOSTS = 64;
const MAX_HOST_LENGTH = 253;

function hostName(value) {
  if (typeof value !== "string") return "";
  const candidate = value.trim();
  if (
    !candidate
    || candidate.length > MAX_HOST_LENGTH + 8
    || candidate.includes("://")
    || /[/\\?#@\s]/.test(candidate)
  ) {
    return "";
  }
  try {
    const parsed = new URL(`http://${candidate}`);
    const host = parsed.hostname.toLowerCase().replace(/\.$/, "");
    if (!host || host === "*" || host.length > MAX_HOST_LENGTH) return "";
    return host;
  } catch {
    return "";
  }
}

export function isLoopbackHost(value) {
  return LOOPBACK_HOSTS.has(hostName(value));
}

export function isLoopbackAddress(address) {
  return !address
    || address === "::1"
    || address === "127.0.0.1"
    || address.startsWith("::ffff:127.");
}

export function normalizeAllowedHosts(values) {
  if (!Array.isArray(values)) {
    throw new TypeError("Allowed hosts must be an array.");
  }
  if (values.length > MAX_ALLOWED_HOSTS) {
    throw new TypeError(`Allowed hosts must contain at most ${MAX_ALLOWED_HOSTS} entries.`);
  }
  const hosts = [];
  const seen = new Set();
  for (const value of values) {
    const host = hostName(value);
    if (!host) {
      throw new TypeError(`Allowed host is invalid: ${String(value ?? "")}`);
    }
    if (!seen.has(host)) {
      seen.add(host);
      hosts.push(host);
    }
  }
  return hosts;
}

export function isAllowedHost(value, allowedHosts = []) {
  const host = hostName(value);
  return LOOPBACK_HOSTS.has(host) || allowedHosts.includes(host);
}
