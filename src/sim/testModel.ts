/** Loading the real model in Node for the tests and benchmarks. */

/** The GLB without its textures (Node has no image decoder; the simulation only needs the geometry). */
export function untextured(buf: Buffer): ArrayBuffer {
  const jsonLen = buf.readUInt32LE(12);
  const json = JSON.parse(buf.subarray(20, 20 + jsonLen).toString("utf8"));
  delete json.images;
  delete json.textures;
  delete json.samplers;
  for (const m of json.materials ?? []) {
    for (const k of ["normalTexture", "occlusionTexture", "emissiveTexture"]) delete m[k];
    for (const k of ["baseColorTexture", "metallicRoughnessTexture"]) delete m.pbrMetallicRoughness?.[k];
  }
  const raw = Buffer.from(JSON.stringify(json), "utf8");
  const text = Buffer.concat([raw, Buffer.alloc((4 - (raw.length % 4)) % 4, 0x20)]);
  const rest = buf.subarray(20 + jsonLen);
  const head = Buffer.alloc(20);
  head.writeUInt32LE(0x46546c67, 0);
  head.writeUInt32LE(2, 4);
  head.writeUInt32LE(20 + text.length + rest.length, 8);
  head.writeUInt32LE(text.length, 12);
  head.writeUInt32LE(0x4e4f534a, 16);
  const out = Buffer.concat([head, text, rest]);
  return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength);
}
