import assert from "node:assert/strict";
import test from "node:test";
import { deliverRepositoryNotifications } from "../src/repository-notification.mjs";

test("uses fixture transports and isolates a failed notification", async () => {
  const result = await deliverRepositoryNotifications({
    targets: ["discord:release", "slack:deploy", "unknown:nope"],
    text: "notice",
    readSecret: (name) => `https://fixture/${name}`,
    discord: async () => true,
    slack: async () => { throw new Error("offline"); },
  });
  assert.deepEqual(result, [
    { target: "discord:release", sent: true },
    { target: "slack:deploy", sent: false },
  ]);
});
