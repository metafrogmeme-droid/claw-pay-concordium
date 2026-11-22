/** Byte helpers: a strict little-endian reader, hex, and comparison. */

/** Thrown when bytes do not match the expected layout. */
export class DecodeError extends Error {
  override name = "DecodeError";
}

/**
 * Reads Concordium-serialized values: integers are little-endian. Every read
 * checks that enough bytes remain, and `finish` checks none are left over.
 */
export class ByteReader {
  readonly #bytes: Uint8Array;
  readonly #view: DataView;
  #offset = 0;

  constructor(bytes: Uint8Array) {
    this.#bytes = bytes;
    this.#view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  #need(n: number): void {
    if (this.#offset + n > this.#bytes.length) {
      throw new DecodeError(
        `need ${String(n)} more bytes at offset ${String(this.#offset)}, have ${String(this.#bytes.length - this.#offset)}`,
      );
    }
  }

  u8(): number {
    this.#need(1);
    const value = this.#view.getUint8(this.#offset);
    this.#offset += 1;
    return value;
  }

  u32(): number {
    this.#need(4);
    const value = this.#view.getUint32(this.#offset, true);
    this.#offset += 4;
    return value;
  }

  u64(): bigint {
    this.#need(8);
    const value = this.#view.getBigUint64(this.#offset, true);
    this.#offset += 8;
    return value;
  }

  bool(): boolean {
    const value = this.u8();
    if (value > 1) {
      throw new DecodeError(`invalid bool byte ${String(value)}`);
    }
    return value === 1;
  }

  bytes(n: number): Uint8Array {
    this.#need(n);
    const value = this.#bytes.slice(this.#offset, this.#offset + n);
    this.#offset += n;
    return value;
  }

  finish(): void {
    if (this.#offset !== this.#bytes.length) {
      throw new DecodeError(
        `${String(this.#bytes.length - this.#offset)} unexpected trailing bytes`,
      );
    }
  }
}

/** Little-endian u64 as 8 bytes. */
export function u64Bytes(value: bigint): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, value, true);
  return out;
}

const HEX_DIGITS = "0123456789abcdef";

/** Lowercase hex. Plain TypeScript, so it also runs in a browser. */
export function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) {
    out += (HEX_DIGITS[byte >> 4] ?? "") + (HEX_DIGITS[byte & 0x0f] ?? "");
  }
  return out;
}

/** Parse lowercase or uppercase hex with an even number of digits. */
export function fromHex(hex: string): Uint8Array {
  if (!/^(?:[0-9a-fA-F]{2})*$/.test(hex)) {
    throw new DecodeError("not a hex string with an even number of digits");
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  }
  return out;
}

export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
}

export function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
