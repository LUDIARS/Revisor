import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import { createAppJwt, GitHubAppClient } from "../src/github-app.mjs";

function privateKey() {
  return generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({
    type: "pkcs8",
    format: "pem",
  });
}

test("creates a bounded GitHub App JWT", () => {
  const jwt = createAppJwt({
    appId: "4436890",
    privateKey: privateKey(),
    now: () => 1_800_000_000_000,
  });
  const [, payload] = jwt.split(".");
  const value = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  assert.equal(value.iss, "4436890");
  assert.equal(value.exp - value.iat, 540);
});

test("requests a repository-scoped contents token and caches it", async () => {
  const requests = [];
  const transport = async (url, options) => {
    requests.push({ url, options });
    if (url.endsWith("/repos/LUDIARS/Revisor/installation")) {
      return new Response(JSON.stringify({
        id: 150113038,
        permissions: { contents: "write", workflows: "write" },
      }), { status: 200 });
    }
    return new Response(JSON.stringify({
      token: "test-installation-token",
      expires_at: "2027-01-01T01:00:00Z",
    }), { status: 201 });
  };
  const client = new GitHubAppClient({
    appId: "4436890",
    privateKey: privateKey(),
    transport,
    now: () => Date.parse("2027-01-01T00:00:00Z"),
  });
  assert.equal(await client.installationToken("LUDIARS/Revisor"), "test-installation-token");
  assert.equal(await client.installationToken("LUDIARS/Revisor"), "test-installation-token");
  assert.equal(requests.length, 2);
  assert.deepEqual(JSON.parse(requests[1].options.body), {
    repositories: ["Revisor"],
    permissions: { contents: "write", workflows: "write" },
  });
});
