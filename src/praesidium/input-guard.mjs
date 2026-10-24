/** @implements RV-PRAESIDIUM-02 — validate the raw request target before router normalization. */
import { compileFields, plainObject } from "./input-schema.mjs";

const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);
function decode(value) {
  const decoded = decodeURIComponent(value);
  if (/[\u0000-\u001f\u007f]/.test(decoded)) throw new Error("control character");
  return decoded;
}
function segments(path) {
  if (!path.startsWith("/") || path.includes("\\") || path.includes("#")) throw new Error("invalid target");
  return path.slice(1).split("/").map((part) => {
    const value = decode(part);
    if ([".", ".."].includes(value) || /[%/\\]/.test(value)) throw new Error("ambiguous path");
    return value;
  });
}

function parseBody(text) {
  // JSON.parse discards duplicate keys. Reject them before that ambiguity is lost.
  // Contracts deliberately accept only a flat object of scalar fields.
  const keys = new Set();
  for (const token of text.matchAll(/"(?:\\[\s\S]|[^"\\])*"/g)) {
    if (!/^\s*:/.test(text.slice(token.index + token[0].length))) continue;
    const key = JSON.parse(token[0]);
    if (keys.has(key)) throw new Error("duplicate JSON property");
    keys.add(key);
  }
  return JSON.parse(text);
}

export function compileRouteGuard(contract) {
  if (!plainObject(contract) || !METHODS.has(contract.method) || typeof contract.path !== "string"
      || !Number.isInteger(contract.maxBodyBytes) || contract.maxBodyBytes < 0 || contract.maxBodyBytes > 1_048_576
      || Object.keys(contract).some(key => !["method", "path", "params", "query", "body", "maxBodyBytes"].includes(key))) throw new Error("invalid route contract");
  const route = segments(contract.path);
  const params = compileFields(contract.params), query = compileFields(contract.query), body = compileFields(contract.body);
  const parameterNames = route.filter(part => part.startsWith(":" )).map(part => part.slice(1));
  if (new Set(parameterNames).size !== parameterNames.length
      || parameterNames.some(name => !Object.hasOwn(contract.params ?? {}, name))
      || Object.keys(contract.params ?? {}).some(name => !parameterNames.includes(name))) throw new Error("route parameter mismatch");
  const method = contract.method, maxBodyBytes = contract.maxBodyBytes;
  return (request) => {
    const reject = (status, reason) => ({ ok: false, status, reason });
    if (!request || request.method !== method) return reject(405, "method");
    if (typeof request.target !== "string" || request.target.length > 4096) return reject(414, "target-size");
    const text = request.bodyText ?? "";
    if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > maxBodyBytes) return reject(413, "body-size");
    try {
      const split = request.target.indexOf("?");
      const path = split < 0 ? request.target : request.target.slice(0, split);
      const actual = segments(path);
      if (actual.length !== route.length) return reject(404, "route");
      const rawParams = Object.create(null), rawQuery = Object.create(null);
      for (let i = 0; i < route.length; i++) {
        if (route[i].startsWith(":")) {
          if (!actual[i]) return reject(404, "empty-parameter");
          rawParams[route[i].slice(1)] = actual[i];
        }
        else if (route[i] !== actual[i]) return reject(404, "route");
      }
      const queryText = split < 0 ? "" : request.target.slice(split + 1);
      if (queryText.includes("#")) return reject(400, "fragment");
      for (const pair of queryText ? queryText.split("&") : []) {
        const equals = pair.indexOf("=");
        const key = decode((equals < 0 ? pair : pair.slice(0, equals)).replace(/\+/g, " "));
        const value = decode((equals < 0 ? "" : pair.slice(equals + 1)).replace(/\+/g, " "));
        if (Object.hasOwn(rawQuery, key)) return reject(400, "duplicate-query");
        rawQuery[key] = value;
      }
      if (text && !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.contentType ?? "")) return reject(415, "content-type");
      const checkedParams = params(rawParams, true), checkedQuery = query(rawQuery, true);
      const checkedBody = body(text ? parseBody(text) : {});
      if (!checkedParams || !checkedQuery || !checkedBody) return reject(400, "schema");
      return { ok: true, status: 200, params: checkedParams, query: checkedQuery, body: checkedBody };
    } catch { return reject(400, "malformed-input"); }
  };
}
