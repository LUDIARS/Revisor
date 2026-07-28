export { isAllowedHost, isLoopbackHost } from "./host-policy.mjs";

export function isAuthorizedSession(headers, sessionToken) {
  return typeof sessionToken === "string"
    && sessionToken.length > 0
    && headers["x-revisor-session"] === sessionToken;
}
