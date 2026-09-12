// @implements spec/feature/approved-push-handoff.md — immutable operation contract
import { createHash } from "node:crypto";
import { isAbsolute, resolve } from "node:path";

const SHA = /^[a-f0-9]{40}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export const ZERO_SHA = "0".repeat(40);

function exactKeys(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).sort().join() !== [...keys].sort().join()) {
    throw new Error(`Handoff requires exactly: ${keys.join(", ")}`);
  }
}

export function parsePushHandoff(value) {
  exactKeys(value, ["id", "repository", "cwd", "reason", "updates"]);
  if (typeof value.id !== "string" || !UUID.test(value.id)
    || typeof value.repository !== "string" || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value.repository)
    || value.repository.split("/").some((part) => part === "." || part === "..")
    || typeof value.cwd !== "string" || !isAbsolute(value.cwd)
    || typeof value.reason !== "string" || !value.reason.trim() || value.reason.length > 4000
    || !Array.isArray(value.updates) || value.updates.length < 1 || value.updates.length > 32) {
    throw new Error("Invalid handoff identity, repository, cwd, reason or updates");
  }
  const seen = new Set();
  const updates = value.updates.map((update) => {
    exactKeys(update, ["ref", "oldSha", "newSha"]);
    const { ref, oldSha, newSha } = update;
    if (typeof ref !== "string" || ref.length > 1024 || !/^refs\/(heads|tags)\/[A-Za-z0-9_/-][A-Za-z0-9_.\/-]*$/.test(ref)
      || ref.includes("..") || ref.includes("//") || ref.endsWith(".")
      || ref.split("/").some((part) => !part || part.startsWith(".") || part.endsWith(".lock"))
      || typeof oldSha !== "string" || typeof newSha !== "string"
      || !SHA.test(oldSha) || !SHA.test(newSha) || newSha === ZERO_SHA || oldSha === newSha || seen.has(ref)) {
      throw new Error("Invalid, duplicate or deleting handoff ref");
    }
    seen.add(ref);
    return { ref, oldSha, newSha };
  });
  return { id: value.id, repository: value.repository, cwd: resolve(value.cwd), reason: value.reason, updates };
}

export function handoffDigest(handoff, sessionId) {
  return createHash("sha256").update(JSON.stringify({ handoff, sessionId }), "utf8").digest("hex");
}

export function handoffPushArgs(handoff, remoteUrl) {
  return ["push", "--atomic",
    ...handoff.updates.map((u) => `--force-with-lease=${u.ref}:${u.oldSha === ZERO_SHA ? "" : u.oldSha}`),
    remoteUrl, ...handoff.updates.map((u) => `${u.newSha}:${u.ref}`)];
}

export function compareRemoteRefs(output, updates, field) {
  const refs = new Map(output.trim().split(/\r?\n/).filter(Boolean).map((line) => {
    const [sha, ref] = line.split(/\s+/);
    return [ref, sha];
  }));
  return updates.every((u) => (refs.get(u.ref) ?? ZERO_SHA) === u[field]);
}
