import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { PrEventStream } from "../src/pr-event-stream.mjs";
import {
  attachPrWebSocket,
  websocketAccept,
  websocketFrame,
} from "../src/pr-websocket.mjs";

class FakeSocket extends EventEmitter {
  constructor() {
    super();
    this.destroyed = false;
    this.writable = true;
    this.writes = [];
  }

  write(value) {
    this.writes.push(value);
  }

  end(value) {
    if (value) this.writes.push(value);
    this.writable = false;
  }

  destroy() {
    this.destroyed = true;
    this.writable = false;
  }

  setNoDelay() {}
}

function upgradeRequest(overrides = {}) {
  return {
    method: "GET",
    url: "/v1/pr-events",
    socket: { remoteAddress: "127.0.0.1" },
    headers: {
      host: "127.0.0.1:4240",
      origin: "http://127.0.0.1:4240",
      upgrade: "websocket",
      "sec-websocket-version": "13",
      "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
      "sec-websocket-protocol": "revisor-session.session-token",
      ...overrides,
    },
  };
}

test("uses the RFC 6455 accept value and frames UTF-8 status events", () => {
  assert.equal(
    websocketAccept("dGhlIHNhbXBsZSBub25jZQ=="),
    "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=",
  );
  const frame = websocketFrame("更新");
  assert.equal(frame[0], 0x81);
  assert.equal(frame[1], Buffer.byteLength("更新"));
  assert.equal(frame.subarray(2).toString("utf8"), "更新");
});

test("broadcasts identifier-only PR invalidations to an authenticated UI socket", () => {
  const server = new EventEmitter();
  const eventStream = new PrEventStream();
  const hub = attachPrWebSocket({
    server,
    eventStream,
    sessionToken: "session-token",
  });
  const socket = new FakeSocket();
  server.emit("upgrade", upgradeRequest(), socket);
  assert.match(String(socket.writes[0]), /101 Switching Protocols/);

  eventStream.publish({
    type: "pull_request.updated",
    pullRequestId: "pr-1",
    number: 1,
    status: "open",
    checkStatus: "test_ok",
  });
  const payloadFrame = socket.writes.at(-1);
  assert.equal(Buffer.isBuffer(payloadFrame), true);
  assert.match(payloadFrame.toString("utf8"), /pull_request\.updated/);
  assert.doesNotMatch(payloadFrame.toString("utf8"), /review output/);
  hub.close();
  assert.equal(socket.destroyed, true);
});

test("rejects a WebSocket whose Origin does not match its allowed Host", () => {
  const server = new EventEmitter();
  const hub = attachPrWebSocket({
    server,
    eventStream: new PrEventStream(),
    sessionToken: "session-token",
  });
  const socket = new FakeSocket();
  server.emit("upgrade", upgradeRequest({ origin: "https://attacker.example" }), socket);
  assert.match(String(socket.writes[0]), /403 Forbidden/);
  hub.close();
});

test("one event listener failure does not block the remaining listeners", () => {
  const stream = new PrEventStream();
  const received = [];
  stream.subscribe(() => { throw new Error("disconnected"); });
  const unsubscribe = stream.subscribe((event) => received.push(event));
  stream.publish({ type: "pull_request.updated", pullRequestId: "pr-1" });
  unsubscribe();
  stream.publish({ type: "pull_request.updated", pullRequestId: "pr-2" });
  assert.deepEqual(received.map((event) => event.pullRequestId), ["pr-1"]);
});
