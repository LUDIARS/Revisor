import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { writeDiscordWebhookUrl } from "../src/config.mjs";
import { createReviewContext } from "../src/review-context.mjs";
import { removeFixture } from "./helpers/fixture-cleanup.mjs";

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "revisor-review-context-"));
  return {
    directory,
    env: {
      REVISOR_CONFIG_PATH: join(directory, "config.json"),
      REVISOR_KEY_PATH: join(directory, "config.key"),
      REVISOR_DB_PATH: join(directory, "revisor.db"),
    },
  };
}

function pullRequest() {
  return {
    repository: "LUDIARS/Revisor",
    number: 12,
    sessionId: "lictor-review",
    title: "Notify Discord",
    headRef: "feat/discord-pr-notifications",
    baseRef: "main",
    status: "open",
    checkStatus: "queued",
    reasons: [],
  };
}

test("uses the configured webhook instead of Concordia lifecycle chat", async () => {
  const state = fixture();
  const webhookUrl = "https://discord.com/api/webhooks/123456/abc";
  let request;
  try {
    writeDiscordWebhookUrl(webhookUrl, state.env);
    const context = createReviewContext({
      cwd: state.directory,
      env: state.env,
      postWebhook: async (value) => { request = value; return true; },
    });
    await context.localPrService.notifyLifecycle("created", pullRequest());
    assert.equal(request.url, webhookUrl);
    assert.equal(request.username, "Revisor");
    assert.match(request.text, /LUDIARS\/Revisor#12/);
  } finally {
    removeFixture(state.directory);
  }
});
