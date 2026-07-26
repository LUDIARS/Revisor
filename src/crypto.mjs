import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from "node:crypto";

function deriveKey(masterSecret, salt) {
  return scryptSync(masterSecret, salt, 32);
}

export function encryptString(value, masterSecret) {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", deriveKey(masterSecret, salt), iv);
  const encrypted = Buffer.concat([
    cipher.update(Buffer.from(JSON.stringify(value), "utf8")),
    cipher.final(),
  ]);
  return {
    version: 1,
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: encrypted.toString("base64"),
  };
}

export function decryptString(blob, masterSecret) {
  if (!isEncryptedBlob(blob)) throw new TypeError("Invalid encrypted config blob.");
  const decipher = createDecipheriv(
    "aes-256-gcm",
    deriveKey(masterSecret, Buffer.from(blob.salt, "base64")),
    Buffer.from(blob.iv, "base64"),
  );
  decipher.setAuthTag(Buffer.from(blob.tag, "base64"));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(blob.data, "base64")),
    decipher.final(),
  ]);
  const value = JSON.parse(decrypted.toString("utf8"));
  if (typeof value !== "string") throw new TypeError("Encrypted value is not a string.");
  return value;
}

export function isEncryptedBlob(value) {
  return Boolean(
    value
      && typeof value === "object"
      && value.version === 1
      && typeof value.salt === "string"
      && typeof value.iv === "string"
      && typeof value.tag === "string"
      && typeof value.data === "string",
  );
}
