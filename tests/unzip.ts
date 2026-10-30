/** Read the central directory of a STORE zip. */
export function unzipNames(bytes: Uint8Array): { name: string; data: Uint8Array }[] {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= 0; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('no EOCD');
  const count = dv.getUint16(eocd + 10, true);
  let pos = dv.getUint32(eocd + 16, true);
  const out: { name: string; data: Uint8Array }[] = [];
  for (let i = 0; i < count; i++) {
    if (dv.getUint32(pos, true) !== 0x02014b50) throw new Error('bad central header');
    const size = dv.getUint32(pos + 20, true);
    const nameLen = dv.getUint16(pos + 28, true);
    const extra = dv.getUint16(pos + 30, true);
    const comment = dv.getUint16(pos + 32, true);
    const local = dv.getUint32(pos + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(pos + 46, pos + 46 + nameLen));
    if (dv.getUint32(local, true) !== 0x04034b50) throw new Error('bad local header');
    const lName = dv.getUint16(local + 26, true);
    const lExtra = dv.getUint16(local + 28, true);
    const start = local + 30 + lName + lExtra;
    out.push({ name, data: bytes.subarray(start, start + size) });
    pos += 46 + nameLen + extra + comment;
  }
  return out;
}
