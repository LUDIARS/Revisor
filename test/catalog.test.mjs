import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  readInjectedServicePort,
  readServicePort,
  resolveManagedServicePort,
} from "../src/catalog.mjs";

const FRAGMENT = readFileSync(
  new URL("../excubitor.catalog.yaml", import.meta.url),
  "utf8",
);

test("reads Revisor and Concordia ports from the Excubitor catalog", () => {
  const catalog = [
    "services:",
    "  - code: revisor",
    "    port: 4240",
    "  - code: concordia",
    "    port: 11111",
    "",
  ].join("\n");
  assert.equal(readServicePort(catalog, "revisor"), 4240);
  assert.equal(readServicePort(catalog, "concordia"), 11111);
});

// Revisor's fragment uses the same service block format as the central catalog.
// Keep that contract readable by the existing parser without assigning the
// operational catalog or this test helper to an application domain.
test("the shipped catalog fragment is readable by Revisor's own catalog parser", () => {
  assert.equal(readServicePort(FRAGMENT, "revisor"), 4240);
});

// The health check is what Excubitor restarts the service on, so it has to point
// at the port the fragment declares, on the address `startRevisor` binds (IPv4
// loopback only — `localhost` may resolve to ::1 and never reach the listener).
test("the catalog fragment health check targets the declared port on IPv4 loopback", () => {
  const url = FRAGMENT.match(/^      url:\s*(\S+)\s*$/m)?.[1];
  assert.equal(url, `http://127.0.0.1:${readServicePort(FRAGMENT, "revisor")}/health`);
});

// `provides` is what other services resolve Revisor through, and `startRevisor`
// binds IPv4 loopback only — a host placeholder here would publish an address
// nothing listens on and that the UI host policy rejects anyway.
test("the catalog fragment publishes Revisor on IPv4 loopback", () => {
  const url = FRAGMENT.match(/^      REVISOR_URL:\s*(\S+)\s*$/m)?.[1];
  assert.equal(url, "http://127.0.0.1:${port}");
});

test("rejects missing service registration", () => {
  assert.throws(
    () => readServicePort("services:\n", "revisor"),
    /not registered/,
  );
});

// A workspace whose central catalog declares a port distinct from the injected
// one, so each resolution order below names which source it actually used.
async function withCentralCatalog(port, run) {
  const workspace = await mkdtemp(join(tmpdir(), "revisor-catalog-"));
  try {
    const repo = join(workspace, "Revisor");
    await mkdir(join(workspace, "Excubitor", "catalog"), { recursive: true });
    await mkdir(repo, { recursive: true });
    await writeFile(
      join(workspace, "Excubitor", "catalog", "services.yaml"),
      `services:\n  - code: revisor\n    port: ${port}\n`,
    );
    await run(repo);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

test("uses the port Excubitor injects from its aggregated catalog", async () => {
  assert.equal(readInjectedServicePort({ REVISOR_PORT: "4240" }, "revisor"), 4240);
  await withCentralCatalog(4241, (repo) => {
    assert.equal(resolveManagedServicePort(repo, { REVISOR_PORT: "4240" }), 4240);
  });
});

// Direct CLI launches get no injected port, so the central catalog stays the
// compatibility path for them.
test("falls back to the central catalog when no port is injected", async () => {
  await withCentralCatalog(4241, (repo) => {
    assert.equal(resolveManagedServicePort(repo, {}), 4241);
  });
});

test("rejects an invalid injected port instead of falling back silently", () => {
  for (const value of ["", "0", "65536", "42.4", "not-a-port"]) {
    assert.throws(
      () => readInjectedServicePort({ REVISOR_PORT: value }, "revisor"),
      /invalid REVISOR_PORT/,
    );
  }
});
