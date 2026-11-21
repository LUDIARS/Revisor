import { createHash } from "node:crypto";

// Digests must not depend on key order or whitespace, otherwise the same
// request re-serialised by an executor would look like a forgery.
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sha256Hex(data) {
  return createHash("sha256").update(data).digest("hex");
}

export function digestOf(value) {
  return sha256Hex(canonicalJson(value));
}
