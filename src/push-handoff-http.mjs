// @implements spec/feature/approved-push-handoff.md — bounded loopback approval transport
import { request } from "node:http";

/** One absolute deadline, including headers; fetch's 300s header limit is too short. */
export function readApprovalJson(address, body, timeoutMs = 660000, { requestImpl = request } = {}) {
  const url = new URL(address);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.username || url.password) {
    throw new Error("Approval transport requires plain loopback HTTP");
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 660000) throw new Error("Invalid approval deadline");
  return new Promise((resolve, reject) => {
    let timer;
    let req;
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req?.destroy();
      if (error) reject(error); else resolve(value);
    };
    try {
      req = requestImpl(url, { method: body ? "POST" : "GET", agent: false,
        headers: { "content-type": "application/json" } }, (response) => {
        response.on("error", (error) => finish(error));
        response.on("aborted", () => finish(new Error("Approval response aborted")));
        if (response.statusCode !== 200) { finish(new Error(`Approval HTTP ${response.statusCode}`)); return; }
        const chunks = [];
        let size = 0;
        response.on("data", (chunk) => {
          if (settled) return;
          size += chunk.length;
          if (size > 1048576) { finish(new Error("Approval response too large")); return; }
          chunks.push(chunk);
        });
        response.on("end", () => {
          if (settled) return;
          try { finish(null, JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)))); }
          catch { finish(new Error("Invalid approval JSON")); }
        });
      });
      req.on("error", (error) => finish(error));
      timer = setTimeout(() => finish(new Error("Approval deadline exceeded")), timeoutMs);
      req.end(body ? JSON.stringify(body) : undefined);
    } catch (error) { finish(error); }
  });
}
