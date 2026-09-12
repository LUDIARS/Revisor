import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { readApprovalJson } from "../src/push-handoff-http.mjs";
import { requestHandoffApproval } from "../src/push-handoff-approval.mjs";

function transport() {
  const req = new EventEmitter();
  let destroyed = false;
  let callback;
  req.end = () => {};
  req.destroy = () => { destroyed = true; };
  return {
    requestImpl: (_url, _options, cb) => { callback = cb; return req; },
    destroyed: () => destroyed,
    respond(bytes, statusCode = 200) {
      const response = new EventEmitter();
      response.statusCode = statusCode;
      callback(response);
      if (bytes !== undefined) { response.emit("data", Buffer.from(bytes)); response.emit("end"); }
      return response;
    },
  };
}

test("approval headers can arrive after 326s; one deadline closes the socket", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const io = transport();
  const pending = readApprovalJson("http://127.0.0.1:11111/policy", {}, 660000, io);
  t.mock.timers.tick(326000);
  assert.equal(io.destroyed(), false);
  io.respond('{"allowed":true}');
  assert.deepEqual(await pending, { allowed: true });
  assert.equal(io.destroyed(), true);
});

test("approval header/body stalls expire and malformed responses reject", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const phase of ["headers", "body"]) {
    const io = transport();
    const pending = readApprovalJson("http://127.0.0.1:11111/policy", {}, 660000, io);
    const rejected = assert.rejects(pending, /deadline/);
    if (phase === "body") io.respond(undefined);
    t.mock.timers.tick(660000);
    await rejected;
    assert.equal(io.destroyed(), true);
  }
  for (const bytes of ["not json", Buffer.from([0xff]), Buffer.alloc(1048577)]) {
    const io = transport();
    const pending = readApprovalJson("http://127.0.0.1:11111/policy", {}, 660000, io);
    const rejected = assert.rejects(pending);
    io.respond(bytes);
    await rejected;
    assert.equal(io.destroyed(), true);
  }
});

test("ordinary workflow permission is not a WARNING approval", async () => {
  await assert.rejects(requestHandoffApproval({ endpoint: "http://127.0.0.1:11111/session",
    handoff: { cwd: "body", updates: [] }, remoteUrl: "https://github.com/LUDIARS/Product.git",
    read: async () => ({ allowed: true, reason: "GitHub Workflow; existing Git hooks still apply" }),
  }), /did not approve/);
});
