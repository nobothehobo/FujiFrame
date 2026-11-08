import {DEFAULTS,LOOKS,HUES,validate,geometry,processPixels,histogram,parseCube,rafPreviewRange,bandedPng} from './engine.js';
import * as storage from './storage.js';
const $=id=>document.getElementById(id),clone=v=>structuredClone(v),clamp=(v,a=0,b=1)=>Math.max(a,Math.min(b,v));
const S={photos:[],saved:new Map(),luts:[],id:null,edits:clone(DEFAULTS),undo:[],redo:[],tab:'light',channel:'red',mask:-1,
  source:null,g:null,zoom:1,pan:[0,0],compare:false,split:50,crop:null,pendingCrop:null,
  generation:0,rendering:false,pending:false,importing:false,exporting:false,cancel:false,exportFile:null,exportURL:null,persistent:true};
const tabs=[['light','Light','i-sun','SHAPE THE LIGHT'],['color','Color','i-color','FIND YOUR PALETTE'],['curve','Curve','i-curve','A LITTLE MORE DEPTH'],['looks','Looks','i-look','MAKE IT YOURS'],['masks','Masks','i-mask','LIGHT, JUST WHERE YOU WANT IT'],['crop','Crop','i-crop','A DIFFERENT PERSPECTIVE'],['finish','Finish','i-finish','THE FINISHING TOUCHES']];
let renderTimer,saveTimer,toastTimer,worker,jobId=0;const jobs=new Map();
function node(tag,attrs={},children=[]){const n=document.createElement(tag);for(const[k,v]of Object.entries(attrs)){if(k==='class')n.className=v;else if(k==='text')n.textContent=v;else if(k.startsWith('on'))n.addEventListener(k.slice(2),v);else n.setAttribute(k,v);}for(const c of [].concat(children))n.append(typeof c==='string'?document.createTextNode(c):c);return n;}
function icon(name){const svg=document.createElementNS('http://www.w3.org/2000/svg','svg'),use=document.createElementNS('http://www.w3.org/2000/svg','use');use.setAttribute('href','#'+name);svg.append(use);return svg;}
function toast(message,error=false){$('toast').textContent=message;$('toast').classList.toggle('error',error);$('toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').hidden=true,error?9000:4500);}
function busy(text){$('busy').hidden=!text;$('busy-text').textContent=text||'';}
const photo=()=>S.photos.find(p=>p.id===S.id);
function saveStatus(text,warning=false){$('save-state').replaceChildren(node('i'),document.createTextNode(text));$('save-state').classList.toggle('warning',warning);}
function failStorage(){S.persistent=false;saveStatus('Session only · save a copy',true);toast('Browser storage is unavailable or full. You can still edit; download your photograph and edit file before closing Studio.',true);}
function invalidateExport(){S.exportFile=null;if(S.exportURL)URL.revokeObjectURL(S.exportURL);S.exportURL=null;$('export-ready').hidden=true;}
function remember(){if(!S.id)return;S.undo.push(clone(S.edits));if(S.undo.length>60)S.undo.shift();S.redo=[];}
function change(fn,history=true){if(!S.id||S.exporting)return;if(history)remember();fn(S.edits);S.edits=validate(S.edits);invalidateExport();syncControls();scheduleSave();scheduleRender();updateUndo();}
function updateUndo(){$('undo-button').disabled=!S.undo.length;$('redo-button').disabled=!S.redo.length;}
function scheduleSave(){if(!S.id)return;clearTimeout(saveTimer);const id=S.id,edits=clone(S.edits);saveStatus(S.persistent?'Saving adjustments…':'Session only · save a copy',!S.persistent);saveTimer=setTimeout(()=>save(id,edits),550);}
async function save(id=S.id,edits=clone(S.edits)){if(!id)return;clearTimeout(saveTimer);const previous=S.saved.get(id)||{id,history:[]};const history=[...(previous.history||[])];if(!history.length||JSON.stringify(history.at(-1).edits)!==JSON.stringify(edits))history.push({edits:clone(edits),time:Date.now()});const record={id,edits:clone(edits),history:history.slice(-40),updated:Date.now()};S.saved.set(id,record);if(S.persistent){try{await storage.put('edits',record);if(id===S.id)saveStatus('All adjustments saved');}catch{failStorage();}}}

function initWorker(){try{worker=new Worker(new URL('./worker.js',import.meta.url),{type:'module'});worker.onmessage=({data})=>{const j=jobs.get(data.id);if(!j)return;jobs.delete(data.id);data.error?j.reject(new Error(data.error)):j.resolve(data);};worker.onerror=()=>{for(const j of jobs.values())j.reject(new Error('Worker unavailable'));jobs.clear();worker.terminate();worker=null;};}catch{worker=null;}}
async function process(data,width,height,edits,options={},includeHistogram=false){
  if(worker){const id=++jobId,buffer=data.buffer.slice(data.byteOffset,data.byteOffset+data.byteLength);try{return await new Promise((resolve,reject)=>{jobs.set(id,{resolve,reject});worker.postMessage({id,pixels:buffer,width,height,edits,options,includeHistogram},[buffer]);});}catch(error){if(worker)throw error;}}
  await new Promise(r=>setTimeout(r,0));const pixels=processPixels(data,width,height,edits,options);return{pixels:pixels.buffer,histogram:includeHistogram?histogram(pixels):null};
}
function paint(ctx,source,g,offsetY=0){
  ctx.setTransform(1,0,0,1,0,0);ctx.fillStyle='#000';ctx.fillRect(0,0,ctx.canvas.width,ctx.canvas.height);
  ctx.setTransform(g.width/g.cropW,0,0,g.height/g.cropH,-g.cropX*g.width/g.cropW,-g.cropY*g.height/g.cropH-offsetY);
  ctx.translate(g.rotW/2,g.rotH/2);ctx.rotate(g.angle);ctx.drawImage(source,-g.sourceW/2,-g.sourceH/2,g.sourceW,g.sourceH);
  ctx.setTransform(1,0,0,1,0,0);
}
function context(canvas){const ctx=canvas.getContext('2d',{colorSpace:'srgb',willReadFrequently:true});if(!ctx)throw new Error('This browser could not create an image canvas.');return ctx;}
function scheduleRender(){S.generation++;clearTimeout(renderTimer);renderTimer=setTimeout(render,130);}
async function render(){
  clearTimeout(renderTimer);if(!S.source||S.exporting)return;if(S.rendering){S.pending=true;return;}
  S.rendering=true;S.pending=false;busy('Finding the light…');const generation=S.generation,id=S.id,edits=clone(S.edits);
  if(S.crop)edits.crop=[0,0,1,1];
  try{const g=geometry(S.source.width,S.source.height,edits,1280),base=$('before-canvas');base.width=g.width;base.height=g.height;paint(context(base),sourceImage(),g);
    const bytes=context(base).getImageData(0,0,g.width,g.height),lut=S.luts.find(l=>l.id===edits.lut_id)?.parsed||null;
    const result=await process(bytes.data,g.width,g.height,edits,{lut},true);
    if(id!==S.id||generation!==S.generation){S.pending=true;return;}
    const canvas=$('photo-canvas');canvas.width=g.width;canvas.height=g.height;context(canvas).putImageData(new ImageData(new Uint8ClampedArray(result.pixels),g.width,g.height),0,0);
    S.g=g;$('photo-frame').hidden=false;$('welcome').hidden=true;$('preview-dimensions').textContent=`${g.width} × ${g.height} preview`;
    fit();drawHistogram(result.histogram);syncGuides();
  }catch(error){toast(error.message,true);}
  finally{S.rendering=false;busy(null);if(S.pending){S.pending=false;render();}}
}
function fit(){if(!S.g)return;const st=$('stage'),pad=window.innerWidth>=700?80:44,availableW=Math.max(60,st.clientWidth-pad),availableH=Math.max(50,st.clientHeight-16);const factor=Math.min(availableW/S.g.width,availableH/S.g.height,1);const frame=$('photo-frame');frame.style.width=`${S.g.width*factor}px`;frame.style.height=`${S.g.height*factor}px`;frame.style.transform=`translate(${S.pan[0]}px,${S.pan[1]}px) scale(${S.zoom})`;$('zoom-button').firstChild.textContent=S.zoom===1?'Fit ':`${Math.round(S.zoom*100)}% `;}
new ResizeObserver(fit).observe($('stage'));
function resetView(){S.zoom=1;S.pan=[0,0];fit();}
function setCompare(on){S.compare=on;$('compare-strip').hidden=!on;$('split-line').hidden=!on;$('before-label').hidden=!on;$('compare-button').classList.toggle('active',on);$('photo-canvas').style.clipPath=on?`inset(0 0 0 ${S.split}%)`:'none';$('split-line').style.left=`${S.split}%`;}

function slider(key,label,min,max,step=1,custom){
  const root=node('div',{class:`slider ${key==='temperature'?'warmth':key==='tint'?'tint':''}`}),head=node('div',{class:'slider-header'}),range=node('input',{type:'range',min,max,step,'aria-label':label}),number=node('input',{type:'number',min,max,step,'aria-label':`${label} value`,inputmode:step<1?'decimal':'numeric'});
  range.dataset.key=key;number.dataset.key=key;const text=node('label',{text:label});head.append(text,number);root.append(head,range);let started=false;
  const apply=(value,h)=>{const n=Number(value);if(!Number.isFinite(n))return;const v=clamp(n,min,max);(custom||((v,h)=>change(e=>e[key]=v,h)))(v,h);};
  range.onpointerdown=()=>started=false;range.oninput=()=>{apply(range.value,!started);started=true;};range.onchange=()=>started=false;number.onchange=()=>apply(number.value,true);
  text.ondblclick=()=>apply(DEFAULTS[key]??0,true);return root;
}
function note(text){return node('p',{class:'control-note',text});}
function chip(text,fn,active=false){return node('button',{class:'chip'+(active?' active':''),text,onclick:fn});}
function buildControls(){
  const box=$('controls');box.replaceChildren();const tab=tabs.find(t=>t[0]===S.tab);$('section-title').textContent=tab[1];$('section-eyebrow').textContent=tab[3];
  if(S.tab==='light'){
    box.append(node('canvas',{id:'histogram',class:'histogram',width:500,height:100,'aria-label':'RGB histogram'}));
    for(const[k,label,a,b,step]of[['exposure','Exposure',-5,5,.05],['contrast','Contrast',-100,100,1],['highlights','Highlights',-100,100,1],['shadows','Shadows',-100,100,1],['whites','Whites',-100,100,1],['blacks','Blacks',-100,100,1]])box.append(slider(k,label,a,b,step));
  }else if(S.tab==='color'){
    box.append(slider('temperature','Warmth',-100,100),slider('tint','Tint',-100,100),slider('vibrance','Vibrance',-100,100),slider('saturation','Saturation',-100,100));
    box.append(node('div',{class:'control-subheading',text:'Color mixer'}));const colors={red:'#c2826d',orange:'#cea36d',yellow:'#cec481',green:'#8dac75',aqua:'#80b4a5',blue:'#7e9cb6',purple:'#a18bb7',magenta:'#b684a0'};const row=node('div',{class:'channel-row'});
    for(const[name,color]of Object.entries(colors)){const b=node('button',{class:'color-channel'+(S.channel===name?' active':''),'aria-label':`${name} channel`,title:name,onclick:()=>{S.channel=name;buildControls();}});b.style.setProperty('--color',color);row.append(b);}box.append(row);
    for(const key of ['hue','saturation','luminance'])box.append(slider('hsl-'+key,key[0].toUpperCase()+key.slice(1),-100,100,1,(v,h)=>change(e=>{(e.hsl[S.channel]??={hue:0,saturation:0,luminance:0})[key]=v;},h)));
  }else if(S.tab==='curve'){
    const layout=node('div',{class:'curve-layout'}),canvas=node('canvas',{id:'curve-canvas',class:'curve-canvas',width:500,height:350,'aria-label':'Interactive RGB tone curve'}),presets=node('div',{class:'curve-preset-list'});
    for(const[name,points]of[['Linear',[[0,0],[1,1]]],['Gentle S',[[0,0],[.25,.19],[.75,.81],[1,1]]],['Lift blacks',[[0,.07],[.3,.32],[1,1]]]])presets.append(chip(name,()=>change(e=>e.curve=clone(points))));
    layout.append(canvas,presets);box.append(layout,note('Tap to add a point. Drag to shape your curve. Double-tap an inner point to remove it.'));setupCurve(canvas);
  }else if(S.tab==='looks'){
    box.append(note('Original Studio looks, layered over your source color.'));const grid=node('div',{class:'look-grid'});
    for(const[key,look]of Object.entries(LOOKS)){const b=node('button',{class:'look-card'+(S.edits.look===key?' active':''),title:look.note,onclick:()=>{change(e=>e.look=key);buildControls();}}),swatch=node('div',{class:'look-swatch'});swatch.style.setProperty('--sky',look.colors[1]);swatch.style.setProperty('--mountain',look.colors[0]);swatch.style.setProperty('--ground',look.colors[2]);b.append(swatch,node('span',{class:'look-name',text:look.name}));grid.append(b);}box.append(grid);
    const row=node('div',{class:'lut-row'}),select=node('select',{'aria-label':'Custom color LUT'});select.append(new Option('No custom LUT',''));for(const lut of S.luts)select.append(new Option(lut.name,lut.id));select.value=S.edits.lut_id||'';select.onchange=()=>change(e=>e.lut_id=select.value||null);row.append(select,node('button',{class:'button',text:'+ .cube',onclick:()=>$('lut-input').click()}));box.append(row,slider('lut_amount','LUT intensity',0,100));
  }else if(S.tab==='masks'){
    const row=node('div',{class:'mask-actions'});row.append(node('button',{class:'button',text:'+ Radial light',onclick:()=>addMask('radial')}),node('button',{class:'button',text:'+ Gradient',onclick:()=>addMask('linear')}));box.append(row);
    const list=node('div',{class:'mask-list'});S.edits.masks.forEach((m,i)=>list.append(chip(`${i+1} · ${m.type==='radial'?'Radial':'Gradient'}`,()=>{S.mask=i;buildControls();syncGuides();},i===S.mask)));box.append(list);
    if(S.mask>=0&&S.edits.masks[S.mask]){const mask=S.edits.masks[S.mask];box.append(note('Tap the photograph to position this mask.'));
      for(const[k,label,lo,hi,step]of[['exposure','Exposure',-3,3,.05],['temperature','Warmth',-100,100,1],['saturation','Saturation',-100,100,1],['radius','Size',.02,2,.01],['feather','Feather',.01,1,.01],['angle','Angle',-180,180,1]]){
        if(k==='angle'&&mask.type!=='linear')continue;box.append(slider('mask-'+k,label,lo,hi,step,(v,h)=>change(e=>e.masks[S.mask][k]=v,h)));
      }
      const extra=node('div',{class:'mask-extra'});extra.append(node('button',{text:mask.invert?'✓ Inverted':'Invert mask',onclick:()=>{change(e=>e.masks[S.mask].invert=!e.masks[S.mask].invert);buildControls();}}),node('button',{class:'danger',text:'Remove mask',onclick:()=>{change(e=>e.masks.splice(S.mask,1));S.mask=-1;buildControls();syncGuides();}}));box.append(extra);
    }else box.append(note('Give your subject a little light, warm one corner, or soften color in the background. Up to eight masks.'));
  }else if(S.tab==='crop'){
    const aspects=node('div',{class:'chip-row'});for(const[name,ratio]of[['Original',null],['Square',1],['4:5',.8],['3:2',1.5],['16:9',16/9]])aspects.append(chip(name,()=>centerCrop(ratio)));box.append(aspects);
    const actions=node('div',{class:'chip-row'});actions.append(chip('Draw crop',beginCrop),chip('Rotate 90°',()=>{if(S.crop)cancelCrop();change(e=>{e.quarter_turns=(e.quarter_turns+1)%4;e.crop=[0,0,1,1];});}),chip('Reset crop',()=>change(e=>e.crop=[0,0,1,1])));box.append(actions,slider('rotation','Straighten',-45,45,.1),note('Crop after straightening to remove any black corners. Pinch to zoom; tap Fit to reset your view.'));
  }else if(S.tab==='finish'){
    box.append(slider('grain','Grain',0,100),slider('vignette','Vignette',-100,100),note('Positive vignette darkens the edges; negative brightens them. Grain is judged most accurately in the exported photograph.'));
    box.append(node('button',{class:'button small',text:'Export & save your photograph',onclick:openExport}));
  }
  syncControls();syncGuides();
}
function syncControls(){
  document.querySelectorAll('[data-key]').forEach(input=>{const k=input.dataset.key;let value=k.startsWith('hsl-')?S.edits.hsl[S.channel]?.[k.slice(4)]||0:k.startsWith('mask-')?S.edits.masks[S.mask]?.[k.slice(5)]||0:S.edits[k];input.disabled=!S.id||S.exporting;if(document.activeElement!==input)input.value=value??0;});drawCurve();syncGuides();
}
function setTab(key){S.tab=key;if(S.crop&&key!=='crop')cancelCrop();document.querySelectorAll('[data-tab]').forEach(b=>b.classList.toggle('active',b.dataset.tab===key));buildControls();$('controls').scrollTop=0;}
function buildNav(){for(const[key,label,symbol]of tabs){const b=node('button',{class:'tool-button'+(S.tab===key?' active':''),'aria-label':`${label} editing tools`,onclick:()=>setTab(key)},[icon(symbol),node('span',{text:label})]);b.dataset.tab=key;$('tool-nav').append(b);}}

async function decode(blob){
  if(typeof createImageBitmap==='function'){try{return await createImageBitmap(blob,{imageOrientation:'from-image',colorSpaceConversion:'default'});}catch{}}
  const url=URL.createObjectURL(blob),img=new Image();try{await new Promise((resolve,reject)=>{img.onload=resolve;img.onerror=()=>reject(new Error('This image format is not readable in this browser. Choose a camera JPEG, PNG, WebP, or a RAF preview.'));img.src=url;});return{image:img,width:img.naturalWidth,height:img.naturalHeight,url};}catch(error){URL.revokeObjectURL(url);throw error;}
}
function sourceImage(){return S.source?.image||S.source;}
async function importFiles(files){
  if(S.importing||S.exporting){toast('Please wait for the current photograph to finish.');return;}S.importing=true;let first,count=0;
  for(const file of files){let decoded;
    try{
      if(file.size>200*1024*1024)throw new Error('Choose a file smaller than 200 MB on this phone.');if(/\.(tif|tiff)$/i.test(file.name))throw new Error('For mobile editing, export this TIFF as an sRGB JPEG on your computer first.');
      if(!crypto.subtle)throw new Error('Open Studio using its HTTPS link to import photographs securely.');
      busy(`Opening ${file.name}…`);const digest=await crypto.subtle.digest('SHA-256',await file.arrayBuffer()),id=Array.from(new Uint8Array(digest),v=>v.toString(16).padStart(2,'0')).join('');
      if(S.photos.some(p=>p.id===id)){first??=id;continue;}
      let blob=file,preview=false;
      if(/\.raf$/i.test(file.name)){const{offset,length}=rafPreviewRange(await file.slice(0,128).arrayBuffer(),file.size);blob=file.slice(offset,offset+length,'image/jpeg');const signature=new Uint8Array(await blob.slice(0,2).arrayBuffer());if(signature[0]!==255||signature[1]!==216)throw new Error('This RAF does not contain a readable JPEG preview. Transfer a camera JPEG instead.');preview=true;}
      decoded=await decode(blob);if(decoded.width*decoded.height>55_000_000)throw new Error('This image is too large for mobile editing. Choose a photo under 55 megapixels.');
      const thumb=document.createElement('canvas'),scale=Math.min(1,360/Math.max(decoded.width,decoded.height));thumb.width=Math.max(1,Math.round(decoded.width*scale));thumb.height=Math.max(1,Math.round(decoded.height*scale));context(thumb).drawImage(decoded.image||decoded,0,0,thumb.width,thumb.height);
      const thumbnail=await canvasBlob(thumb,'image/jpeg',.8);thumb.width=thumb.height=1;
      const asset={id,name:file.name,blob,thumbnail,width:decoded.width,height:decoded.height,preview,created:Date.now(),thumbnailURL:URL.createObjectURL(thumbnail)};
      if(S.persistent){try{const persisted={...asset};delete persisted.thumbnailURL;await storage.put('photos',persisted);}catch{failStorage();}}
      S.photos.unshift(asset);S.saved.set(id,{id,edits:clone(DEFAULTS),history:[{time:Date.now(),edits:clone(DEFAULTS)}]});await save(id,clone(DEFAULTS));first??=id;count++;
    }catch(error){toast(`${file.name}: ${error.message}`,true);}
    finally{decoded?.close?.();if(decoded?.url)URL.revokeObjectURL(decoded.url);}
  }
  S.importing=false;busy(null);buildLibrary();if(first)await selectPhoto(first);if(count&&photo()?.preview)toast('RAF preview opened. Full-resolution camera JPEGs give you the best mobile starting image.',true);return{count,first};
}
async function selectPhoto(id){
  if(S.id===id)return;const asset=S.photos.find(p=>p.id===id);if(!asset)return;
  if(S.id)await save();if(S.crop)cancelCrop();const prior=S.source;S.source=null;prior?.close?.();if(prior?.url)URL.revokeObjectURL(prior.url);
  S.id=id;S.edits=clone(S.saved.get(id)?.edits||DEFAULTS);S.undo=[];S.redo=[];S.mask=-1;S.g=null;S.generation++;
  invalidateExport();$('photo-frame').hidden=true;busy('Opening your photograph…');$('library-dialog').close();
  try{const decoded=await decode(asset.blob);if(S.id!==id){decoded.close?.();return;}S.source=decoded;resetView();$('photo-name').textContent=asset.name;$('source-badge').textContent=asset.preview?'RAF · PREVIEW ONLY':'SOURCE COLOR';$('source-badge').classList.toggle('preview',asset.preview);
    for(const key of ['export-button','reset-button','history-button','zoom-button','compare-button'])$(key).disabled=false;
    buildControls();updateUndo();buildLibrary();saveStatus(S.persistent?'All adjustments saved':'Session only · save a copy',!S.persistent);await render();
  }catch(error){busy(null);toast(error.message,true);}
}
function buildLibrary(){
  $('library-grid').replaceChildren();$('photo-count').textContent=S.photos.length;$('library-empty').hidden=S.photos.length>0;
  for(const p of S.photos){if(!p.thumbnailURL)p.thumbnailURL=URL.createObjectURL(p.thumbnail);const card=node('div',{class:'photo-card'+(p.id===S.id?' active':'')}),button=node('button',{class:'photo-select',onclick:()=>selectPhoto(p.id)},[node('img',{src:p.thumbnailURL,alt:p.name,loading:'lazy'}),node('div',{class:'photo-title',text:p.name}),node('span',{class:'photo-type',text:p.preview?'RAF PREVIEW':`${p.width} × ${p.height}`})]);const remove=node('button',{class:'photo-delete',text:'×','aria-label':`Remove ${p.name} from this browser`,onclick:()=>deletePhoto(p.id)});card.append(button,remove);$('library-grid').append(card);}
}
async function deletePhoto(id){
  const p=S.photos.find(a=>a.id===id);if(!p||!confirm(`Remove “${p.name}” and its edits from this browser? Your original in Photos or Files is unaffected.`))return;
  try{if(S.persistent)await storage.remove(id);URL.revokeObjectURL(p.thumbnailURL);S.photos=S.photos.filter(a=>a.id!==id);S.saved.delete(id);if(S.id===id){clearTimeout(saveTimer);S.id=null;S.source?.close?.();if(S.source?.url)URL.revokeObjectURL(S.source.url);S.source=null;S.edits=clone(DEFAULTS);S.generation++;invalidateExport();if(S.photos.length)await selectPhoto(S.photos[0].id);else{$('photo-frame').hidden=true;$('welcome').hidden=false;$('photo-name').textContent='Your pocket darkroom.';for(const k of ['export-button','reset-button','history-button','zoom-button','compare-button'])$(k).disabled=true;setCompare(false);buildControls();}}buildLibrary();}catch(error){toast(error.message,true);}
}

function drawHistogram(data){const c=$('histogram');if(!c)return;if(data)S.histogram=data;else data=S.histogram;const ctx=c.getContext('2d');ctx.clearRect(0,0,c.width,c.height);ctx.strokeStyle='#4e633d88';for(let i=1;i<4;i++){ctx.beginPath();ctx.moveTo(c.width*i/4,0);ctx.lineTo(c.width*i/4,c.height);ctx.stroke();}if(!data)return;const max=Math.max(1,...data.channels.flat());['#c88d7b','#a6c77d','#86a8ba'].forEach((color,ch)=>{ctx.beginPath();ctx.moveTo(0,c.height);data.channels[ch].forEach((v,i)=>ctx.lineTo(i/63*c.width,c.height-(v/max)**.6*c.height));ctx.lineTo(c.width,c.height);ctx.closePath();ctx.fillStyle=color+'55';ctx.fill();ctx.strokeStyle=color;ctx.lineWidth=1;ctx.stroke();});}
function drawCurve(){const c=$('curve-canvas');if(!c)return;const ctx=c.getContext('2d');ctx.clearRect(0,0,c.width,c.height);ctx.strokeStyle='#576d4380';ctx.lineWidth=1;for(let i=0;i<=4;i++){ctx.beginPath();ctx.moveTo(c.width*i/4,0);ctx.lineTo(c.width*i/4,c.height);ctx.moveTo(0,c.height*i/4);ctx.lineTo(c.width,c.height*i/4);ctx.stroke();}ctx.beginPath();S.edits.curve.forEach(([x,y],i)=>i?ctx.lineTo(x*c.width,(1-y)*c.height):ctx.moveTo(x*c.width,(1-y)*c.height));ctx.strokeStyle='#d5e6b0';ctx.lineWidth=2.5;ctx.stroke();for(const[x,y]of S.edits.curve){ctx.beginPath();ctx.arc(x*c.width,(1-y)*c.height,6,0,Math.PI*2);ctx.fillStyle='#d5e6b0';ctx.fill();}}
function setupCurve(canvas){let drag=-1;const point=e=>{const r=canvas.getBoundingClientRect();return[clamp((e.clientX-r.left)/r.width),clamp(1-(e.clientY-r.top)/r.height)];};const nearest=(x,y)=>S.edits.curve.findIndex(p=>Math.hypot(p[0]-x,p[1]-y)<.09);
  canvas.onpointerdown=e=>{if(!S.id)return;const[x,y]=point(e);let index=nearest(x,y);if(index<0&&S.edits.curve.length>=12)return;remember();if(index<0){const p=[clamp(x,.005,.995),y];S.edits.curve.push(p);S.edits.curve.sort((a,b)=>a[0]-b[0]);index=S.edits.curve.indexOf(p);}drag=index;canvas.setPointerCapture(e.pointerId);drawCurve();};
  canvas.onpointermove=e=>{if(drag<0)return;const[x,y]=point(e),p=S.edits.curve;p[drag]=[drag===0?0:drag===p.length-1?1:clamp(x,p[drag-1][0]+.002,p[drag+1][0]-.002),y];drawCurve();invalidateExport();scheduleSave();scheduleRender();};
  const end=()=>{if(drag<0)return;drag=-1;invalidateExport();scheduleSave();scheduleRender();updateUndo();};canvas.onpointerup=end;canvas.onpointercancel=end;
  canvas.ondblclick=e=>{const[x,y]=point(e),i=nearest(x,y);if(i>0&&i<S.edits.curve.length-1)change(ed=>ed.curve.splice(i,1));};
}

function addMask(type){if(!S.id)return;if(S.edits.masks.length>=8){toast('You can use up to eight masks.');return;}if(S.crop)cancelCrop();change(e=>{e.masks.push({type,x:.5,y:.5,radius:.35,feather:.7,angle:90,invert:false,exposure:.3,temperature:0,saturation:0});S.mask=e.masks.length-1;});buildControls();}
function syncGuides(){const m=S.edits.masks[S.mask],show=S.tab==='masks'&&m&&S.id;const guide=$('mask-guide');guide.hidden=!show;if(show){guide.classList.toggle('linear',m.type==='linear');Object.assign(guide.style,{left:`${m.x*100}%`,top:`${m.y*100}%`,width:`${m.radius*200}%`,height:`${m.radius*200}%`,transform:`translate(-50%,-50%) rotate(${m.type==='linear'?m.angle-90:0}deg)`});}if(S.crop&&S.pendingCrop){const[x,y,w,h]=S.pendingCrop;Object.assign($('crop-box').style,{left:`${x*100}%`,top:`${y*100}%`,width:`${w*100}%`,height:`${h*100}%`});}}
function centerCrop(aspect){if(!S.source)return;if(S.crop)cancelCrop();change(e=>{if(!aspect){e.crop=[0,0,1,1];return;}const odd=e.quarter_turns%2,ratio=odd?S.source.height/S.source.width:S.source.width/S.source.height;const w=ratio>aspect?aspect/ratio:1,h=ratio>aspect?1:ratio/aspect;e.crop=[(1-w)/2,(1-h)/2,w,h];});resetView();}
function beginCrop(){if(!S.id)return;if(S.crop)return;S.crop=clone(S.edits.crop);S.pendingCrop=clone(S.edits.crop);setCompare(false);resetView();$('crop-box').hidden=false;$('crop-strip').hidden=false;scheduleRender();syncGuides();}
function cancelCrop(){S.crop=null;S.pendingCrop=null;$('crop-box').hidden=true;$('crop-strip').hidden=true;scheduleRender();}
function setupGestures(){
  const points=new Map();let pinch=null,drag=null,changedMask=false;
  const position=e=>{const r=$('photo-frame').getBoundingClientRect();return[clamp((e.clientX-r.left)/r.width),clamp((e.clientY-r.top)/r.height)];};
  $('stage').onpointerdown=e=>{if(!S.id||S.exporting)return;points.set(e.pointerId,[e.clientX,e.clientY]);$('stage').setPointerCapture(e.pointerId);
    if(points.size===2){const[a,b]=[...points.values()];pinch={distance:Math.hypot(a[0]-b[0],a[1]-b[1]),zoom:S.zoom};drag=null;return;}
    if(S.crop){drag={crop:position(e)};return;}if(S.tab==='masks'&&S.mask>=0){const[x,y]=position(e);change(ed=>{ed.masks[S.mask].x=x;ed.masks[S.mask].y=y;});changedMask=true;return;}
    if(S.zoom>1)drag={pan:[...S.pan],start:[e.clientX,e.clientY]};
  };
  $('stage').onpointermove=e=>{if(!points.has(e.pointerId))return;points.set(e.pointerId,[e.clientX,e.clientY]);if(pinch&&points.size===2){const[a,b]=[...points.values()];S.zoom=clamp(pinch.zoom*Math.hypot(a[0]-b[0],a[1]-b[1])/Math.max(1,pinch.distance),1,4);fit();return;}
    if(drag?.crop){const[x,y]=position(e),[a,b]=drag.crop,w=Math.max(.01,Math.abs(x-a)),h=Math.max(.01,Math.abs(y-b));S.pendingCrop=[clamp(Math.min(x,a),0,1-w),clamp(Math.min(y,b),0,1-h),w,h];syncGuides();}
    else if(changedMask&&S.mask>=0){const[x,y]=position(e);change(ed=>{ed.masks[S.mask].x=x;ed.masks[S.mask].y=y;},false);}
    else if(drag?.pan){S.pan=[drag.pan[0]+e.clientX-drag.start[0],drag.pan[1]+e.clientY-drag.start[1]];fit();}
  };
  const end=e=>{points.delete(e.pointerId);if(points.size<2)pinch=null;drag=null;changedMask=false;};$('stage').onpointerup=end;$('stage').onpointercancel=end;
}

function canvasBlob(canvas,type,quality){return new Promise((resolve,reject)=>{try{canvas.toBlob(blob=>blob?resolve(blob):reject(new Error('This phone could not encode that image. Choose PNG or a smaller export size.')),type,quality);}catch(error){reject(error);}});}
function updateExportSize(){if(!S.source)return;const g=geometry(S.source.width,S.source.height,S.edits,Number($('export-size').value));$('export-dimensions').textContent=`${g.width.toLocaleString()} × ${g.height.toLocaleString()} pixels · ${$('export-format').value==='png'?'lossless PNG':'JPEG at 95% quality'}`;}
function openExport(){if(!S.id)return;if(S.crop){toast('Apply or cancel your crop before exporting.');return;}$('preview-ack').checked=false;$('export-preview-warning').hidden=!photo().preview;$('preview-ack-label').hidden=!photo().preview;$('export-progress').hidden=true;$('export-ready').hidden=!S.exportFile;updateExportSize();$('export-dialog').showModal();}
async function prepareExport(){
  if(!S.source||S.exporting)return;if(photo().preview&&!$('preview-ack').checked){toast('Confirm the embedded-preview export limit first.',true);return;}
  S.exporting=true;S.cancel=false;invalidateExport();clearTimeout(renderTimer);const edits=clone(S.edits),asset=photo(),g=geometry(S.source.width,S.source.height,edits,Number($('export-size').value)),format=$('export-format').value;
  $('prepare-export').disabled=true;$('export-format').disabled=true;$('export-size').disabled=true;$('export-progress').hidden=false;$('progress-text').textContent='Preparing your photograph…';$('progress-bar').value=0;syncControls();
  const lut=S.luts.find(l=>l.id===edits.lut_id)?.parsed||null,band=document.createElement('canvas');
  try{
    await save();let blob;
    if(format==='png'){
      band.width=g.width;
      blob=await bandedPng(g.width,g.height,async(y,rows)=>{if(S.cancel)throw new Error('Export canceled.');band.height=rows;const ctx=context(band);paint(ctx,sourceImage(),g,y);const image=ctx.getImageData(0,0,g.width,rows);if(image.data[3]!==255)throw new Error('The image exceeds this phone’s canvas limit. Choose 2048 px.');const result=await process(image.data,g.width,rows,edits,{offsetY:y,fullWidth:g.width,fullHeight:g.height,lut});return new Uint8Array(result.pixels);},value=>{$('progress-bar').value=value;$('progress-text').textContent=`Preparing PNG · ${Math.round(value*100)}%`;});
    }else{
      if(g.width*g.height>16_000_000)throw new Error('For a full-resolution photo this large, choose PNG. JPEG on phones is limited here to 16 megapixels; select a smaller size for JPEG.');
      band.width=g.width;band.height=g.height;const ctx=context(band);paint(ctx,sourceImage(),g);const image=ctx.getImageData(0,0,g.width,g.height);const result=await process(image.data,g.width,g.height,edits,{lut});if(S.cancel)throw new Error('Export canceled.');ctx.putImageData(new ImageData(new Uint8ClampedArray(result.pixels),g.width,g.height),0,0);$('progress-bar').value=.9;blob=await canvasBlob(band,'image/jpeg',.95);
    }
    if(S.cancel)throw new Error('Export canceled.');const filename=asset.name.replace(/\.[^.]+$/,'').replace(/[\\/:*?"<>|]/g,'_')+(asset.preview?'-preview':'-studio')+(format==='png'?'.png':'.jpg');S.exportFile=new File([blob],filename,{type:blob.type});S.exportURL=URL.createObjectURL(blob);$('open-photo').href=S.exportURL;$('export-ready').hidden=false;$('export-progress').hidden=true;
    $('share-photo').hidden=!(navigator.share&&navigator.canShare?.({files:[S.exportFile]}));toast('Your photograph is ready. Tap Share / Save Image or Download.');
  }catch(error){toast(error.message,true);$('progress-text').textContent=error.message;}
  finally{band.width=band.height=1;S.exporting=false;$('prepare-export').disabled=false;$('export-format').disabled=false;$('export-size').disabled=false;syncControls();if(S.pending)render();}
}
function download(blob,name){const url=URL.createObjectURL(blob),a=node('a',{href:url,download:name});document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),60000);}
async function sidecar(){if(!photo())return;await save();const content={schema:'fujiframe-mobile/v1',source_sha256:S.id,source_name:photo().name,preview_only:photo().preview,edits:S.edits,lut:S.luts.find(l=>l.id===S.edits.lut_id)?.text||null};download(new Blob([JSON.stringify(content,null,2)],{type:'application/json'}),photo().name.replace(/\.[^.]+$/,'')+'.fujiframe.json');}
async function restoreSidecar(file){try{const data=JSON.parse(await file.text());if(!['fujiframe-mobile/v1','fujiframe-studio/v1'].includes(data.schema)||data.source_sha256!==S.id)throw new Error('Choose an edit file for this exact source photograph.');if(data.lut){const id=await addLut('Restored LUT',data.lut);data.edits.lut_id=id;}else if(data.edits.lut_id&&!S.luts.some(l=>l.id===data.edits.lut_id))throw new Error('Import the matching .cube LUT before restoring these edits.');const edits=validate(data.edits);change(e=>Object.assign(e,edits));buildControls();toast(data.schema==='fujiframe-studio/v1'?'Desktop edits restored where supported. RAW development and desktop detail controls are not reproduced on mobile.':'Your saved edits are restored.');}catch(error){toast(error.message,true);}}
async function addLut(name,text){const parsed=parseCube(text),digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text)),id=Array.from(new Uint8Array(digest),v=>v.toString(16).padStart(2,'0')).join('');S.luts=S.luts.filter(l=>l.id!==id);S.luts.push({id,name,text,parsed});if(S.persistent)try{await storage.put('luts',{id,name,text});}catch{failStorage();}return id;}

function undo(redo=false){if(S.exporting)return;const from=redo?S.redo:S.undo,to=redo?S.undo:S.redo;if(!from.length)return;to.push(clone(S.edits));S.edits=from.pop();S.mask=-1;invalidateExport();buildControls();updateUndo();scheduleSave();scheduleRender();}
async function openHistory(){if(!S.id)return;await save();$('history-list').replaceChildren();const rows=[...(S.saved.get(S.id)?.history||[])].reverse();for(const[rIndex,record]of rows.entries())$('history-list').append(node('button',{class:'history-item',onclick:()=>{change(e=>Object.assign(e,clone(record.edits)));S.mask=-1;buildControls();$('history-dialog').close();}},[node('span',{text:rIndex===rows.length-1?'Original import':`Saved state ${rows.length-rIndex}`}),node('small',{text:new Date(record.time).toLocaleString()})]));$('history-dialog').showModal();}
function showInfo(){const p=photo();$('photo-info').replaceChildren();if(p){$('photo-info').append(node('div',{text:p.name}),node('div',{text:`${p.width} × ${p.height} source pixels`}),node('div',{text:p.preview?'Embedded RAF preview only. The original RAF remains in your Files.':'Rendered source image · edits saved separately'}));}$('info-dialog').showModal();}

async function demo(){
  const canvas=document.createElement('canvas');canvas.width=1800;canvas.height=1200;const ctx=context(canvas),sky=ctx.createLinearGradient(0,0,0,1200);sky.addColorStop(0,'#7a9f9e');sky.addColorStop(1,'#e1cf9f');ctx.fillStyle=sky;ctx.fillRect(0,0,1800,1200);ctx.fillStyle='#e1d7a3';ctx.beginPath();ctx.arc(1400,230,90,0,Math.PI*2);ctx.fill();
  const poly=(points,color)=>{ctx.fillStyle=color;ctx.beginPath();points.forEach(([x,y],i)=>i?ctx.lineTo(x,y):ctx.moveTo(x,y));ctx.closePath();ctx.fill();};
  poly([[0,750],[200,580],[410,665],[720,310],[1010,660],[1240,380],[1600,680],[1800,520],[1800,1200],[0,1200]],'#7b9181');poly([[575,475],[720,310],[865,475],[772,446],[730,483],[685,430]],'#d8dfce');poly([[1090,525],[1240,380],[1370,520],[1285,490],[1220,465],[1175,515]],'#d8dfce');poly([[0,890],[340,720],[580,825],[970,690],[1320,830],[1800,700],[1800,1200],[0,1200]],'#3d6552');poly([[0,1030],[450,918],[1000,963],[1800,845],[1800,1200],[0,1200]],'#9da878');poly([[640,1200],[850,1060],[1250,950],[1340,918],[1370,920],[1280,976],[1010,1100],[940,1200]],'#c4b88a');
  const data=ctx.getImageData(0,0,1800,1200);for(let p=0;p<data.data.length;p+=4){const n=((Math.imul(p+3,2654435761)>>>0)%7)-3;for(let c=0;c<3;c++)data.data[p+c]+=n;}ctx.putImageData(data,0,0);const blob=await canvasBlob(canvas,'image/jpeg',.95);canvas.width=canvas.height=1;const result=await importFiles([new File([blob],'Studio test landscape.jpg',{type:'image/jpeg'})]);if(result?.first)toast('Synthetic test scene loaded. Import your own photograph for camera color.');
}

function setupEvents(){
  for(const id of ['import-button','welcome-import','library-import'])$(id).onclick=()=>$('file-input').click();
  $('file-input').onchange=e=>{const files=Array.from(e.target.files);e.target.value='';importFiles(files);};
  $('library-button').onclick=()=>{buildLibrary();$('library-dialog').showModal();};$('demo-button').onclick=demo;$('info-button').onclick=showInfo;
  document.querySelectorAll('[data-close]').forEach(b=>b.onclick=()=>b.closest('dialog').close());
  $('export-button').onclick=openExport;$('prepare-export').onclick=prepareExport;$('export-format').onchange=()=>{invalidateExport();updateExportSize();};$('export-size').onchange=()=>{invalidateExport();updateExportSize();};$('cancel-export').onclick=()=>{S.cancel=true;};
  $('export-dialog').addEventListener('close',()=>{if(S.exporting)S.cancel=true;});
  $('share-photo').onclick=async()=>{if(!S.exportFile)return;try{await navigator.share({files:[S.exportFile]});}catch(error){if(error.name!=='AbortError')toast('Sharing is unavailable here. Use Download file or Open image instead.',true);}};
  $('download-photo').onclick=()=>{if(S.exportFile)download(S.exportFile,S.exportFile.name);};$('download-edits').onclick=sidecar;$('import-edits').onclick=()=>$('sidecar-input').click();
  $('sidecar-input').onchange=e=>{const file=e.target.files[0];e.target.value='';if(file)restoreSidecar(file);};
  $('lut-input').onchange=async e=>{const file=e.target.files[0];e.target.value='';if(!file)return;if(file.size>12*1024*1024){toast('Choose a .cube LUT smaller than 12 MB.',true);return;}try{const id=await addLut(file.name,await file.text());change(ed=>ed.lut_id=id);buildControls();toast('Your color LUT is ready.');}catch(error){toast(error.message,true);}};
  $('undo-button').onclick=()=>undo();$('redo-button').onclick=()=>undo(true);$('history-button').onclick=openHistory;
  $('reset-button').onclick=()=>{if(!S.id)return;change(e=>Object.assign(e,clone(DEFAULTS)));S.mask=-1;buildControls();};
  $('compare-button').onclick=()=>{if(S.crop)cancelCrop();setCompare(!S.compare);};$('split-slider').oninput=e=>{S.split=Number(e.target.value);setCompare(S.compare);};$('zoom-button').onclick=resetView;
  $('cancel-crop').onclick=cancelCrop;$('apply-crop').onclick=()=>{const crop=clone(S.pendingCrop);S.crop=null;S.pendingCrop=null;$('crop-box').hidden=true;$('crop-strip').hidden=true;change(e=>e.crop=crop);resetView();};
  document.addEventListener('keydown',e=>{if(['INPUT','SELECT','TEXTAREA'].includes(document.activeElement.tagName)||document.querySelector('dialog[open]'))return;if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='z'){e.preventDefault();undo(e.shiftKey);}if(e.key==='\\'&&S.id)setCompare(!S.compare);if(e.key==='Escape'&&S.crop)cancelCrop();});
  let depth=0;document.addEventListener('dragenter',e=>{if(Array.from(e.dataTransfer.types).includes('Files')){e.preventDefault();depth++;$('drop-zone').hidden=false;}});document.addEventListener('dragover',e=>{if(Array.from(e.dataTransfer.types).includes('Files'))e.preventDefault();});document.addEventListener('dragleave',()=>{if(--depth<=0)$('drop-zone').hidden=true;});document.addEventListener('drop',e=>{e.preventDefault();depth=0;$('drop-zone').hidden=true;importFiles(Array.from(e.dataTransfer.files));});
  document.addEventListener('visibilitychange',()=>{if(document.hidden&&S.id)save();});window.addEventListener('pagehide',()=>{if(S.id)save();});setupGestures();
}

async function init(){
  initWorker();buildNav();setupEvents();
  try{const[photos,edits,luts]=await Promise.all([storage.all('photos'),storage.all('edits'),storage.all('luts')]);S.photos=photos.sort((a,b)=>b.created-a.created);for(const r of edits)S.saved.set(r.id,r);for(const l of luts)try{S.luts.push({...l,parsed:parseCube(l.text)});}catch{}buildLibrary();}catch{failStorage();}
  buildControls();if(S.photos.length)await selectPhoto(S.photos[0].id);
  if('serviceWorker'in navigator)navigator.serviceWorker.register(new URL('./sw.js',import.meta.url),{scope:'./'}).catch(()=>{});
}
init().catch(error=>{busy(null);toast(`Studio couldn’t start: ${error.message}`,true);});
