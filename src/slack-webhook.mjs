import { contract } from './contract-runtime.mjs'; /* augur-inject:import:be51487e */
import augurContract_28abe634 from '../contracts/post-slack-webhook.contract.mjs'; /* augur-inject:contract-predicate:2dc50259 */
const WEBHOOK_URL_PATTERN = /^https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/_-]+$/;
const ZERO_WIDTH_SPACE = String.fromCharCode(0x200b);

export function isSlackWebhookUrl(value) {
  return WEBHOOK_URL_PATTERN.test(String(value ?? "").trim());
}

export function sanitizeSlackText(value) {
  return String(value ?? "")
    .replace(/<!(channel|here)>/gi, `<${ZERO_WIDTH_SPACE}!$1>`)
    .replace(/<@/g, `<${ZERO_WIDTH_SPACE}@`);
}

/** Best-effort Slack incoming-webhook delivery; callers retain their primary result. */
export async function postSlackWebhook({ url, text, transport = fetch }) {
  if (!isSlackWebhookUrl(url) || !text) return false;
  try {
    const response = await transport(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: sanitizeSlackText(text) }),
      signal: AbortSignal.timeout(3_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}
// @ts-expect-error augur-inject
postSlackWebhook = contract(postSlackWebhook, { ...augurContract_28abe634, contractId: 'C-3', mode: 'observe', sample: 1, where: 'src/slack-webhook.mjs:15', rule: 'contract-wrap', id: '28abe634' }); /* augur-inject:contract-wrap:28abe634 */
