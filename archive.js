import { crc32 } from './metadata.js';
const encode = new TextEncoder();
export async function makeZip(files) {
  // Stored ZIP: PNGs are already compressed. Blob parts avoid a second huge copy.
  const parts = [], directory = []; let offset = 0;
  for (const file of files) {
    const name = encode.encode(file.name), data = new Uint8Array(await file.arrayBuffer());
    if (offset + data.length > 0xffffffff) throw new Error('Batch is too large for ZIP. Download individually.');
    const crc = crc32(data), local = new Uint8Array(30 + name.length), v = new DataView(local.buffer);
    v.setUint32(0, 0x04034b50, true); v.setUint16(4, 20, true); v.setUint16(6, 0x800, true);
    v.setUint16(12, 0x21, true); v.setUint32(14, crc, true); v.setUint32(18, data.length, true); v.setUint32(22, data.length, true);
    v.setUint16(26, name.length, true); local.set(name, 30);
    const central = new Uint8Array(46 + name.length), c = new DataView(central.buffer);
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x800, true);
    c.setUint16(14, 0x21, true); c.setUint32(16, crc, true); c.setUint32(20, data.length, true); c.setUint32(24, data.length, true);
    c.setUint16(28, name.length, true); c.setUint32(42, offset, true); central.set(name, 46);
    parts.push(local, file); directory.push(central); offset += local.length + data.length;
  }
  const size = directory.reduce((sum, item) => sum + item.length, 0), end = new Uint8Array(22), e = new DataView(end.buffer);
  e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true);
  e.setUint32(12, size, true); e.setUint32(16, offset, true);
  return new Blob([...parts, ...directory, end], { type: 'application/zip' });
}
