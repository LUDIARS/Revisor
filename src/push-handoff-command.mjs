// @implements spec/feature/approved-push-handoff.md — existing push CLI handoff adapter
import { readFileSync } from "node:fs";
import { option } from "./local-pr-commands.mjs";
import { LocalPrStore } from "./state-store.mjs";
import { resolveDbPath } from "./revisor-db.mjs";
import { PublicationCoordinator } from "./publication-coordinator.mjs";
import { PushHandoffStore } from "./push-handoff-store.mjs";
import { publishPushHandoff } from "./push-handoff.mjs";

export async function runPushHandoffCommand(args, { stdout = process.stdout, env = process.env } = {}) {
  if (args[0] !== "push" || !args.includes("--handoff")) return null;
  if (["--branch", "--remote-branch", "--force-with-lease", "--repo", "--actor"].some((flag) => args.includes(flag))) {
    throw new Error("Handoff cannot be combined with branch push options");
  }
  const path = option(args, "--handoff");
  const sessionId = option(args, "--session-id");
  if (!path || !sessionId) throw new Error("push --handoff requires a file and --session-id");
  const bytes = readFileSync(path);
  if (bytes.length > 65536) throw new Error("Handoff exceeds 64 KiB");
  const input = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  const dbPath = resolveDbPath(env);
  const ledger = new PushHandoffStore(dbPath);
  const store = new LocalPrStore({ path: dbPath });
  try {
    const result = await publishPushHandoff(input, {
      sessionId, ledger, store, env,
      coordinator: new PublicationCoordinator({ lockPath: `${dbPath}.publication` }),
      reconcile: args.includes("--reconcile"),
    });
    stdout.write(args.includes("--json") ? `${JSON.stringify(result, null, 2)}\n`
      : `Handoff ${result.id}: ${result.status}. ${result.status === "published" ? "Remote refs confirmed; local checkout/tag synchronization remains required." : "No automatic retry; inspect or reconcile this request."}\n`);
    return result.status === "published" ? 0 : 1;
  } finally { try { store.close(); } finally { ledger.close(); } }
}
