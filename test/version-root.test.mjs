import assert from "node:assert/strict";
import test from "node:test";
import { resolveVersionRootPath } from "../src/version-root.mjs";

test("公開は隔離リポジトリではなく登録 checkout の版数を読む", () => {
  // `prepareMergeRepository` を通した形。rootPath は隔離リポジトリを指している。
  const merged = {
    repository: "LUDIARS/Calicula",
    rootPath: "C:/Users/x/AppData/Local/LUDIARS/merge-repositories/ludiars-calicula-abc",
    registeredRootPath: "E:/Document/Ars/Calicula",
  };
  assert.equal(resolveVersionRootPath(merged), "E:/Document/Ars/Calicula");
});

test("登録 repository そのものは rootPath をそのまま使う", () => {
  assert.equal(
    resolveVersionRootPath({ repository: "LUDIARS/Calicula", rootPath: "E:/Document/Ars/Calicula" }),
    "E:/Document/Ars/Calicula",
  );
});

test("隔離 repository の registeredRootPath 欠落は黙って rootPath へ落とさない", () => {
  assert.throws(
    () => resolveVersionRootPath({ rootPath: "E:/repo", registeredRootPath: "   " }),
    /registered repository root path/,
  );
  assert.throws(
    () => resolveVersionRootPath({ rootPath: "E:/repo", registeredRootPath: null }),
    /registered repository root path/,
  );
});

test("パスを持たない repository は黙って通さない", () => {
  assert.throws(() => resolveVersionRootPath({}), TypeError);
  assert.throws(() => resolveVersionRootPath(null), TypeError);
});
