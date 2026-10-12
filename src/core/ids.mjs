// Prefixed ULIDs (`r_01J…`, `m_01J…`, `p_01J…`): sortable by creation time,
// 80 random bits, from the Web Crypto that Node and Workers both provide.

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** A ULID for `time` (epoch ms), with `random` filling 10 bytes. */
export function ulid(time = Date.now(), random = (bytes) => crypto.getRandomValues(bytes)) {
  if (!Number.isInteger(time) || time < 0 || time > 2 ** 48 - 1) throw new Error("A ULID needs a 48-bit time");
  let text = "";
  let remaining = time;
  for (let index = 0; index < 10; index += 1) {
    text = CROCKFORD[remaining % 32] + text;
    remaining = Math.floor(remaining / 32);
  }
  const bytes = random(new Uint8Array(10));
  // 80 bits as 16 base-32 characters, five bits at a time.
  let bits = 0;
  let value = 0;
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      text += CROCKFORD[(value >> (bits - 5)) & 31];
      bits -= 5;
    }
    value &= (1 << bits) - 1;
  }
  return text;
}

/** A new id with its kind's prefix: `newId("r")` is `r_01J…`. */
export function newId(prefix, time = Date.now(), random) {
  return `${prefix}_${ulid(time, random)}`;
}
