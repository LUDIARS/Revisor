function hostName(value) {
  if (typeof value !== "string") return "";
  try {
    return new URL(`http://${value}`).hostname.toLowerCase();
  } catch {
    return "";
  }
}

export function isLoopbackHost(value) {
  const host = hostName(value);
  return host === "127.0.0.1" || host === "localhost" || host === "[::1]";
}

export function isAuthorizedSession(headers, sessionToken) {
  return typeof sessionToken === "string"
    && sessionToken.length > 0
    && headers["x-revisor-session"] === sessionToken;
}
