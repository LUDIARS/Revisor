const MAX_CONTENT_LENGTH = 2000;
const TRUNCATION_SUFFIX = "… (省略)";
const WEBHOOK_URL_PATTERN =
  /^https:\/\/(?:discord\.com|discordapp\.com)\/api\/webhooks\/\d+\/[\w-]+$/;

export function isDiscordWebhookUrl(value) {
  return WEBHOOK_URL_PATTERN.test(String(value ?? "").trim());
}

export function truncateContent(text, max = MAX_CONTENT_LENGTH) {
  const value = String(text ?? "");
  if (value.length <= max) return value;
  return value.slice(0, max - TRUNCATION_SUFFIX.length) + TRUNCATION_SUFFIX;
}

/**
 * Discord webhook へ lifecycle 通知を 1 通送る。通知失敗は審査結果へ影響させない。
 */
export async function postDiscordWebhook({
  url,
  text,
  username = "Revisor",
  transport = fetch,
}) {
  if (!isDiscordWebhookUrl(url) || !text) return false;
  try {
    const response = await transport(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: truncateContent(text),
        username,
        allowed_mentions: { parse: [] },
      }),
      signal: AbortSignal.timeout(3_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}
