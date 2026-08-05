import { runProcess } from "./process.mjs";
import { RevisorError } from "./errors.mjs";

export function githubRemoteUrl(repository) {
  const [owner, name, extra] = String(repository).split("/");
  if (!owner || !name || extra) {
    throw new RevisorError(`Invalid GitHub repository '${repository}'.`);
  }
  return `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(name)}.git`;
}

function authenticatedEnvironment(token, env) {
  const header = Buffer.from(`x-access-token:${token}`, "utf8").toString("base64");
  return {
    ...env,
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${header}`,
    GIT_TERMINAL_PROMPT: "0",
    REVISOR_PUBLISHING: "1",
    ALLOW_MAIN_PUSH: "1",
  };
}

export async function runAuthenticatedGit({ cwd, args, token, env = process.env }) {
  const result = await runProcess({
    command: "git",
    args,
    cwd,
    env: authenticatedEnvironment(token, env),
    timeoutMs: 120_000,
  });
  if (!result.ok) {
    throw new RevisorError(
      `Authenticated git ${args[0]} failed: ${result.stderr.trim() || result.stdout.trim()}`,
    );
  }
  return result.stdout.trim();
}
