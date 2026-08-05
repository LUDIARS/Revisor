import { createHash } from "node:crypto";
import { tokenMatches } from "./auth.mjs";
import { isLoopbackAddress } from "./host-policy.mjs";
import { isAllowedHost } from "./ui-security.mjs";

const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const EVENT_PATH = "/v1/pr-events";
const SESSION_PROTOCOL_PREFIX = "revisor-session.";

function rejectUpgrade(socket, status, reason) {
  socket.end(
    `HTTP/1.1 ${status} ${reason}\r\n`
    + "Connection: close\r\n"
    + "Content-Length: 0\r\n\r\n",
  );
}

function originMatchesHost(origin, host) {
  try {
    return new URL(origin).host.toLowerCase() === String(host).toLowerCase();
  } catch {
    return false;
  }
}

function selectedProtocol(header, sessionToken) {
  const protocols = String(header ?? "").split(",").map((value) => value.trim());
  const candidate = protocols.find((value) => value.startsWith(SESSION_PROTOCOL_PREFIX));
  if (!candidate) return null;
  const supplied = candidate.slice(SESSION_PROTOCOL_PREFIX.length);
  return tokenMatches(sessionToken, supplied) ? candidate : null;
}

export function websocketAccept(key) {
  return createHash("sha1").update(`${key}${WEBSOCKET_GUID}`).digest("base64");
}

export function websocketFrame(value, opcode = 0x1) {
  const payload = Buffer.from(String(value), "utf8");
  if (payload.length <= 125) {
    return Buffer.concat([Buffer.from([0x80 | opcode, payload.length]), payload]);
  }
  if (payload.length <= 0xffff) {
    const head = Buffer.allocUnsafe(4);
    head[0] = 0x80 | opcode;
    head[1] = 126;
    head.writeUInt16BE(payload.length, 2);
    return Buffer.concat([head, payload]);
  }
  const head = Buffer.allocUnsafe(10);
  head[0] = 0x80 | opcode;
  head[1] = 127;
  head.writeBigUInt64BE(BigInt(payload.length), 2);
  return Buffer.concat([head, payload]);
}

export function attachPrWebSocket({
  server,
  eventStream,
  sessionToken,
  allowedHosts = () => [],
}) {
  const sockets = new Set();
  const unsubscribe = eventStream.subscribe((event) => {
    const frame = websocketFrame(JSON.stringify(event));
    for (const socket of sockets) {
      if (socket.destroyed || !socket.writable) {
        sockets.delete(socket);
        continue;
      }
      socket.write(frame);
    }
  });

  const onUpgrade = (request, socket) => {
    const host = request.headers.host ?? "";
    let url;
    try {
      url = new URL(request.url ?? "/", `http://${host || "localhost"}`);
    } catch {
      rejectUpgrade(socket, 400, "Bad Request");
      return;
    }
    if (url.pathname !== EVENT_PATH) {
      rejectUpgrade(socket, 404, "Not Found");
      return;
    }
    if (!isLoopbackAddress(request.socket?.remoteAddress)) {
      rejectUpgrade(socket, 403, "Forbidden");
      return;
    }
    let configuredHosts;
    try {
      configuredHosts = typeof allowedHosts === "function" ? allowedHosts() : allowedHosts;
    } catch {
      rejectUpgrade(socket, 503, "Service Unavailable");
      return;
    }
    if (
      !isAllowedHost(host, configuredHosts)
      || !originMatchesHost(request.headers.origin, host)
    ) {
      rejectUpgrade(socket, 403, "Forbidden");
      return;
    }
    const protocol = selectedProtocol(request.headers["sec-websocket-protocol"], sessionToken);
    const key = request.headers["sec-websocket-key"];
    let decodedKey;
    try {
      decodedKey = Buffer.from(String(key ?? ""), "base64");
    } catch {
      decodedKey = null;
    }
    if (
      request.method !== "GET"
      || String(request.headers.upgrade).toLowerCase() !== "websocket"
      || request.headers["sec-websocket-version"] !== "13"
      || decodedKey?.length !== 16
      || !protocol
    ) {
      rejectUpgrade(socket, 400, "Bad Request");
      return;
    }

    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n"
      + "Upgrade: websocket\r\n"
      + "Connection: Upgrade\r\n"
      + `Sec-WebSocket-Accept: ${websocketAccept(key)}\r\n`
      + `Sec-WebSocket-Protocol: ${protocol}\r\n\r\n`,
    );
    socket.setNoDelay(true);
    sockets.add(socket);
    const remove = () => sockets.delete(socket);
    socket.on("close", remove);
    socket.on("error", remove);
    socket.on("data", (chunk) => {
      if (chunk.length > 64 * 1024) {
        socket.destroy();
        return;
      }
      const opcode = chunk[0] & 0x0f;
      if (opcode === 0x8) socket.end(websocketFrame("", 0x8));
      if (opcode === 0x9) socket.write(websocketFrame("", 0xA));
    });
  };

  server.on("upgrade", onUpgrade);
  return {
    close() {
      server.off("upgrade", onUpgrade);
      unsubscribe();
      const closeFrame = websocketFrame("", 0x8);
      for (const socket of sockets) {
        if (!socket.destroyed) socket.end(closeFrame);
        socket.destroy();
      }
      sockets.clear();
    },
  };
}
