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

// process.stdout を直接奪ってはいけない。 node:test は同じ stream にレポータの
// V8 直列化フレームを書くので、 実行順によっては `test:enqueue` のバイト列が出力比較に
// 混ざって落ちる (実際にそれで赤くなっていた)。 sink を渡して受け取る。
test("configures, reports, and removes a Discord webhook from stdin", async () => {
  const state = fixture();
  const originalEnv = process.env;
  let output = "";
  const stdout = { write: (chunk) => { output += chunk; return true; } };
  try {
    process.env = state.env;

    assert.equal(await main(
      ["config", "discord-webhook", "set", "--stdin"],
      {
        stdin: Readable.from([Buffer.from("https://discord.com/api/webhooks/123/abc\n")]),
        stdout,
      },
    ), 0);
    assert.equal(await main(["config", "discord-webhook", "status"], { stdout }), 0);
    assert.equal(await main(["config", "discord-webhook", "remove"], { stdout }), 0);
    assert.equal(await main(["config", "discord-webhook", "status"], { stdout }), 0);
    assert.equal(
      output,
      "Discord webhook URL saved.\nconfigured\nDiscord webhook URL removed.\nnot configured\n",
    );
  } finally {
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
