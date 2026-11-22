/** Test-only helpers for this package. */

/** A tiny versioned module: version 1 (u32 BE), length (u32 BE), then the bytes. */
export function fakeModule(body = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0])): Uint8Array {
  const out = new Uint8Array(8 + body.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, 1);
  view.setUint32(4, body.length);
  out.set(body, 8);
  return out;
}
