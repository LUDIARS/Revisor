import { readFileSync } from "node:fs";
import { resolveServiceLoopbackUrl } from "./catalog.mjs";
import { option } from "./local-pr-commands.mjs";
import { workflowAuthorizationHeaders } from "./workflow-authorization.mjs";

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
    // 指定しなければ workflow の既定 (App 経路なら作る、 GitHub Workflow なら作らない)。
    ...(args.includes("--no-github-release") ? { githubRelease: false } : {}),
    ...(args.includes("--github-release") ? { githubRelease: true } : {}),
  };
}

export async function runManualReleaseCommand(args, {
  cwd = process.cwd(),
  stdout = process.stdout,
  fetchImpl = fetch,
  env = process.env,
} = {}) {
  if (args[0] !== "release") return null;
  const repository = required(args[1], "release requires <owner/name>.");
  const payload = JSON.stringify(requestBody(args));
  // Resolve the token before sending: a missing one should say what to fix, not
  // surface as an opaque 401 from the service.
  const authorization = workflowAuthorizationHeaders(env);
  const response = await fetchImpl(
    `${resolveServiceLoopbackUrl(cwd, "revisor")}/v1/repositories/${encodeURIComponent(repository)}/releases`,
    {
      method: "POST",
      headers: { "content-type": "application/json", ...authorization },
      body: payload,
    },
  );
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error ?? `Release API returned HTTP ${response.status}.`);
  if (args.includes("--json")) stdout.write(`${JSON.stringify(body.release, null, 2)}\n`);
  else if (body.release.githubRelease === false) {
    stdout.write(`Published ${body.release.tag} for ${body.release.repository} (tag only, no GitHub Release).\n`);
  } else stdout.write(`Published ${body.release.tag} for ${body.release.repository}.\n`);
  return 0;
}
