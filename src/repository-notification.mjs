import { optionalWebhookSecret } from "./config.mjs";
import { postDiscordWebhook } from "./discord-webhook.mjs";
import { postSlackWebhook } from "./slack-webhook.mjs";
import { contract } from './contract-runtime.mjs'; /* augur-inject:import:0de7c951 */
import augurContract_c05cce47 from '../contracts/deliver-repository-notifications.contract.mjs'; /* augur-inject:contract-predicate:d73c448a */

function targetParts(target) {
  const match = /^(discord|slack):([A-Za-z0-9_.-]+)$/.exec(String(target ?? ""));
  return match ? { kind: match[1], name: match[2] } : null;
}

export async function deliverRepositoryNotifications({
  targets,
  text,
  env = process.env,
  readSecret = optionalWebhookSecret,
  discord = postDiscordWebhook,
  slack = postSlackWebhook,
}) {
  const results = [];
  for (const target of targets ?? []) {
    const parsed = targetParts(target);
    if (!parsed) continue;
    try {
      const url = readSecret(`webhook.${parsed.name}`, env);
      const sent = parsed.kind === "discord"
        ? await discord({ url, text, username: "Revisor" })
        : await slack({ url, text });
      results.push({ target, sent });
    } catch {
      results.push({ target, sent: false });
    }
  }
  return results;
}
// @ts-expect-error augur-inject
deliverRepositoryNotifications = contract(deliverRepositoryNotifications, { ...augurContract_c05cce47, contractId: 'C-2', mode: 'observe', sample: 1, where: 'src/repository-notification.mjs:10', rule: 'contract-wrap', id: 'c05cce47' }); /* augur-inject:contract-wrap:c05cce47 */

export async function notifyRepositoryEvent({ repository, event, text, ...options }) {
  const targets = repository?.notify?.[event];
  if (!Array.isArray(targets) || targets.length === 0) return [];
  return deliverRepositoryNotifications({ targets, text, ...options });
}
