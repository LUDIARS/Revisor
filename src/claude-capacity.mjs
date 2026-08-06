import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function claudeSessionLogPath({ cwd, sessionId, home = homedir() }) {
  if (!SESSION_ID.test(sessionId)) throw new Error("Claude session id is invalid.");
  const project = resolve(cwd).replace(/[:\\/]/g, "-");
  return join(home, ".claude", "projects", project, `${sessionId}.jsonl`);
}

function isRateLimitEvent(value) {
  return value?.error === "rate_limit" || value?.apiErrorStatus === 429;
}

// Claude Code can persist a structured API error without copying it to the
// non-interactive process stderr. Read only the Revisor-owned session log, and
// expose only the capacity classification rather than provider output.
export async function claudeSessionCapacityUnavailable({
  cwd,
  sessionId,
  home = homedir(),
  read = readFile,
}) {
  try {
    const content = await read(claudeSessionLogPath({ cwd, sessionId, home }), "utf8");
    return content.split(/\r?\n/).some((line) => {
      if (!line.trim()) return false;
      try {
        return isRateLimitEvent(JSON.parse(line));
      } catch {
        return false;
      }
    });
  } catch {
    // The provider log is optional diagnostic evidence. Its absence must leave
    // the ordinary stdout/stderr classification unchanged.
    return false;
  }
}
