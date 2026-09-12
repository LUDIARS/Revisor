import { optionalWebhookSecret } from "./config.mjs";
import { optionalConcordiaUrl } from "./concordia-context.mjs";
import { postDiscordWebhook } from "./discord-webhook.mjs";
import { postSlackWebhook } from "./slack-webhook.mjs";
import { contract } from './contract-runtime.mjs'; /* augur-inject:import:0de7c951 */
import augurContract_c05cce47 from '../contracts/deliver-repository-notifications.contract.mjs'; /* augur-inject:contract-predicate:d73c448a */

function targetParts(target) {
  const match = /^(discord|slack):([A-Za-z0-9_.-]+)$/.exec(String(target ?? ""));
  if (match) return { kind: match[1], name: match[2] };
  return target === "concordia" ? { kind: "concordia" } : null;
}

async function postConcordiaRelease({ baseUrl, release, transport }) {
  if (!baseUrl) return false;
  try {
    const response = await transport(
      `${baseUrl.replace(/\/$/, "")}/v1/events/release-published`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(release),
        signal: AbortSignal.timeout(3_000),
      },
    );
    return response.ok;
  } catch {
    // Concordia release observability must not alter the completed Release.
    return false;
  }
}

export async function deliverRepositoryNotifications({
  targets,
  text,
  env = process.env,
  readSecret = optionalWebhookSecret,
  discord = postDiscordWebhook,
  slack = postSlackWebhook,
  resolveConcordiaUrl = (cwd) => optionalConcordiaUrl(cwd, true),
  transport = fetch,
  cwd = process.cwd(),
  release,
}) {
  const results = [];
  for (const target of targets ?? []) {
    const parsed = targetParts(target);
    if (!parsed) continue;
    try {
      if (parsed.kind === "concordia") {
        const sent = await postConcordiaRelease({
          baseUrl: resolveConcordiaUrl(cwd),
          release,
          transport,
        });
        results.push({ target, sent });
        continue;
      }
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

export async function notifyRepositoryEvent({
  repository,
  event,
  text,
  kind,
  tag,
  previousTag,
  version,
  title,
  notice,
  releaseUrl,
  publishedAt,
  ...options
}) {
  const targets = repository?.notify?.[event];
  if (!Array.isArray(targets) || targets.length === 0) return [];
  return deliverRepositoryNotifications({
    targets: event === "release" ? targets : targets.filter((target) => target !== "concordia"),
    text,
    release: {
      repository: repository?.repository,
      kind,
      tag,
      previousTag,
      version,
      title,
      notice,
      releaseUrl,
      publishedAt,
    },
    ...options,
  });
}
