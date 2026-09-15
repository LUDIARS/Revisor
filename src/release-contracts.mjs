import { normalizeLocalVersion } from "./local-version.mjs";

function object(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Request body must be an object.");
  }
  return value;
}

function text(value, label, maximum) {
  if (typeof value !== "string" || !value.trim() || value.length > maximum) {
    throw new Error(`${label} is invalid.`);
  }
  return value.trim();
}

function confirmed(body) {
  if (body.confirm !== true && body.confirmed !== true) {
    throw new Error("The immediate repository operation must be explicitly confirmed.");
  }
}

export function validateVersionInitialization(value) {
  const body = object(value);
  confirmed(body);
  return { version: normalizeLocalVersion(body.version) };
}

export function validateManualRelease(value) {
  const body = object(value);
  confirmed(body);
  if (body.kind !== "major" && body.kind !== "minor") {
    throw new Error("kind must be 'major' or 'minor'.");
  }
  if (body.githubRelease !== undefined && typeof body.githubRelease !== "boolean") {
    throw new Error("githubRelease must be a boolean.");
  }
  return {
    kind: body.kind,
    expectedVersion: normalizeLocalVersion(body.expectedVersion),
    title: text(body.title, "title", 256),
    notes: text(body.notes, "notes", 60_000),
    // 未指定は workflow の既定に任せる (`manual-release-channel.mjs`)。
    ...(body.githubRelease === undefined ? {} : { githubRelease: body.githubRelease }),
  };
}
