import { chunk } from './metadata.js';
import { paint } from './framing.js';

// Encode large photographs in narrow bands, avoiding mobile canvas area limits.
// CompressionStream uses zlib/deflate, the format required by PNG IDAT chunks.
export async function tiledPng(source, geometry, settings) {
  if (typeof CompressionStream !== 'function') throw new Error('This browser needs a smaller export or a desktop browser');
  const { width, height } = geometry;
  const header = new Uint8Array(13), view = new DataView(header.buffer);
  view.setUint32(0, width); view.setUint32(4, height); header[8] = 8; header[9] = 6; // RGBA8
  const compression = new CompressionStream('deflate'), writer = compression.writable.getWriter();
  const reader = compression.readable.getReader(), compressed = [];
  const drain = (async () => {
    for (;;) { const { value, done } = await reader.read(); if (done) break; compressed.push(chunk('IDAT', value)); }
  })();
  // Install a rejection handler immediately so a canceled stream cannot leak an unhandled rejection.
  drain.catch(() => {});
  const band = document.createElement('canvas');
  band.width = width;
  try {
    for (let y = 0; y < height; y += 128) {
      const rows = Math.min(128, height - y); band.height = rows;
      const ctx = band.getContext('2d', { colorSpace: 'srgb', willReadFrequently: true });
      if (!ctx) throw new Error('No canvas available');
      ctx.translate(0, -y); paint(ctx, source, geometry, settings);
      const pixels = ctx.getImageData(0, 0, width, rows).data;
      if (pixels[3] === 0) throw new Error('Canvas width exceeds this device’s limit');
      const rowBytes = width * 4, filtered = new Uint8Array((rowBytes + 1) * rows);
      for (let row = 0; row < rows; row++) filtered.set(pixels.subarray(row * rowBytes, (row + 1) * rowBytes), row * (rowBytes + 1) + 1);
      await writer.write(filtered);
      // Yield for paint and UI between bands instead of freezing a large export.
      if (y % 1024 === 0) await new Promise(resolve => setTimeout(resolve, 0));
    }
    await writer.close(); await drain;
    return new Blob([new Uint8Array([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('sRGB',new Uint8Array([0])),...compressed,chunk('IEND',new Uint8Array())], { type: 'image/png' });
  } catch (error) {
    await writer.abort(error).catch(() => {}); await drain.catch(() => {}); throw error;
  } finally { band.width = band.height = 1; }
}
