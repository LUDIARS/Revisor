/** @implements RV-PRAESIDIUM-02 — compile finite allowlists once, validate at ingress. */
const forbidden = new Set(["__proto__", "prototype", "constructor"]);
const formats = {
  slug: /^[A-Za-z0-9_-]+$/,
  uuid: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
};
export function plainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

export function compileFields(fields = {}) {
  if (!plainObject(fields) || Object.keys(fields).length > 64) throw new Error("invalid fields");
  const compiled = Object.entries(fields).map(([name, rule]) => {
    if (forbidden.has(name) || !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name) || !plainObject(rule)
        || !["string", "integer", "boolean"].includes(rule.type)
        || Object.keys(rule).some((key) => !["type", "required", "maxLength", "min", "max", "enum", "format"].includes(key))
        || (rule.required !== undefined && typeof rule.required !== "boolean")) throw new Error("invalid field rule");
    if (rule.type === "string" && (!Number.isInteger(rule.maxLength) || rule.maxLength < 1 || rule.maxLength > 65_536)) throw new Error("string maxLength required");
    if (rule.type === "integer" && (!Number.isSafeInteger(rule.min) || !Number.isSafeInteger(rule.max) || rule.min > rule.max)) throw new Error("integer bounds required");
    if (rule.format !== undefined && (rule.type !== "string" || !Object.hasOwn(formats, rule.format))) throw new Error("unknown format");
    if (rule.enum !== undefined && (!Array.isArray(rule.enum) || !rule.enum.length || rule.enum.length > 256
        || rule.enum.some((value) => typeof value !== (rule.type === "integer" ? "number" : rule.type)))) throw new Error("invalid enum");
    return { name, ...rule, enum: rule.enum ? new Set(rule.enum) : null };
  });
  const names = new Set(compiled.map((rule) => rule.name));
  return (value, fromUrl = false) => {
    if (!plainObject(value) || Object.keys(value).some((key) => !names.has(key))) return null;
    const output = Object.create(null);
    for (const rule of compiled) {
      if (!Object.hasOwn(value, rule.name)) { if (rule.required) return null; continue; }
      let entry = value[rule.name];
      if (fromUrl && rule.type === "integer" && typeof entry === "string" && /^-?(?:0|[1-9][0-9]*)$/.test(entry)) entry = Number(entry);
      if (fromUrl && rule.type === "boolean" && ["true", "false"].includes(entry)) entry = entry === "true";
      if (rule.type === "integer" && (!Number.isSafeInteger(entry) || entry < rule.min || entry > rule.max)) return null;
      if (rule.type === "boolean" && typeof entry !== "boolean") return null;
      if (rule.type === "string" && (typeof entry !== "string" || entry.length > rule.maxLength
          || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(entry)
          || (rule.format && !formats[rule.format].test(entry)))) return null;
      if (rule.enum && !rule.enum.has(entry)) return null;
      output[rule.name] = entry;
    }
    return output;
  };
}
