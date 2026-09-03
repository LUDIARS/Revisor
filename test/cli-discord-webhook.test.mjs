import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { main } from "../src/cli.mjs";
import { removeFixture } from "./helpers/fixture-cleanup.mjs";

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "revisor-cli-discord-webhook-"));
  return {
    directory,
    env: {
      REVISOR_CONFIG_PATH: join(directory, "config.json"),
      REVISOR_KEY_PATH: join(directory, "config.key"),
    },
  };
}

test("configures, reports, and removes a Discord webhook from stdin", async () => {
  const state = fixture();
  const originalEnv = process.env;
  const originalWrite = process.stdout.write;
  let output = "";
  try {
    process.env = state.env;
    process.stdout.write = (chunk) => {
      output += chunk;
      return true;
    };

    assert.equal(await main(
      ["config", "discord-webhook", "set", "--stdin"],
      { stdin: Readable.from([Buffer.from("https://discord.com/api/webhooks/123/abc\n")]) },
    ), 0);
    assert.equal(await main(["config", "discord-webhook", "status"]), 0);
    assert.equal(await main(["config", "discord-webhook", "remove"]), 0);
    assert.equal(await main(["config", "discord-webhook", "status"]), 0);
    assert.equal(
      output,
      "Discord webhook URL saved.\nconfigured\nDiscord webhook URL removed.\nnot configured\n",
    );
  } finally {
    process.stdout.write = originalWrite;
    process.env = originalEnv;
    removeFixture(state.directory);
  }
});

test("requires stdin for a Discord webhook URL", async () => {
  await assert.rejects(
    main(["config", "discord-webhook", "set"]),
    /discord-webhook set requires --stdin/,
  );
});
