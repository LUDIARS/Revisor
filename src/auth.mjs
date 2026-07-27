import { timingSafeEqual } from "node:crypto";

export function bearerToken(value) {
  if (typeof value !== "string") return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(value.trim());
  return match?.[1];
}

export function tokenMatches(expected, supplied) {
  if (typeof expected !== "string" || typeof supplied !== "string") return false;
  const left = Buffer.from(expected, "utf8");
  const right = Buffer.from(supplied, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}
