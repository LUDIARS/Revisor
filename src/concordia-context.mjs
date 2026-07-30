import { access } from "node:fs/promises";
import { join, resolve } from "node:path";
import { resolveServiceLoopbackUrl } from "./catalog.mjs";

/**
 * Concordia の loopback URL。場所の正本は Excubitor catalog なので、catalog が
 * 引けない環境ではコンテキストも通知も無い状態で動く (どちらも任意機能)。
 */
export function optionalConcordiaUrl(cwd, enabled) {
  if (!enabled) return null;
  try {
    return resolveServiceLoopbackUrl(cwd, "concordia");
  } catch {
    return null;
  }
}

function normalizeRepository(value) {
  return String(value ?? "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/\.git$/, "")
    .replace(/^https:\/\/github\.com\//i, "")
    .replace(/^(?:ssh:\/\/)?git@github\.com[:/]/i, "")
    .toLowerCase();
}

function conversationText(entries) {
  return entries
    .map((entry) => JSON.stringify(entry.payload))
    .join("\n")
    .slice(-16_000);
}

export async function loadConcordiaContext({
  baseUrl,
  repository,
  headRef,
  transport = fetch,
}) {
  if (!baseUrl) return null;
  try {
    const response = await transport(
      `${baseUrl.replace(/\/$/, "")}/v1/work/conversations?max_sessions=100&limit_per_session=80`,
      { signal: AbortSignal.timeout(3_000) },
    );
    if (!response.ok) return null;
    const body = await response.json();
    const matching = (body.sessions ?? []).filter((item) =>
      normalizeRepository(item.session?.repo_origin) === normalizeRepository(repository));
    const selected = matching.find((item) => item.session?.branch === headRef) ?? matching[0];
    if (!selected) return null;
    return {
      sessionId: selected.session.id,
      provider: selected.session.provider,
      text: conversationText(selected.conversation ?? []),
      source: "concordia-http",
    };
  } catch {
    // Concordia is optional; persisted context is attempted by the caller.
    return null;
  }
}

function parsePayload(payload) {
  try {
    return JSON.parse(payload);
  } catch {
    return payload;
  }
}

export async function loadPersistedConcordiaContext({
  workspaceRoot,
  repository,
  headRef,
  dbPath,
}) {
  const path = resolve(dbPath || join(workspaceRoot, "Concordia", "concordia.db"));
  try {
    await access(path);
    const { DatabaseSync } = await import("node:sqlite");
    const database = new DatabaseSync(path, { readOnly: true });
    try {
      const sessions = database.prepare(
        `SELECT id, provider, repo_origin, branch
           FROM sessions
          WHERE repo_origin IS NOT NULL
          ORDER BY last_seen_at DESC
          LIMIT 200`,
      ).all();
      const matching = sessions.filter((session) =>
        normalizeRepository(session.repo_origin) === normalizeRepository(repository));
      const selected = matching.find((session) => session.branch === headRef) ?? matching[0];
      if (!selected) return null;
      const entries = database.prepare(
        `SELECT payload
           FROM (
             SELECT id, payload
               FROM transcript_logs
              WHERE session_id = ?
              ORDER BY id DESC
              LIMIT 80
           )
          ORDER BY id ASC`,
      ).all(selected.id).map((entry) => ({ payload: parsePayload(entry.payload) }));
      return {
        sessionId: selected.id,
        provider: selected.provider,
        text: conversationText(entries),
        source: "concordia-db",
      };
    } finally {
      database.close();
    }
  } catch {
    // Missing, incompatible, or locked persisted context is an allowed capability loss.
    return null;
  }
}

export async function notifyConcordia({
  baseUrl,
  sessionId,
  text,
  transport = fetch,
}) {
  if (!baseUrl || !sessionId) return false;
  try {
    const response = await transport(
      `${baseUrl.replace(/\/$/, "")}/v1/sessions/${encodeURIComponent(sessionId)}/inject`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, source: "revisor" }),
        signal: AbortSignal.timeout(3_000),
      },
    );
    return response.ok;
  } catch {
    // Notification is best-effort and must not change the review verdict.
    return false;
  }
}

export function targetDomainQuestion(repository, number) {
  return [
    `PRレビュー: ${repository}#${number} の差分から対象ドメインを自動生成できませんでした。`,
    "対象ドメインと、追加すべき spec の責務・境界を指定してください。",
    "```ask",
    JSON.stringify({
      question: `${repository}#${number} の対象ドメインをどう定義しますか？`,
      multiSelect: false,
      options: [
        {
          label: "既存ドメイン",
          description: "既存ドメイン名と、この差分が担う責務を自由文で回答する",
        },
        {
          label: "新規ドメイン",
          description: "新しいドメイン名・責務・境界を自由文で回答する",
        },
        {
          label: "対象外",
          description: "ドメイン情報を持たない変更として扱う理由を回答する",
        },
      ],
    }),
    "```",
  ].join("\n");
}
