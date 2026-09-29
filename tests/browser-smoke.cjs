// Optional: NODE_PATH=<your modules directory> node tests/browser-smoke.cjs
const { chromium } = require('playwright');
const sharp = require('sharp');
const fs = require('node:fs/promises');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '..'), out = path.join(root,'test-output');
(async () => {
  await fs.mkdir(out,{recursive:true});
  const source = Buffer.alloc(101*60*3);
  for (let y=0;y<60;y++) for (let x=0;x<101;x++) { const at=(y*101+x)*3; source[at]=x*2; source[at+1]=y*4; source[at+2]=100; }
  await sharp(source,{raw:{width:101,height:60,channels:3}}).png().toFile(path.join(out,'source.png'));
  await sharp({create:{width:120,height:80,channels:3,background:'#4b8570'}}).jpeg().withMetadata({orientation:6}).toFile(path.join(out,'rotated.jpg'));
  const browser = await chromium.launch({headless:true,args:['--no-sandbox']});
  try {
    const page = await browser.newPage({viewport:{width:1440,height:1000}}), errors=[];
    page.on('pageerror',error=>errors.push(error.message));
    await page.goto('http://127.0.0.1:5173');
    await page.locator('#files').setInputFiles([path.join(out,'source.png'),path.join(out,'rotated.jpg')]);
    await page.waitForFunction(()=>document.querySelector('#export').disabled===false && document.querySelectorAll('.thumb').length===2);
    assert.match(await page.locator('#photo-info').textContent(),/101 × 60/);
    await page.locator('.thumb').nth(1).click();
    assert.match(await page.locator('#photo-info').textContent(),/80 × 120/);
    await page.locator('.thumb').nth(0).click();
    await page.locator('#border').fill('0');
    await page.locator('#export').click();
    await page.waitForFunction(()=>!document.querySelector('#export').disabled && !document.querySelector('#results').hidden);
    assert.equal(await page.locator('.export-card').count(),2);
    async function exportBytes(index) {
      return Buffer.from(await page.locator('.export-card a[download]').nth(index).evaluate(async a=>Array.from(new Uint8Array(await (await fetch(a.href)).arrayBuffer()))));
    }
    const framed=await exportBytes(0), meta=await sharp(framed).metadata();
    assert.equal(meta.width,120); assert.equal(meta.height,120); assert.equal(meta.exif,undefined);
    const crop=await sharp(framed).extract({left:9,top:30,width:101,height:60}).removeAlpha().raw().toBuffer();
    assert.deepEqual(crop,source,'Full-resolution native photo pixels must be identical');
    await page.locator('#metadata').selectOption('keep');
    assert.equal(await page.locator('#results').isHidden(),true,'Settings invalidate stale exports');
    await page.locator('#export').click();
    await page.waitForFunction(()=>!document.querySelector('#export').disabled && document.querySelectorAll('.export-card').length===2);
    const rotated=await exportBytes(1), {extractMetadata}=await import(pathToFileURL(path.join(root,'metadata.js')));
    const exif=extractMetadata(new Uint8Array(rotated)).exif;
    assert.ok(exif,'EXIF retained');
    // TIFF endian-aware reader checks orientation=1, preventing double-rotation.
    const v=new DataView(exif.buffer,exif.byteOffset,exif.byteLength), little=exif[0]===73, start=v.getUint32(4,little), count=v.getUint16(start,little);
    let orientation;
    for(let i=0;i<count;i++){const at=start+2+i*12;if(v.getUint16(at,little)===0x112)orientation=v.getUint16(at+8,little);}
    assert.equal(orientation,1);
    await page.locator('#watermark').fill('© Noah Payne'); await page.locator('#placement').selectOption('photo');
    await page.locator('#ink').fill('#ffffff');
    await page.screenshot({path:path.join(out,'desktop.png'),fullPage:true});
    await page.setViewportSize({width:390,height:844});
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'No mobile horizontal overflow');
    await page.screenshot({path:path.join(out,'mobile.png'),fullPage:true});
    // Reordering and removal retain a valid selected photo.
    await page.getByRole('button',{name:'Move earlier 2',exact:true}).click();
    assert.match(await page.locator('#photo-info').textContent(),/rotated.jpg/);
    await page.getByRole('button',{name:'Remove photo 1',exact:true}).click();
    assert.equal(await page.locator('.thumb').count(),1);
    await page.locator('#clear').click();
    await sharp({create:{width:7728,height:5152,channels:3,background:'#a9c4b0'}}).png().toFile(path.join(out,'xt5.png'));
    await page.setViewportSize({width:1440,height:1000});
    await page.locator('#watermark').fill(''); await page.locator('#metadata').selectOption('strip'); await page.locator('#ratio').selectOption('original'); await page.locator('#border').fill('6');
    await page.locator('#files').setInputFiles(path.join(out,'xt5.png'));
    await page.waitForFunction(()=>document.querySelector('#export').disabled===false && document.querySelectorAll('.thumb').length===1);
    await page.locator('#export').click();
    await page.waitForFunction(()=>!document.querySelector('#export').disabled && !document.querySelector('#results').hidden,{},{timeout:60000});
    const large=await sharp(await exportBytes(0)).metadata();
    assert.equal(large.width,8346); assert.equal(large.height,5770);
    assert.deepEqual(errors,[],'No browser exceptions');
    console.log('PASS: lossless native pixel region, common carousel, EXIF rotation/retention/exclusion, stale output invalidation, reorder/remove, responsive UI, full-resolution X-T5-size export.');
  } finally { await browser.close(); }
})().catch(error=>{console.error(error);process.exit(1);});
