import assert from "node:assert/strict";
import test from "node:test";
import { describeServeExit } from "../src/runtime-diagnostics.mjs";

// serve は短い間隔で入れ替わることがあり、その契機が「バナーがまた出た」ことからしか
// 分からなかった。外から止められたのか自分で落ちたのかを切り分ける。

test("names the signal when the stop came from outside", () => {
  assert.match(describeServeExit({ signal: "SIGTERM" }), /SIGTERM/);
  assert.match(describeServeExit({ signal: "SIGTERM" }), /external stop request/);
  assert.match(describeServeExit({ signal: "SIGINT" }), /SIGINT/);
});

test("marks a non-zero exit without a signal as self-inflicted", () => {
  const line = describeServeExit({ code: 1 });

  assert.match(line, /code=1/);
  assert.match(line, /not an external stop/);
  // 外部停止と読み違えられる語を混ぜない。
  assert.doesNotMatch(line, /external stop request/);
});

test("distinguishes a normal exit from a crash", () => {
  assert.match(describeServeExit({ code: 0 }), /exiting normally/);
  assert.doesNotMatch(describeServeExit({ code: 0 }), /not an external stop/);
});

test("defaults to a normal exit when nothing is known", () => {
  assert.match(describeServeExit(), /exiting normally/);
  assert.match(describeServeExit({}), /exiting normally/);
});

// 3 経路が別の文言になっていること自体を固定する。
test("keeps the three exit paths distinguishable from one another", () => {
  const lines = new Set([
    describeServeExit({ signal: "SIGTERM" }),
    describeServeExit({ code: 0 }),
    describeServeExit({ code: 1 }),
  ]);

  assert.equal(lines.size, 3);
});
