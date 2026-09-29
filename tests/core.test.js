import test from 'node:test';
import assert from 'node:assert/strict';
import { layout } from '../framing.js';
import { normalizeExif, crc32, chunk, pngChunks, extractMetadata, attachMetadata } from '../metadata.js';
import { makeZip } from '../archive.js';
const base = { border: 6, ratio: 'square', bottom: false, resolution: 'full' };
test('mixed carousel uses one canvas without scaling or clipping either orientation', () => {
  const batch = [{width:7728,height:5152},{width:5152,height:7728}];
  for (const ratio of ['square','portrait','landscape']) {
    const frames = batch.map(image => layout(image.width,image.height,{...base,ratio},batch));
    assert.equal(frames[0].width,frames[1].width); assert.equal(frames[0].height,frames[1].height);
    frames.forEach((frame,i) => {
      assert.equal(frame.scale,1); assert.equal(frame.photoWidth,batch[i].width);
      assert.equal(frame.photoHeight,batch[i].height); assert.ok(Number.isInteger(frame.x)); assert.ok(Number.isInteger(frame.y));
      assert.ok(frame.x >= 0 && frame.y >= 0);
      assert.ok(frame.x+frame.photoWidth<=frame.width && frame.y+frame.photoHeight<=frame.height);
    });
  }
});
test('original mat and extra bottom, zero border, odd pixels, smaller copies', () => {
  assert.deepEqual(layout(100,60,{...base,ratio:'original',border:10,bottom:true}), {width:112,height:78,x:6,y:6,photoWidth:100,photoHeight:60,scale:1,pad:6});
  const odd = layout(101,60,{...base,border:0}); assert.ok(Number.isInteger(odd.y)); assert.equal(odd.photoWidth,101);
  assert.equal(layout(7728,5152,{...base,resolution:'social'}).width,1080);
  assert.equal(layout(100,60,{...base,resolution:'social'}).scale,1);
});
function exif() {
  const bytes = new Uint8Array(86), v = new DataView(bytes.buffer);
  bytes.set([73,73,42,0,8,0,0,0]); v.setUint16(8,3,true);
  for (const [i,tag,val] of [[0,0x112,6],[1,0x100,10],[2,0x101,20]]) {
    const at = 10+i*12; v.setUint16(at,tag,true); v.setUint16(at+2,3,true); v.setUint32(at+4,1,true); v.setUint16(at+8,val,true);
  }
  v.setUint32(46,50,true); // thumbnail pointer
  return bytes;
}
test('EXIF normalizes orientation, dimensions, thumbnail reference without mutating source', () => {
  const original = exif(), copy = normalizeExif(original,120,200), v = new DataView(copy.buffer);
  assert.equal(v.getUint16(18,true),1); assert.equal(v.getUint16(30,true),120); assert.equal(v.getUint16(42,true),200);
  assert.equal(v.getUint32(46,true),0); assert.equal(new DataView(original.buffer).getUint16(18,true),6);
});
test('EXIF errors are explicit', () => {
  assert.throws(()=>normalizeExif(new Uint8Array(8),100,100));
  const bad = exif(); new DataView(bad.buffer).setUint16(8,1000,true); assert.throws(()=>normalizeExif(bad,100,100));
});
test('PNG metadata insertion produces standard chunks; metadata can be absent', async () => {
  const signature = new Uint8Array([137,80,78,71,13,10,26,10]);
  const image = new Blob([signature,chunk('IHDR',new Uint8Array(13)),chunk('IDAT',new Uint8Array()),chunk('IEND',new Uint8Array())]);
  const out = await attachMetadata(image,{exif:exif(),chunks:[]},100,100);
  const bytes = new Uint8Array(await out.arrayBuffer());
  assert.deepEqual(pngChunks(bytes).map(p=>p.type),['IHDR','eXIf','IDAT','IEND']);
  assert.ok(extractMetadata(bytes).exif); assert.equal(extractMetadata(new Uint8Array(await image.arrayBuffer())).exif,null);
  assert.equal(crc32(new TextEncoder().encode('123456789')),0xcbf43926);
  assert.throws(()=>pngChunks(bytes.subarray(0,15)));
});
test('ZIP entries retain order, filenames, bytes and checksums', async () => {
  const files = [new File(['one'],'01_first.png'),new File(['two'],'02_second.png')];
  const bytes = new Uint8Array(await (await makeZip(files)).arrayBuffer()), v = new DataView(bytes.buffer);
  assert.equal(v.getUint32(0,true),0x04034b50);
  const nameLength = v.getUint16(26,true); assert.equal(new TextDecoder().decode(bytes.subarray(30,30+nameLength)),'01_first.png');
  assert.equal(new TextDecoder().decode(bytes.subarray(30+nameLength,33+nameLength)),'one');
  assert.equal(v.getUint16(bytes.length-14,true),2); assert.equal(v.getUint16(bytes.length-12,true),2);
});
