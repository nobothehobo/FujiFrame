import test from 'node:test';
import assert from 'node:assert/strict';
import {inflateSync} from 'node:zlib';
import {DEFAULTS,geometry,processPixels,parseCube,rafPreviewRange,bandedPng,crc32,validate} from '../engine.js';

test('neutral rendered source survives the mobile pipeline byte for byte',()=>{
  const source=new Uint8ClampedArray(256*4);for(let i=0;i<256;i++){source[i*4]=i;source[i*4+1]=255-i;source[i*4+2]=(i*61)%256;source[i*4+3]=255;}
  const output=processPixels(source.slice(),256,1,{});assert.deepEqual(output,source);
});
test('exposure is one stop in linear sRGB',()=>{
  const output=processPixels(new Uint8ClampedArray([80,80,80,255]),1,1,{exposure:1});
  const linear=((80/255+.055)/1.055)**2.4,expected=Math.round((1.055*(linear*2)**(1/2.4)-.055)*255);
  assert.ok(Math.abs(output[0]-expected)<=1);
});
test('crop rotation and size never upscale',()=>{
  assert.deepEqual(geometry(7728,5152,{quarter_turns:1,crop:[.25,.25,.5,.5]}),{width:2576,height:3864,cropX:1288,cropY:1932,cropW:2576,cropH:3864,rotW:5152,rotH:7728,scale:1,sourceW:7728,sourceH:5152,angle:Math.PI/2});
  assert.equal(geometry(300,200,{},2048).width,300);
  assert.equal(geometry(7728,5152,{},2048).width,2048);
});
test('band processing has the same masks grain and vignette as a whole image',()=>{
  const w=43,h=29,input=new Uint8ClampedArray(w*h*4);for(let i=0;i<input.length;i+=4)input.set([91,115,128,255],i);
  const e={grain:23,vignette:35,exposure:.1,masks:[{type:'linear',x:.4,y:.6,radius:.3,feather:.7,angle:75,exposure:.4,saturation:-12}]};
  const full=processPixels(input.slice(),w,h,e),bands=new Uint8ClampedArray(input.length);
  for(let y=0;y<h;y+=7){const rows=Math.min(7,h-y),part=processPixels(input.slice(y*w*4,(y+rows)*w*4),w,rows,e,{offsetY:y,fullWidth:w,fullHeight:h});bands.set(part,y*w*4);}
  assert.deepEqual(bands,full);
});
test('identity .cube LUT uses red-fastest ordering',()=>{
  const rows=['LUT_3D_SIZE 2'];for(const b of[0,1])for(const g of[0,1])for(const r of[0,1])rows.push(`${r} ${g} ${b}`);
  const parsed=parseCube(rows.join('\n')),source=new Uint8ClampedArray([61,117,209,255,199,21,85,255]);
  assert.deepEqual(processPixels(source.slice(),2,1,{lut_id:'identity'},{lut:parsed}),source);
});
test('gray pixels remain neutral in the red color mixer',()=>{
  const source=new Uint8ClampedArray([100,100,100,255]);assert.deepEqual(processPixels(source.slice(),1,1,{hsl:{red:{luminance:70,hue:50,saturation:80}}}),source);
});
test('RAF preview offset and size are validated before reading',()=>{
  const header=new ArrayBuffer(128);new Uint8Array(header).set(new TextEncoder().encode('FUJIFILMCCD-RAW '));const view=new DataView(header);view.setUint32(84,512);view.setUint32(88,2048);
  assert.deepEqual(rafPreviewRange(header,4096),{offset:512,length:2048});assert.throws(()=>rafPreviewRange(header,1000));assert.throws(()=>rafPreviewRange(new ArrayBuffer(20),4096));
});
test('bad crops, nonfinite edits, malformed curves and LUTs are rejected',()=>{
  for(const data of[{exposure:NaN},{exposure:10},{crop:[.99,0,.3,1]},{quarter_turns:.5},{curve:[[0,0],[0,.5],[1,1]]},{masks:[{type:'subject'}]}])assert.throws(()=>validate(data));
  assert.throws(()=>parseCube('LUT_3D_SIZE 2\n0 0 0'));assert.throws(()=>parseCube('LUT_1D_SIZE 3'));
});
test('PNG bands encode valid CRCs exact rows and an sRGB chunk',async()=>{
  const w=7,h=205,source=new Uint8Array(w*h*4);for(let p=0;p<source.length;p+=4)source.set([p%255,95,182,255],p);
  const blob=await bandedPng(w,h,async(y,rows)=>source.slice(y*w*4,(y+rows)*w*4));const bytes=new Uint8Array(await blob.arrayBuffer());
  assert.deepEqual([...bytes.slice(0,8)],[137,80,78,71,13,10,26,10]);let offset=8;const compressed=[];let hasSrgb=false;
  while(offset<bytes.length){const view=new DataView(bytes.buffer,offset),len=view.getUint32(0),name=new TextDecoder().decode(bytes.subarray(offset+4,offset+8));assert.equal(view.getUint32(len+8),crc32(bytes.subarray(offset+4,offset+8+len)));if(name==='IDAT')compressed.push(bytes.slice(offset+8,offset+8+len));if(name==='sRGB')hasSrgb=true;offset+=len+12;}
  assert.ok(hasSrgb);const inflated=inflateSync(Buffer.concat(compressed.map(b=>Buffer.from(b))));for(let y=0;y<h;y++){const off=y*(w*4+1);assert.equal(inflated[off],0);assert.deepEqual(new Uint8Array(inflated.subarray(off+1,off+1+w*4)),source.slice(y*w*4,(y+1)*w*4));}
});
test('PNG export surfaces canceled/incomplete bands rather than returning a partial file',async()=>{
  await assert.rejects(bandedPng(4,4,async()=>new Uint8Array(4)),/Incomplete/);
  await assert.rejects(bandedPng(4,4,async()=>{throw new Error('canceled');}),/canceled/);
});
