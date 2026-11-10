import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync, rmSync, symlinkSync, truncateSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { changedSourcePaths, containedFile, realPath, realPaths, reconfiguredNativeUnits, reviewedPaths, trackedSources } from "../src/praesidium/files.mjs";

function repository(t) {
  const root = mkdtempSync(join(tmpdir(), "praesidium-files-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync("git", ["init", "--quiet"], { cwd: root, windowsHide: true });
  return root;
}

test("includes nonignored new sources so pre-commit autofix cannot evade the scan", (t) => {
  const root = repository(t);
  writeFileSync(join(root, ".gitignore"), "node_modules/\n");
  writeFileSync(join(root, "new.js"), "eval(input);\n");
  mkdirSync(join(root, "node_modules"));
  writeFileSync(join(root, "node_modules", "ignored.js"), "eval(input);\n");
  assert.deepEqual(trackedSources(root).map(item => item.file), ["new.js"]);
});

test("rejects non-text, oversized and invalid UTF-8 sources rather than truncating", (t) => {
  const root = repository(t);
  const path = join(root, "source.js");
  for (const contents of [Buffer.from([0xff]), Buffer.from([0]), Buffer.alloc(2 * 1024 * 1024 + 1, 65)]) {
    writeFileSync(path, contents);
    assert.throws(() => trackedSources(root));
  }
  assert.throws(() => containedFile(root, root));
  assert.throws(() => containedFile(root, ".."));
});

test("collection resolves each directory once, however deep its sources lie, and still rejects links", (t) => {
  const root = repository(t);
  // 300 headers at the end of a chain 1,000 directories deep: resolving each whole took
  // about 7 s, the system reading the chain again at each of its components.
  const chain = Array(1_000).fill("d").join("/");
  mkdirSync(join(root, chain), { recursive: true });
  for (let index = 0; index < 300; index++) writeFileSync(join(root, chain, `h${index}.h`), "int x;\n");
  const started = performance.now();
  assert.equal(trackedSources(root).length, 300);
  assert.ok(performance.now() - started < 1_500, `${performance.now() - started} ms`);
  // Resolved once each or by the system, a file whose real path leaves the root, or that is
  // a link, is no repository file.
  if (process.platform !== "win32") {
    const outside = repository(t);
    writeFileSync(join(outside, "x.h"), "int x;\n");
    mkdirSync(join(root, "real"));
    writeFileSync(join(root, "real/x.h"), "int x;\n");
    symlinkSync(outside, join(root, "away"));
    symlinkSync("real", join(root, "inside"));
    symlinkSync("real/x.h", join(root, "link.h"));
    for (const paths of [undefined, realPaths()]) {
      assert.throws(() => containedFile(root, "away/x.h", paths), /unsafe file boundary/);
      assert.equal(containedFile(root, "inside/x.h", paths), join(root, "inside/x.h"));
      assert.throws(() => containedFile(root, "link.h", paths), /unsafe file boundary/);
      assert.throws(() => containedFile(root, "gone.h", paths));
    }
    assert.throws(() => trackedSources(root), /unsafe file boundary/);
    // A directory reached again, by its name, after a `..` or through a link, is the same
    // node, so nothing below it is asked of the system again.
    const paths = realPaths(), node = realPath(paths, `${root}/real/x.h`);
    assert.equal(node.path, realpathSync.native(join(root, "real/x.h")));
    for (const named of ["real/../real/x.h", "inside/x.h", "inside/../real/x.h", "real/./x.h", `away/../${basename(root)}/real/x.h`]) {
      assert.equal(realPath(paths, `${root}/${named}`), node, named);
    }
    assert.equal(realPath(paths, `${root}/real/x.h/..`), null);
  }
});

test("accepts an escaped NUL in text without accepting raw NUL bytes", (t) => {
  const root = repository(t);
  const path = join(root, "key.js");
  const source = 'export const key = `${id}\\0${updatedAt}`;\n';
  writeFileSync(path, source);
  assert.deepEqual(trackedSources(root), [{ file: "key.js", source }]);
  writeFileSync(path, source.replace("\\0", "\0"));
  assert.throws(() => trackedSources(root), /non-text source/);
});

test("changed paths include added, modified and new files but never deletions", (t) => {
  const root = repository(t);
  const git = (...args) => execFileSync("git", ["-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", ...args],
    { cwd: root, windowsHide: true, encoding: "utf8" }).trim();
  for (const file of ["kept.cpp", "edited.cpp", "removed.cpp"]) writeFileSync(join(root, file), "int f();\n");
  git("add", "--all");
  git("commit", "--quiet", "-m", "base");
  const base = git("rev-parse", "HEAD");
  writeFileSync(join(root, "edited.cpp"), "int g();\n");
  rmSync(join(root, "removed.cpp"));
  writeFileSync(join(root, "added.cpp"), "int h();\n");
  git("add", "added.cpp");
  writeFileSync(join(root, "untracked.h"), "int i();\n");
  assert.deepEqual(changedSourcePaths(root, base).sort(), ["added.cpp", "edited.cpp", "untracked.h"]);
  assert.throws(() => changedSourcePaths(root, "--output=x"));
  assert.throws(() => changedSourcePaths(root, "missing-ref"));
});

test("collects Objective-C++, module units and inline headers alongside C/C++ sources", (t) => {
  const root = repository(t);
  const files = ["capture.mm", "core.cppm", "core.ixx", "detail.inl", "detail.tpp", "unit.c++", "notes.txt"];
  for (const file of files) writeFileSync(join(root, file), "int f();\n");
  writeFileSync(join(root, "bridge.m"), "int f(void) { return 0; }\n");
  assert.deepEqual(trackedSources(root).map(item => item.file).sort(),
    ["bridge.m", "capture.mm", "core.cppm", "core.ixx", "detail.inl", "detail.tpp", "unit.c++"]);
});

test("a MATLAB .m is left out, while any .m that could hold Objective-C stays a policy source", (t) => {
  const root = repository(t);
  const hex = (text) => Buffer.from(text, "hex");
  // MATLAB: `%` comments, `system`/`sscanf` builtins and comments saved by a pre-R2020a editor in
  // Latin-1, Shift_JIS ("% 基本設定を読む", "% ボタンの処理", "% この本は表の設定": the second byte
  // of 本 and ボ is `{`, of 表 `\`), GBK ("% 读取数据 納") and Big5 ("% 現在的程式 認"), and a
  // Shift_JIS ideographic space (second byte `@`) beside the word `import`.
  const matlab = {
    "plot_data.m": "% plot_data.m - do not call system(cmd) or strcpy(a, b) here\nx = linspace(0, 1, 10)';\nplot(x);\n",
    "run_cmd.m": "function out = run_cmd(cmd)\n[status, out] = system(cmd);\nparts = sscanf(out, '%s %d');\nend\n",
    "load_data.m": Buffer.concat([Buffer.from("% R"), Buffer.from([0xe9]), Buffer.from("sum\nh = @(x) x + 1;\n")]),
    "sjis_hon.m": Buffer.concat([hex("25208aee967b90dd92e882f093c782de"), Buffer.from("\nx = linspace(0, 1, 10);\n")]),
    "sjis_bo.m": Buffer.concat([hex("2520837b835e839382cc8f88979d"), Buffer.from("\n[s, o] = system(cmd);\n")]),
    "sjis_phrase.m": Buffer.concat([hex("252082b182cc967b82cd955c82cc90dd92e8"), Buffer.from("\n% "), hex("955c"), Buffer.from("\nx = 1;\n")]),
    "sjis_space.m": Buffer.concat([hex("25208366815b835e82f08140696d706f72742082b782e9"), Buffer.from("\nx = 1;\n")]),
    "gbk.m": Buffer.concat([hex("2520b6c1c8a1cafdbedd20bc7b"), Buffer.from("\nx = 1;\n")]),
    "big5.m": Buffer.concat([hex("2520b27ba662aabab57ba6a120bb7b"), Buffer.from("\n[s, o] = system(cmd);\n")]),
  };
  // Objective-C reaches a body or a macro that supplies one through `{`, a digraph or trigraph,
  // a directive in any spelling, or a module import. Each file shows exactly one of them.
  const decl = "char *strcpy(char *, const char *);\nvoid copy_name(char *d, const char *s)";
  const macro = "DEFINE_COPY(copy_name, strcpy(d, s))\n";
  const objc = {
    "nodirective.m": `${decl} { strcpy(d, s); }\n`,
    "hash.m": `#include "copy.h"\n${macro}`,
    "digraph_open.m": `${decl} <% strcpy(d, s); %>\n`,
    "digraph_directive.m": `%:include "copy.h"\n${macro}`,
    "trigraph_open.m": `${decl} ??< strcpy(d, s); ??>\n`,
    "trigraph_directive.m": `??=include "copy.h"\n${macro}`,
    "import.m": `@/**/import Copy;\n${macro}`,
    "splicedimport.m": `@imp\\\nort Copy;\n${macro}`,
    // A module import through a pragma operator needs no `@` (`__pragma` with MS extensions).
    "pragma_import.m": `_Pragma("clang module import Copy")\n${macro}`,
    "ms_pragma_import.m": `__pragma(clang module import Copy)\n${macro}`,
    // `.M` is Objective-C++ to clang and GCC: an initializer runs code without any mark.
    "Launcher.M": 'extern "C" int system(const char *);\nextern const char *startup_command;\nstatic int launched = system(startup_command);\n',
    // A UTF-8 character of two, three or four bytes may end an identifier right before `{`.
    "utf8_two.m": `${decl}\u00e9{ strcpy(d, s); }\n`,
    "utf8_three.m": `${decl}\u3043{ strcpy(d, s); }\n`,
    "utf8_four.m": `${decl}\u{2000b}{ strcpy(d, s); }\n`,
  };
  // `%:` reached through a line splice in every spelling: LF, CRLF, LF CR, CR, `??/`, and spaces before the end.
  for (const [name, splice] of [["lf", "\\\n"], ["crlf", "\\\r\n"], ["lfcr", "\\\n\r"], ["cr", "\\\r"], ["trigraph", "??/\n"],
    ["space", "\\ \t\f\v\n"]]) {
    objc[`spliced_${name}.m`] = `%${splice}:include "copy.h"\n${macro}`;
  }
  for (const [file, text] of Object.entries({ ...matlab, ...objc })) writeFileSync(join(root, file), text);
  assert.deepEqual(trackedSources(root).map(item => item.file).sort(), Object.keys(objc).sort());
  // A unit praesidium.json configures is Objective-C whatever it contains.
  writeFileSync(join(root, "praesidium.json"), JSON.stringify({ version: 1, native: [{ file: "plot_data.m", standard: "c17" }], web: [] }));
  assert.ok(trackedSources(root).some(item => item.file === "plot_data.m"));
  // The check reads raw bytes once: 2 MiB of near-misses stay linear.
  rmSync(join(root, "praesidium.json"));
  const units = [["a.m", "\\ \t"], ["b.m", "@ imports %; ??/ "], ["c.m", "%%< ?? @"], ["d.m", "\x96{\x81@ import "],
    ["e.m", "\\\n\x96?? \x80"]];
  for (const [file, unit] of units) {
    writeFileSync(join(root, file), Buffer.from(unit.repeat(Math.floor(2 * 1024 * 1024 / unit.length)), "latin1"));
  }
  writeFileSync(join(root, "f.m"), Buffer.concat([Buffer.alloc(2 * 1024 * 1024 - 2, 0x80), Buffer.from("{@")]));
  const started = performance.now();
  trackedSources(root);
  assert.ok(performance.now() - started < 1000);
});

test("a `{` or `@` only UTF-8 or a line splice can put in code keeps a .m that is not UTF-8", (t) => {
  const root = repository(t);
  // Kept files that are not UTF-8 make the inspection incomplete, as any undecodable source.
  const kept = (bytes) => {
    writeFileSync(join(root, "kept.m"), bytes);
    assert.throws(() => trackedSources(root), /not valid|encoded data/i);
    rmSync(join(root, "kept.m"));
  };
  const bytes = (...parts) => Buffer.concat(parts.map((part) => Buffer.from(part, "latin1")));
  // A Shift_JIS pair that happens to read as UTF-8 (E3 81 83 is a whole UTF-8 character).
  kept(bytes("% \x82 x \xe3\x81\x83{\nx = 1;\n"));
  kept(bytes("% \x82 \xe3\x81\x83@ import x\n"));
  // GCC decodes a character across a splice: `\xe3` + splice + `\x81\x83` is one, and the `{` code.
  for (const splice of ["\\\n", "\\\r\n", "\\\r", "??/\n", "\\ \t\n"]) {
    kept(bytes(`x\xe3${splice}\x81\x83{ strcpy(d, s); }\n`));
  }
  // Without the splice, after a plain line end, or as broken UTF-8, the same bytes hold no token.
  writeFileSync(join(root, "left.m"), bytes("x\xe3\x81\x81\x83{ strcpy(d, s); }\nx\xe3\n\x81\x83{\nx\xe3\xe3\x81{\nx\xe3\x81{\n"));
  assert.deepEqual(trackedSources(root), []);
});

test("a .m left out counts toward its own read limits, not the source limits", (t) => {
  const root = repository(t);
  const table = (rows) => `% generated lookup table\nT = [ ...\n${"0.25 0.5 0.75 1.0 ...\n".repeat(rows)}];\n`;
  // One table over 2 MiB, and tables over 32 MiB in all, are no sources and fit the .m limits.
  writeFileSync(join(root, "big.m"), table(130_000));
  mkdirSync(join(root, "tables"));
  for (let index = 0; index < 18; index += 1) writeFileSync(join(root, "tables", `t${index}.m`), table(90_000));
  writeFileSync(join(root, "a.c"), "int f(void) { return 0; }\n");
  assert.deepEqual(trackedSources(root).map(item => item.file), ["a.c"]);
  // A kept .m is a source, with the source limits.
  writeFileSync(join(root, "big.m"), `#include "x.h"\n${table(130_000)}`);
  assert.throws(() => trackedSources(root), /source size limit/);
  rmSync(join(root, "big.m"));
  // A .m over 64 MiB is not read at all, nor .m files beyond 256 MiB in all.
  const sparse = (file, size) => { writeFileSync(join(root, file), ""); truncateSync(join(root, file), size); };
  sparse("huge.m", 64 * 1024 * 1024 + 1);
  assert.throws(() => trackedSources(root), /source size limit/);
  rmSync(join(root, "huge.m"));
  rmSync(join(root, "tables"), { recursive: true });
  for (let index = 0; index < 5; index += 1) sparse(`zeros${index}.m`, 60 * 1024 * 1024);
  assert.throws(() => trackedSources(root), /source size limit/);
});

test("a praesidium.json edit puts the units it reconfigures into the reviewed scope", (t) => {
  const root = repository(t);
  const git = (...args) => execFileSync("git", ["-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", ...args],
    { cwd: root, windowsHide: true, encoding: "utf8" }).trim();
  const unit = (file, extra = {}) => ({ file, standard: "c++20", includes: ["include"], ...extra });
  for (const file of ["a.cpp", "b.cpp", "c.cpp"]) writeFileSync(join(root, file), "int f();\n");
  writeFileSync(join(root, "praesidium.json"), JSON.stringify({ version: 1, native: [unit("a.cpp"), unit("b.cpp")], web: [] }));
  git("add", "--all");
  git("commit", "--quiet", "-m", "base");
  const base = git("rev-parse", "HEAD");
  // Same entries reformatted with reordered keys, one entry changed, one added.
  const reordered = { includes: ["include"], standard: "c++20", file: "a.cpp" };
  writeFileSync(join(root, "praesidium.json"), JSON.stringify({ version: 1,
    native: [reordered, unit("b.cpp", { defines: ["X=1"] }), unit("c.cpp")], web: [] }, null, 4));
  assert.deepEqual(reviewedPaths(root, base).sort(), ["b.cpp", "c.cpp", "praesidium.json"]);
  // Dropping an entry (b.cpp) stops its analysis, so that PR analyzes the unit as well.
  assert.deepEqual(reconfiguredNativeUnits(root, base, [unit("a.cpp")]), ["b.cpp"]);
  // Deleting praesidium.json drops every unit its base copy declared.
  rmSync(join(root, "praesidium.json"));
  assert.deepEqual(reviewedPaths(root, base).sort(), ["a.cpp", "b.cpp"]);
  // A repository adopting Praesidium analyzes every unit it declares.
  const fresh = repository(t);
  execFileSync("git", ["-c", "user.name=f", "-c", "user.email=f@example.invalid", "commit", "--quiet", "--allow-empty", "-m", "base"], { cwd: fresh });
  assert.deepEqual(reconfiguredNativeUnits(fresh, "HEAD", [unit("x.cpp")]), ["x.cpp"]);
  assert.throws(() => reconfiguredNativeUnits(root, "--output=x", []));
});

test("a --repo below the Git top level scopes with paths relative to it", (t) => {
  const top = repository(t);
  const root = join(top, "pkg");
  mkdirSync(root);
  const git = (...args) => execFileSync("git", ["-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", ...args],
    { cwd: top, windowsHide: true, encoding: "utf8" }).trim();
  const config = (extra = {}) => JSON.stringify({ version: 1, native: [{ file: "a.cpp", standard: "c++20", ...extra }], web: [] });
  writeFileSync(join(root, "a.cpp"), "int f() { return 0; }\n");
  writeFileSync(join(root, "praesidium.json"), config());
  writeFileSync(join(top, "outside.cpp"), "int g();\n");
  git("add", "--all");
  git("commit", "--quiet", "-m", "base");
  const base = git("rev-parse", "HEAD");
  writeFileSync(join(root, "a.cpp"), "int f() { return 1; }\n");
  writeFileSync(join(top, "outside.cpp"), "int h();\n");
  // Paths match what trackedSources lists under the same root; changes outside it are not its own.
  assert.deepEqual(changedSourcePaths(root, base), ["a.cpp"]);
  assert.ok(trackedSources(root).some(item => item.file === "a.cpp"));
  git("checkout", "--quiet", "--", ".");
  // The base copy compared is the one beside the root, not the top level's.
  writeFileSync(join(root, "praesidium.json"), config({ defines: ["BAD=1"] }));
  assert.deepEqual(reviewedPaths(root, base).sort(), ["a.cpp", "praesidium.json"]);
});
