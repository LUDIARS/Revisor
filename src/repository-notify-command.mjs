import { resolveServiceLoopbackUrl } from "./catalog.mjs";
import { option } from "./local-pr-commands.mjs";

export async function runRepositoryNotifyCommand(args, { cwd = process.cwd(), stdout = process.stdout, fetchImpl = fetch } = {}) {
  if (args[0] !== "repo" || args[1] !== "notify") return null;
  const repository = args[2];
  const release = option(args, "--release");
  if (!repository || !release) throw new Error("repo notify requires <owner/name> and --release <json-array>.");
  const notify = { release: JSON.parse(release) };
  const merged = option(args, "--merged");
  if (merged) notify.merged = JSON.parse(merged);
  const response = await fetchImpl(`${resolveServiceLoopbackUrl(cwd, "revisor")}/v1/repositories/${encodeURIComponent(repository)}/notify`, {
    method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ notify }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error ?? `Repository notification API returned HTTP ${response.status}.`);
  stdout.write(args.includes("--json") ? `${JSON.stringify(body.repository, null, 2)}\n` : `Updated notifications for ${body.repository.repository}.\n`);
  return 0;
}
