// Optional integration test: NODE_PATH=<modules directory> node tests/render-smoke.cjs
const { createCanvas } = require('@napi-rs/canvas');
const sharp = require('sharp');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
(async () => {
  const { layout, paint } = await import('../framing.js');
  const { tiledPng } = await import('../png-export.js');
  const { makeZip } = await import('../archive.js');
  global.document = { createElement: () => createCanvas(1,1) };
  const opts = {border:6,ratio:'square',bottom:false,resolution:'full',paper:'#ffffff',watermark:'',font:'serif',textSize:2,opacity:70,ink:'#333333',placement:'mat',corner:'bottom-right'};
  const source = createCanvas(101,60), ctx = source.getContext('2d');
  for(let x=0;x<101;x++){ctx.fillStyle=`rgb(${x*2},100,150)`;ctx.fillRect(x,0,1,60);}
  const g=layout(101,60,opts), target=createCanvas(g.width,g.height);
  paint(target.getContext('2d'),source,g,opts);
  const tile=Buffer.from(await (await tiledPng(source,g,opts)).arrayBuffer());
  const normal=await sharp(target.toBuffer('image/png')).raw().toBuffer();
  assert.deepEqual(await sharp(tile).raw().toBuffer(),normal,'Band PNG must match ordinary canvas pixels exactly');
  const rawSource=await sharp(source.toBuffer('image/png')).removeAlpha().raw().toBuffer();
  assert.deepEqual(await sharp(tile).extract({left:g.x,top:g.y,width:101,height:60}).removeAlpha().raw().toBuffer(),rawSource);
  // Force text across band boundaries and compare all decoded output pixels.
  const tall=createCanvas(230,470), tallCtx=tall.getContext('2d');tallCtx.fillStyle='#38574a';tallCtx.fillRect(0,0,230,470);
  const wm={...opts,ratio:'original',watermark:'Noah Payne',placement:'photo',corner:'bottom-right',textSize:5};
  const tg=layout(230,470,wm), tc=createCanvas(tg.width,tg.height);paint(tc.getContext('2d'),tall,tg,wm);
  assert.deepEqual(await sharp(Buffer.from(await (await tiledPng(tall,tg,wm)).arrayBuffer())).raw().toBuffer(),await sharp(tc.toBuffer('image/png')).raw().toBuffer());
  const large=createCanvas(7728,5152), largeCtx=large.getContext('2d');largeCtx.fillStyle='#a9c4b0';largeCtx.fillRect(0,0,7728,5152);
  const lg=layout(7728,5152,{...opts,ratio:'original'});
  const full=await tiledPng(large,lg,{...opts,ratio:'original'}), data=Buffer.from(await full.arrayBuffer()), metadata=await sharp(data).metadata();
  assert.equal(metadata.width,8346);assert.equal(metadata.height,5770);
  const pixel=await sharp(data).extract({left:lg.x,top:lg.y,width:1,height:1}).removeAlpha().raw().toBuffer();assert.deepEqual([...pixel],[169,196,176]);
  const files=[new File([tile],'01_test.png',{type:'image/png'}),new File([full],'02_xt5.png',{type:'image/png'})];
  await fs.mkdir('test-output',{recursive:true});await fs.writeFile('test-output/render.zip',Buffer.from(await (await makeZip(files)).arrayBuffer()));
  console.log('PASS: pixel-identical framing, band encoding matches ordinary canvas including watermark, full-resolution X-T5-size streaming export, ZIP generated.');
})().catch(error=>{console.error(error);process.exit(1);});
