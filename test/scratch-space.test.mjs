import assert from "node:assert/strict";
import { existsSync, mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { makeScratchDir, resolveScratchRoot } from "../src/scratch-space.mjs";
import { removeFixture } from "./helpers/fixture-cleanup.mjs";

test("設定が空なら OS の一時領域に落ちる", () => {
  assert.equal(resolveScratchRoot({}), tmpdir());
  assert.equal(resolveScratchRoot({ reviewScratchRoot: "" }), tmpdir());
  assert.equal(resolveScratchRoot({ reviewScratchRoot: "   " }), tmpdir());
  assert.equal(resolveScratchRoot(), tmpdir());
});

test("絶対パスの設定はそのまま親ディレクトリになる", () => {
  const configured = join(tmpdir(), "revisor-scratch-config");
  assert.equal(resolveScratchRoot({ reviewScratchRoot: configured }), configured);
  assert.equal(resolveScratchRoot({ reviewScratchRoot: ` ${configured} ` }), configured);
});

// 相対パスを黙って解決すると、審査が使い捨て worktree を cwd にして走る以上、
// 同じ設定が実行のたびに別の場所を指す。設定として拒む方を選ぶ。
test("相対パスは拒否する", () => {
  assert.throws(
    () => resolveScratchRoot({ reviewScratchRoot: "scratch" }),
    /absolute path/,
  );
  assert.throws(
    () => resolveScratchRoot({ reviewScratchRoot: "./scratch" }),
    /absolute path/,
  );
});

test("作業領域は設定した親の下に作られる", async () => {
  const root = mkdtempSync(join(tmpdir(), "revisor-scratch-parent-"));
  try {
    const made = await makeScratchDir("revisor-test-", { reviewScratchRoot: root });
    assert.equal(dirname(made), root);
    assert.ok(statSync(made).isDirectory());
  } finally {
    removeFixture(root);
  }
});

// 設定した時点ではまだ無いディレクトリを指していることがある。そこで毎回
// 落ちると、設定はできたのに審査が全部失敗する状態になる。
test("親ディレクトリが無ければ作る", async () => {
  const base = mkdtempSync(join(tmpdir(), "revisor-scratch-missing-"));
  const root = join(base, "nested", "scratch");
  try {
    assert.equal(existsSync(root), false);
    const made = await makeScratchDir("revisor-test-", { reviewScratchRoot: root });
    assert.equal(dirname(made), root);
  } finally {
    removeFixture(base);
  }
});
