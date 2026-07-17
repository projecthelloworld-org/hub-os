import { createHash } from "node:crypto";

const HUBOS_NAMESPACE = "1b8ae8c0-9074-4ecb-9c93-b27e6bd2cf2d";

function uuidBytes(uuid) {
  const compact = uuid.replaceAll("-", "");
  return Uint8Array.from(compact.match(/.{2}/g).map((byte) => Number.parseInt(byte, 16)));
}

function formatUuid(bytes) {
  const hex = Buffer.from(bytes).toString("hex");
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join("-");
}

export function stableId(kind, value, namespace = HUBOS_NAMESPACE) {
  const hash = createHash("sha1")
    .update(uuidBytes(namespace))
    .update(`${kind}:${value}`, "utf8")
    .digest();
  hash[6] = (hash[6] & 0x0f) | 0x50;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  return formatUuid(hash.subarray(0, 16));
}

export function randomId() {
  return crypto.randomUUID();
}
