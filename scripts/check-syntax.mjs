#!/usr/bin/env node
// Parses every module under src/. Replaces the hand-maintained `node --check`
// chain, which silently stopped covering each new file someone forgot to add.
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runProcess } from "../src/process.mjs";
import { renderDashboardPage } from "../src/ui-dashboard-page.mjs";
import { renderSettingsPage } from "../src/ui-settings-page.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function modulePaths(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return modulePaths(path);
    return entry.name.endsWith(".mjs") ? [path] : [];
  });
}

// The browser-side code ships as a string, so nothing else in the toolchain ever
// parses it. Rendering each page and parsing the extracted script keeps a typo in
// the dashboard controller from reaching a running UI.
function clientScriptPaths(directory) {
  const pages = [
    ["dashboard-client.js", renderDashboardPage("check")],
    ["settings-client.js", renderSettingsPage("check")],
  ];
  return pages.map(([name, html]) => {
    const script = /<script nonce="check">([\s\S]*)<\/script>/.exec(html);
    if (!script) throw new Error(`${name}: rendered page exposed no script block`);
    const path = join(directory, name);
    writeFileSync(path, script[1], "utf8");
    return path;
  });
}

// The extracted client scripts live in a scratch directory that is removed even
// when a check throws, so a failing run does not leave the temp copies behind.
const scratch = mkdtempSync(join(tmpdir(), "revisor-check-"));
const failures = [];
let paths = [];
try {
  paths = [
    ...modulePaths(join(root, "src")),
    ...modulePaths(join(root, "scripts")),
    ...clientScriptPaths(scratch),
  ];
  for (const path of paths) {
    const result = await runProcess({
      command: process.execPath,
      args: ["--check", path],
      cwd: root,
      timeoutMs: 30_000,
    });
    if (!result.ok) failures.push(`${path}\n${result.stderr.trim()}`);
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

if (failures.length > 0) {
  process.stderr.write(`${failures.join("\n\n")}\n`);
  process.stderr.write(`${failures.length}/${paths.length} module(s) failed to parse.\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`${paths.length} module(s) parsed.\n`);
}
