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
  if (body.confirm !== true) {
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
  return {
    kind: body.kind,
    expectedVersion: normalizeLocalVersion(body.expectedVersion),
    title: text(body.title, "title", 256),
    notes: text(body.notes, "notes", 60_000),
  };
}
