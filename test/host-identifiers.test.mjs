import assert from "node:assert/strict";
import test from "node:test";
import {
  containsLocalPath,
  containsPrivateIp,
  enabledBuiltinDetectors,
  normalizeCategoryModes,
} from "../src/host-identifiers.mjs";

// 値はすべて架空で、 しかも組み立てて作る。 ソースに直書きすると、 この検査自体が
// このリポジトリの差分に反応する。
const ip = (...octets) => octets.join(".");
const drive = (letter, ...segments) => `${letter}:${String.fromCharCode(92)}${segments.join(String.fromCharCode(92))}`;
const slashDrive = (letter, ...segments) => `${letter}:/${segments.join("/")}`;
const home = (root, name, rest = "notes") => `/${root}/${name}/${rest}`;

test("finds concrete private, Tailscale and link-local host addresses", () => {
  assert.equal(containsPrivateIp(`host ${ip(10, 1, 2, 3)}`), true);
  assert.equal(containsPrivateIp(`ssh x@${ip(172, 20, 0, 9)}:22`), true);
  assert.equal(containsPrivateIp(`lan=${ip(192, 168, 7, 42)}`), true);
  assert.equal(containsPrivateIp(`tailnet ${ip(100, 99, 1, 2)}.`), true);
  assert.equal(containsPrivateIp(`link ${ip(169, 254, 3, 4)}`), true);
});

test("ignores loopback, unspecified, documentation, public and CIDR ranges", () => {
  assert.equal(containsPrivateIp(ip(127, 0, 0, 1)), false);
  assert.equal(containsPrivateIp(ip(0, 0, 0, 0)), false);
  assert.equal(containsPrivateIp(ip(192, 0, 2, 10)), false);
  assert.equal(containsPrivateIp(ip(203, 0, 113, 5)), false);
  assert.equal(containsPrivateIp(ip(8, 8, 8, 8)), false);
  assert.equal(containsPrivateIp(ip(172, 32, 0, 1)), false, "outside 172.16/12");
  assert.equal(containsPrivateIp(ip(100, 128, 0, 1)), false, "outside 100.64/10");
  assert.equal(containsPrivateIp(`${ip(10, 0, 0, 0)}/8`), false);
  assert.equal(containsPrivateIp(`${ip(192, 168, 1, 7)}/24`), false);
  assert.equal(containsPrivateIp(ip(192, 168, 1, 255)), false, "broadcast is not a host");
  assert.equal(containsPrivateIp(`v${ip(10, 2, 3, 4)}.5`), false, "longer dotted version");
  assert.equal(containsPrivateIp(ip(10, 300, 1, 1)), false);
});

test("finds Windows drive paths and POSIX home directories", () => {
  assert.equal(containsLocalPath(`cd ${slashDrive("E", "Work", "repo")}`), true);
  assert.equal(containsLocalPath(`"${drive("C", "Users", "someone", "file.txt")}"`), true);
  assert.equal(containsLocalPath(`open ${drive("D", "data")}`), true);
  assert.equal(containsLocalPath(`log at ${home("Users", "someone")}`), true);
  assert.equal(containsLocalPath(`(${home("home", "builder")})`), true);
});

test("ignores placeholders, variables, home shorthand and URLs", () => {
  assert.equal(containsLocalPath(drive("C", "Users", "<name>", "x")), false);
  assert.equal(containsLocalPath(slashDrive("C", "Users", "${USER}")), false);
  assert.equal(containsLocalPath(drive("C", "<path>")), false);
  assert.equal(containsLocalPath("%USERPROFILE%/x"), false);
  assert.equal(containsLocalPath("~/projects/x"), false);
  assert.equal(containsLocalPath(home("Users", "<name>")), false);
  assert.equal(containsLocalPath(home("home", "$USER")), false);
  assert.equal(containsLocalPath(`https://example.com${home("Users", "someone")}`), false);
  assert.equal(containsLocalPath("relative/home/x/y"), false);
  assert.equal(containsLocalPath("const re = /[a-z]:/;"), false);
});

test("category modes default to advisory and reject unknown names", () => {
  const modes = normalizeCategoryModes(undefined);
  assert.equal(modes["private-ip"], "advisory");
  assert.equal(modes["site-name"], "advisory");
  assert.equal(normalizeCategoryModes({ "local-path": "enforce" })["local-path"], "enforce");
  assert.equal(normalizeCategoryModes({ "local-path": { mode: "off" } })["local-path"], "off");
  assert.throws(() => normalizeCategoryModes({ "privat-ip": "advisory" }), /unknown category/);
  assert.throws(() => normalizeCategoryModes({ "private-ip": "block" }), /advisory, enforce, or off/);
  assert.throws(() => normalizeCategoryModes([]), /must be an object/);
  assert.deepEqual(enabledBuiltinDetectors({ "private-ip": "off" }).map((detector) => detector.id), ["local-path"]);
});
