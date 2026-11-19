import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeFixture } from "./fixture-cleanup.mjs";

export function modelRoleMap(t, roles) {
  const directory = mkdtempSync(join(tmpdir(), "revisor-model-roles-"));
  t.after(() => removeFixture(directory));
  const file = join(directory, "model-roles.json");
  writeFileSync(file, JSON.stringify({ schemaVersion: 1, roles }), "utf8");
  return file;
}

export function setModelTestEnv(t, values) {
  for (const [key, value] of Object.entries(values)) {
    const previous = process.env[key];
    t.after(() => {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    });
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}
