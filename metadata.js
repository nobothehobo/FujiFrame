// No external services. Copy supported metadata into standard PNG chunks.
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const signature = [137,80,78,71,13,10,26,10];
export function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let j = 0; j < 8; j++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
export function chunk(type, data) {
  const result = new Uint8Array(data.length + 12);
  const view = new DataView(result.buffer);
  view.setUint32(0, data.length);
  result.set(encoder.encode(type), 4); result.set(data, 8);
  view.setUint32(result.length - 4, crc32(result.subarray(4, result.length - 4)));
  return result;
}
export function pngChunks(bytes) {
  if (!signature.every((n, i) => bytes[i] === n)) throw new Error('Invalid PNG');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), result = [];
  for (let offset = 8; offset + 12 <= bytes.length;) {
    const length = view.getUint32(offset);
    if (offset + length + 12 > bytes.length) throw new Error('Truncated PNG');
    const type = decoder.decode(bytes.subarray(offset + 4, offset + 8));
    result.push({ type, data: bytes.slice(offset + 8, offset + 8 + length), raw: bytes.slice(offset, offset + length + 12) });
    offset += length + 12;
    if (type === 'IEND') return result;
  }
  throw new Error('Incomplete PNG');
}
export function extractMetadata(bytes) {
  const result = { exif: null, chunks: [], warnings: [] };
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let at = 2;
    while (at + 4 <= bytes.length && bytes[at] === 0xff) {
      const marker = bytes[at + 1];
      if (marker === 0xda || marker === 0xd9) break;
      if (marker === 0xff) { at++; continue; }
      const length = (bytes[at + 2] << 8) | bytes[at + 3];
      if (length < 2 || at + 2 + length > bytes.length) throw new Error('Truncated JPEG metadata');
      const data = bytes.subarray(at + 4, at + 2 + length);
      if (marker === 0xe1 && decoder.decode(data.subarray(0, 6)) === 'Exif\0\0') result.exif = data.slice(6);
      if (marker === 0xe1 && decoder.decode(data.subarray(0, 29)) === 'http://ns.adobe.com/xap/1.0/\0') {
        // Keep XMP verbatim; it may describe the original image dimensions.
        result.chunks.push(chunk('iTXt', new Uint8Array([...encoder.encode('XML:com.adobe.xmp'), 0,0,0,0,0, ...data.subarray(29)])));
      }
      if (marker === 0xed) result.warnings.push('Legacy IPTC/Photoshop metadata is not copied.');
      if (marker === 0xe1 && decoder.decode(data.subarray(0, 35)).startsWith('http://ns.adobe.com/xmp/extension/')) result.warnings.push('Extended XMP is not copied.');
      at += 2 + length;
    }
  } else if (bytes[0] === 137) {
    for (const part of pngChunks(bytes)) {
      if (part.type === 'eXIf') result.exif = part.data;
      if (['tEXt','zTXt','iTXt'].includes(part.type)) result.chunks.push(part.raw);
    }
  } else result.warnings.push('Metadata copying is supported for JPEG and PNG only.');
  return result;
}

export function normalizeExif(original, width, height) {
  // Preserve TIFF offsets, including Fujifilm MakerNotes. Never move data.
  const bytes = original.slice();
  const view = new DataView(bytes.buffer);
  const little = bytes[0] === 73 && bytes[1] === 73;
  if (!little && !(bytes[0] === 77 && bytes[1] === 77)) throw new Error('Invalid EXIF byte order');
  const u16 = at => view.getUint16(at, little), u32 = at => view.getUint32(at, little);
  if (u16(2) !== 42) throw new Error('Invalid EXIF TIFF header');
  const seen = new Set();
  function visit(offset, root = false) {
    if (!offset || seen.has(offset)) return;
    if (seen.size > 32 || offset + 2 > bytes.length) throw new Error('Invalid EXIF directory');
    seen.add(offset);
    const count = u16(offset), end = offset + 2 + count * 12;
    if (end + 4 > bytes.length) throw new Error('Truncated EXIF directory');
    for (let i = 0; i < count; i++) {
      const at = offset + 2 + i * 12, tag = u16(at), type = u16(at + 2), n = u32(at + 4);
      if (n === 1 && [3,4].includes(type)) {
        let value;
        if (tag === 0x112) value = 1; // Browser has already applied orientation.
        if ([0x100,0xa002].includes(tag)) value = width;
        if ([0x101,0xa003].includes(tag)) value = height;
        if (value !== undefined) {
          // Widen SHORT if needed; inline 4-byte slot is unchanged.
          if (type === 3 && value <= 65535) view.setUint16(at + 8, value, little);
          else { view.setUint16(at + 2, 4, little); view.setUint32(at + 8, value, little); }
        }
        if ([0x8769,0x8825,0xa005].includes(tag)) visit(u32(at + 8));
      }
    }
    if (root) {
      // Drop IFD1 thumbnail reference: it depicts the unframed original.
      view.setUint32(end, 0, little);
    }
  }
  visit(u32(4), true);
  return bytes;
}

export async function attachMetadata(blob, metadata, width, height) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const parts = pngChunks(bytes);
  const additions = [...metadata.chunks];
  if (metadata.exif) additions.unshift(chunk('eXIf', normalizeExif(metadata.exif, width, height)));
  return new Blob([bytes.subarray(0, 8), ...parts.flatMap(part => part.type === 'IHDR' ? [part.raw, ...additions] : [part.raw])], { type: 'image/png' });
}
