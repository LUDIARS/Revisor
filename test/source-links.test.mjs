import assert from "node:assert/strict";
import test from "node:test";
import { appendSourceLinks } from "../src/source-links.mjs";

test("appends durable message links to the PR body", () => {
  assert.equal(appendSourceLinks("Original description", [{
    label: "Discord セッション投稿",
    url: "https://discord.com/channels/1/2/3",
  }]), [
    "Original description",
    "",
    "関連メッセージ:",
    "- [Discord セッション投稿](<https://discord.com/channels/1/2/3>)",
  ].join("\n"));
});

test("keeps parentheses inside a source URL destination", () => {
  assert.match(appendSourceLinks("", [{
    label: "Discord セッション投稿",
    url: "https://discord.com/channels/(1)/2",
  }]), /\(<https:\/\/discord\.com\/channels\/\(1\)\/2>\)/);
});
