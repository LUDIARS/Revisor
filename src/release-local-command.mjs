import { readFileSync } from "node:fs";
import { resolveServiceLoopbackUrl } from "./catalog.mjs";
import { option } from "./local-pr-commands.mjs";

function required(value, message) {
  if (typeof value !== "string" || !value.trim()) throw new Error(message);
  return value;
}

function requestBody(args) {
  const kind = option(args, "--kind");
  if (kind !== "major" && kind !== "minor") {
    throw new Error("release requires --kind major|minor.");
  }
  const notesFile = required(option(args, "--notes-file"), "release requires --notes-file.");
  return {
    kind,
    expectedVersion: required(option(args, "--expected-version"), "release requires --expected-version."),
    title: required(option(args, "--title"), "release requires --title."),
    notes: readFileSync(notesFile, "utf8"),
    confirmed: true,
  };
}

export async function runManualReleaseCommand(args, {
  cwd = process.cwd(),
  stdout = process.stdout,
  fetchImpl = fetch,
} = {}) {
  if (args[0] !== "release") return null;
  const repository = required(args[1], "release requires <owner/name>.");
  const response = await fetchImpl(
    `${resolveServiceLoopbackUrl(cwd, "revisor")}/v1/repositories/${encodeURIComponent(repository)}/releases`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(requestBody(args)),
    },
  );
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error ?? `Release API returned HTTP ${response.status}.`);
  if (args.includes("--json")) stdout.write(`${JSON.stringify(body.release, null, 2)}\n`);
  else stdout.write(`Published ${body.release.tag} for ${body.release.repository}.\n`);
  return 0;
}
