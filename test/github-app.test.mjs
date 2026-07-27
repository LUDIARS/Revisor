import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import { createAppJwt, GitHubAppClient } from "../src/github-app.mjs";

function privateKey() {
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return pair.privateKey.export({ type: "pkcs8", format: "pem" });
}

test("signs a short-lived RS256 GitHub App JWT", () => {
  const now = Date.parse("2026-07-26T00:00:00Z");
  const jwt = createAppJwt({
    appId: "12345",
    privateKey: privateKey(),
    now: () => now,
  });
  const [encodedHeader, encodedPayload, signature] = jwt.split(".");
  const header = JSON.parse(Buffer.from(encodedHeader, "base64url").toString("utf8"));
  const payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"));
  assert.deepEqual(header, { alg: "RS256", typ: "JWT" });
  assert.equal(payload.iss, "12345");
  assert.equal(payload.iat, Math.floor(now / 1000) - 60);
  assert.equal(payload.exp - payload.iat, 600);
  assert.ok(signature.length > 100);
});

test("resolves and caches a repository installation token", async () => {
  const calls = [];
  const transport = async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith("/repos/LUDIARS/Revisor/installation")) {
      return new Response(JSON.stringify({ id: 42 }), { status: 200 });
    }
    if (url.endsWith("/app/installations/42/access_tokens")) {
      return new Response(JSON.stringify({
        token: "installation-token",
        expires_at: "2026-07-26T01:00:00Z",
      }), { status: 201 });
    }
    return new Response(JSON.stringify({ id: calls.length }), { status: 201 });
  };
  const client = new GitHubAppClient({
    appId: "12345",
    privateKey: privateKey(),
    transport,
    now: () => Date.parse("2026-07-26T00:00:00Z"),
  });
  await client.request(
    "LUDIARS/Revisor",
    "POST",
    "/repos/LUDIARS/Revisor/check-runs",
    { name: "Revisor review" },
  );
  await client.request(
    "LUDIARS/Revisor",
    "POST",
    "/repos/LUDIARS/Revisor/check-runs",
    { name: "Revisor review" },
  );
  assert.equal(
    calls.filter((call) => call.url.endsWith("/installation")).length,
    1,
  );
  assert.equal(
    calls.filter((call) => call.url.includes("/access_tokens")).length,
    1,
  );
  const checkCalls = calls.filter((call) => call.url.endsWith("/check-runs"));
  assert.equal(checkCalls.length, 2);
  assert.equal(checkCalls[0].options.headers.Authorization, "Bearer installation-token");
});
