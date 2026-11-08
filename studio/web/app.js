const $ = (id) => document.getElementById(id);
const clone = (value) => structuredClone(value);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const state = {assets: [], active: null, edits: null, defaults: null, csrf: '', looks: {}, luts: [],
  undo: [], redo: [], filter: 'all', query: '', sort: 'newest', compare: false, zoom: 'fit',
  panel: 'library', mask: -1, crop: null, pendingCrop: [0, 0, 1, 1], meta: null,
  renderGeneration: 0, rendering: false, renderPending: false, beforeKey: '',
  dirty: new Map(), saving: false, importBusy: false};
let saveTimer, renderTimer, toastTimer, editedURL, beforeURL, savePromise;

function toast(message, error = false) {
  $('toast').textContent = message;
  $('toast').classList.toggle('error', error);
  $('toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, error ? 9000 : 4500);
}

async function request(path, {body, raw, method = 'GET', ...opts} = {}) {
  const headers = {};
  if (method !== 'GET') headers['X-Studio-CSRF'] = state.csrf;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(path, {method, headers, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)), ...opts});
  if (!response.ok) {
    let message;
    try { message = (await response.json()).error; } catch { message = `Studio returned ${response.status}`; }
    throw new Error(message || 'Studio could not complete that action');
  }
  return response;
}
async function json(path, options) { return (await request(path, options)).json(); }
const active = () => state.assets.find(a => a.id === state.active);
function upsert(asset) {
  const index = state.assets.findIndex(a => a.id === asset.id);
  if (index >= 0) state.assets[index] = asset;
  else state.assets.unshift(asset);
}

function saveLabel(text, failed = false) {
  $('save-state').replaceChildren();
  const dot = document.createElement('span'); dot.className = 'status-dot';
  if (failed) dot.style.background = '#e5ab7d';
  $('save-state').append(dot, document.createTextNode(text));
}
function scheduleSave() {
  if (!state.active || !state.edits) return;
  state.dirty.set(state.active, clone(state.edits));
  saveLabel('Unsaved adjustments');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, 500);
}
function flushSave() {
  clearTimeout(saveTimer);
  if (savePromise) return savePromise;
  savePromise = savePending().finally(() => { savePromise = null; });
  return savePromise;
}
async function savePending() {
  clearTimeout(saveTimer);
  state.saving = true;
  try {
    while (state.dirty.size) {
      const [id, edits] = state.dirty.entries().next().value;
      state.dirty.delete(id);
      const asset = state.assets.find(a => a.id === id);
      saveLabel('Saving adjustments…');
      try {
        const saved = await json(`/api/assets/${id}/edits`, {method: 'POST', body: {edits, revision: asset.revision}});
        upsert(saved);
      } catch (error) {
        if (!state.dirty.has(id)) state.dirty.set(id, edits);
        saveLabel('Save failed · edits kept in this window', true);
        toast(error.message, true);
        return false;
      }
    }
    saveLabel('All adjustments saved');
    return true;
  } finally { state.saving = false; }
}

function change(mutator, history = true) {
  if (!state.edits) return;
  if (history) {
    state.undo.push(clone(state.edits));
    if (state.undo.length > 100) state.undo.shift();
    state.redo = [];
  }
  mutator(state.edits);
  refreshControls();
  scheduleSave(); scheduleRender();
  $('undo-button').disabled = !state.undo.length;
  $('redo-button').disabled = !state.redo.length;
}

function slider(name, label, min, max, step = 1, handler, className = '') {
  const root = document.createElement('div'); root.className = `slider-control ${className}`;
  const top = document.createElement('div'); top.className = 'slider-top';
  const text = document.createElement('label'); text.textContent = label;
  const range = document.createElement('input'); range.type = 'range'; range.min = min; range.max = max; range.step = step;
  range.id = `slider-${name}`; text.htmlFor = range.id; range.setAttribute('aria-label', label);
  const number = document.createElement('input'); number.type = 'number'; number.min = min; number.max = max; number.step = step;
  number.setAttribute('aria-label', `${label} value`);
  range.dataset.control = name; number.dataset.control = name;
  top.append(text, number); root.append(top, range);
  let dragStarted = false;
  const apply = (input, withHistory) => {
    const value = Number(input.value);
    if (!Number.isFinite(value)) return;
    const bounded = clamp(value, min, max);
    (handler || ((v, hist) => change(e => { e[name] = v; }, hist)))(bounded, withHistory);
  };
  range.addEventListener('pointerdown', () => { dragStarted = false; });
  range.addEventListener('input', () => { apply(range, !dragStarted); dragStarted = true; });
  range.addEventListener('change', () => { dragStarted = false; });
  number.addEventListener('change', () => apply(number, true));
  text.addEventListener('dblclick', () => {
    (handler || ((v, hist) => change(e => { e[name] = v; }, hist)))(state.defaults[name] ?? 0, true);
  });
  return root;
}

function group(title, symbol, open = true) {
  const details = document.createElement('details'); details.className = 'adjustment-group'; details.open = open;
  const summary = document.createElement('summary'); const icon = document.createElement('span'); icon.textContent = symbol;
  summary.append(icon, document.createTextNode(title));
  const content = document.createElement('div'); content.className = 'group-content'; details.append(summary, content);
  $('adjustment-groups').append(details); return content;
}

function buildControls() {
  const light = group('Light', '☀');
  for (const [name, label, min, max, step] of [['exposure', 'Exposure', -5, 5, .05], ['contrast', 'Contrast', -100, 100, 1], ['highlights', 'Highlights', -100, 100, 1], ['shadows', 'Shadows', -100, 100, 1], ['whites', 'Whites', -100, 100, 1], ['blacks', 'Blacks', -100, 100, 1]]) light.append(slider(name, label, min, max, step));
  const color = group('Color', '◉');
  for (const [name, label] of [['temperature', 'Warmth'], ['tint', 'Tint'], ['vibrance', 'Vibrance'], ['saturation', 'Saturation']]) color.append(slider(name, label, -100, 100, 1, null, `${name}-slider`));
  const curve = group('Tone curve', '∿', false);
  const canvas = document.createElement('canvas'); canvas.id = 'tone-curve'; canvas.className = 'curve-canvas'; canvas.width = 500; canvas.height = 300; canvas.setAttribute('aria-label', 'Interactive tone curve; click and drag points');
  const actions = document.createElement('div'); actions.className = 'curve-actions';
  for (const [text, points] of [['Linear', [[0,0],[1,1]]], ['Gentle S', [[0,0],[.25,.19],[.75,.81],[1,1]]], ['Lift shadows', [[0,.07],[.3,.32],[1,1]]]]) {
    const button = document.createElement('button'); button.textContent = text; button.onclick = () => change(e => { e.curve = clone(points); }); actions.append(button);
  }
  const caption = document.createElement('p'); caption.className = 'curve-caption'; caption.textContent = 'Click to add a point. Drag to shape. Double-click an inner point to remove it. Piecewise linear RGB curve.';
  curve.append(canvas, actions, caption); setupCurve(canvas);
  const mixer = group('Color mixer', '◌', false);
  const channels = document.createElement('div'); channels.className = 'hsl-channels';
  const channelColors = {red:'#c17561',orange:'#cf9e60',yellow:'#c8bb70',green:'#88a771',aqua:'#73b3a8',blue:'#7b9db9',purple:'#9b83b3',magenta:'#b97d9f'};
  state.hslChannel = 'red';
  for (const [name, value] of Object.entries(channelColors)) {
    const b = document.createElement('button'); b.className = 'hsl-channel'; b.dataset.channel = name; b.style.setProperty('--swatch', value); b.title = name; b.setAttribute('aria-label', `${name} color channel`);
    b.onclick = () => { state.hslChannel = name; refreshControls(); }; channels.append(b);
  }
  mixer.append(channels);
  for (const key of ['hue','saturation','luminance']) mixer.append(slider(`hsl-${key}`, key[0].toUpperCase()+key.slice(1), -100, 100, 1, (value,hist) => change(e => { (e.hsl[state.hslChannel] ??= {hue:0,saturation:0,luminance:0})[key] = value; },hist)));
  const detail = group('Detail & atmosphere', '✧', false);
  for (const [key,label,min] of [['texture','Texture',0],['sharpness','Sharpening',0],['grain','Grain',0],['vignette','Vignette',-100]]) detail.append(slider(key,label,min,100));
  const geometry = group('Geometry', '⌗', false);
  geometry.append(slider('rotation', 'Straighten', -45, 45, .1));
  const note = document.createElement('p'); note.className='curve-caption'; note.textContent='Straightening keeps the canvas size and may reveal black corners. Crop after rotating.'; geometry.append(note);
  $('lut-amount-slot').append(slider('lut_amount', 'LUT intensity', 0, 100));
  refreshControls();
}

function refreshControls() {
  const edits = state.edits || state.defaults;
  if (!edits) return;
  document.querySelectorAll('[data-control]').forEach(input => {
    const name = input.dataset.control;
    let value;
    if (name.startsWith('hsl-')) value = edits.hsl[state.hslChannel]?.[name.slice(4)] || 0;
    else if (name.startsWith('mask-')) value = edits.masks[state.mask]?.[name.slice(5)] ?? 0;
    else value = edits[name];
    input.disabled = !state.active;
    if (document.activeElement !== input) input.value = value ?? 0;
  });
  document.querySelectorAll('[data-channel]').forEach(b => b.classList.toggle('active',b.dataset.channel===state.hslChannel));
  document.querySelectorAll('[data-look]').forEach(b => b.classList.toggle('active',b.dataset.look===edits.look));
  $('lut-select').value = edits.lut_id || '';
  $('development-mode').value = edits.mode;
  drawCurve(); refreshColorNotice(); refreshMaskGuide();
}

function refreshColorNotice() {
  const asset = active();
  if (!asset) return;
  const raw = asset.kind === 'raf';
  $('development-mode').disabled = !raw;
  $('attach-rendering').hidden = !raw;
  let notice;
  if (raw && state.edits.mode === 'raw') notice='Neutral LibRaw development uses full sensor data. Fujifilm film simulations are not applied in this mode.';
  else if (raw && !asset.has_render) notice='Embedded camera JPEG only. Its film simulation is retained, but this is a lower-resolution preview. Attach a full rendering for full-quality camera color.';
  else if (raw) notice='Your attached rendering supplies the film simulation. Adjustments are applied to that rendered image.';
  else notice='The imported image supplies your starting color. Edits are made on a separate copy.';
  $('color-notice').textContent=notice;
  $('color-notice').parentElement.classList.toggle('warning', raw && state.edits.mode==='camera' && !asset.has_render);
  $('source-status').textContent=raw ? (state.edits.mode==='raw' ? 'Neutral RAW · full sensor data' : asset.has_render ? 'Attached camera rendering' : 'Embedded JPEG preview · limited resolution') : 'Source rendering · nondestructive edits';
}

function buildLooks() {
  $('looks-list').replaceChildren();
  for (const [key,value] of Object.entries(state.looks)) {
    const b=document.createElement('button'); b.className='look-card'; b.dataset.look=key;
    const title=document.createElement('strong');title.textContent=value.name;
    const desc=document.createElement('small');desc.textContent=value.description;
    b.append(title,desc);b.onclick=()=>change(e=>{e.look=key;});$('looks-list').append(b);
  }
  $('lut-select').replaceChildren(new Option('No custom LUT',''));
  state.luts.forEach(lut=>$('lut-select').append(new Option(lut.name,lut.id)));
}

function renderLibrary() {
  $('photo-count').textContent=state.assets.length;
  const filtered=state.assets.filter(a=>(state.filter==='all'||state.filter==='pick'&&a.flag==='pick'||state.filter==='rated'&&a.rating>0)&&a.name.toLowerCase().includes(state.query.toLowerCase()));
  if(state.sort==='name') filtered.sort((a,b)=>a.name.localeCompare(b.name));
  else filtered.sort((a,b)=>b.created-a.created);
  $('library-grid').replaceChildren();$('filmstrip').replaceChildren();
  $('library-empty').hidden=state.assets.length>0;
  for(const asset of filtered){
    const card=document.createElement('button');card.className='photo-card';card.classList.toggle('active',asset.id===state.active);card.title=asset.name;
    const thumb=document.createElement('div');thumb.className='photo-thumb';
    const img=document.createElement('img');img.src=`/api/assets/${asset.id}/thumbnail`;img.alt=asset.name;img.loading='lazy';
    img.onerror=()=>{img.hidden=true;thumb.title='Preview unavailable; select the photo for details';};
    const tag=document.createElement('span');tag.className='photo-tag';tag.textContent=asset.kind==='raf'?'RAF':asset.name.split('.').pop().toUpperCase();
    thumb.append(img,tag);const caption=document.createElement('div');caption.className='photo-caption';caption.textContent=asset.name;
    const rating=document.createElement('div');rating.className='photo-rating';rating.textContent=(asset.flag==='pick'?'⚑ ':'')+'★'.repeat(asset.rating);
    card.append(thumb,caption,rating);card.onclick=()=>selectPhoto(asset.id);$('library-grid').append(card);
    const film=document.createElement('button');film.className='film-thumb';film.classList.toggle('active',asset.id===state.active);film.title=asset.name;
    const filmImg=img.cloneNode();filmImg.loading='lazy';film.append(filmImg,tag.cloneNode(true));film.onclick=()=>selectPhoto(asset.id);$('filmstrip').append(film);
  }
}

async function selectPhoto(id) {
  if(id===state.active)return;
  if(state.crop) cancelCrop();
  state.active=id;const asset=active();state.edits=clone(state.dirty.get(id)||asset.edits);
  state.undo=[];state.redo=[];state.mask=-1;state.beforeKey='';state.meta=null;
  state.renderGeneration++;
  $('welcome').hidden=true;$('image-frame').hidden=true;$('image-error').hidden=true;$('rating-controls').hidden=false;
  $('file-name').textContent=asset.name;$('file-format').textContent=asset.kind==='raf'?'RAF':asset.name.split('.').pop().toUpperCase();
  for(const id of ['export-button','reset-button','compare-button','crop-button','rotate-button','mask-button'])$(id).disabled=false;
  $('undo-button').disabled=true;$('redo-button').disabled=true;
  $('save-sidecar').disabled=false;
  renderLibrary();refreshControls();renderRating();buildMaskControls();setZoom('fit');
  if(state.panel==='history')loadHistory();
  await renderNow();
}

function scheduleRender() {
  state.renderGeneration++;
  clearTimeout(renderTimer);renderTimer=setTimeout(renderNow,180);
}
async function renderNow() {
  clearTimeout(renderTimer);
  if(!state.active)return;
  if(state.rendering){state.renderPending=true;return;}
  state.rendering=true;state.renderPending=false;$('render-status').hidden=false;
  const id=state.active,edits=clone(state.edits),generation=state.renderGeneration;
  if(state.crop) edits.crop=[0,0,1,1];
  try{
    const response=await request(`/api/assets/${id}/preview`,{method:'POST',body:{edits}});
    const blob=await response.blob();const meta=JSON.parse(response.headers.get('X-Studio-Meta'));
    if(id!==state.active||generation!==state.renderGeneration){state.renderPending=true;return;}
    const url=URL.createObjectURL(blob);
    const old=editedURL;editedURL=url;
    await new Promise((resolve,reject)=>{const image=new Image();image.onload=resolve;image.onerror=reject;image.src=url;});
    $('edited-image').src=url;if(old)URL.revokeObjectURL(old);
    $('image-frame').hidden=false;$('image-error').hidden=true;
    state.meta=meta;fitImage();drawHistogram(meta.histogram);
    $('pixel-size').textContent=`Preview ${meta.width} × ${meta.height}`;
    const key=JSON.stringify([id,edits.mode,edits.crop,edits.rotation,edits.quarter_turns]);
    if(state.compare&&state.beforeKey!==key)await loadBefore(id,edits,key,generation);
  }catch(error){
    const message=error.message||'This photograph could not be developed';
    if(id===state.active){$('image-frame').hidden=true;$('image-error').hidden=false;$('image-error-message').textContent=message;}
    toast(message,true);
  }
  finally{
    state.rendering=false;$('render-status').hidden=true;
    if(state.renderPending){state.renderPending=false;renderNow();}
  }
}
async function loadBefore(id,edits,key,generation=state.renderGeneration){
  const response=await request(`/api/assets/${id}/preview`,{method:'POST',body:{edits,before:true}});
  const blob=await response.blob();
  if(id!==state.active||generation!==state.renderGeneration)return;
  if(beforeURL)URL.revokeObjectURL(beforeURL);beforeURL=URL.createObjectURL(blob);
  $('before-image').src=beforeURL;state.beforeKey=key;
}

function fitImage(){
  if(!state.meta)return;
  const stage=$('stage'),frame=$('image-frame');
  let width=state.meta.width,height=state.meta.height;
  if(state.zoom==='fit'){
    const style=getComputedStyle(stage),availW=stage.clientWidth-parseFloat(style.paddingLeft)-parseFloat(style.paddingRight),availH=stage.clientHeight-parseFloat(style.paddingTop)-parseFloat(style.paddingBottom);
    const factor=Math.min(1,availW/width,availH/height);width*=factor;height*=factor;
  }
  frame.style.width=`${Math.max(1,width)}px`;frame.style.height=`${Math.max(1,height)}px`;
}
function setZoom(mode){state.zoom=mode;$('stage').classList.toggle('zoomed',mode==='100');$('zoom-fit').classList.toggle('active',mode==='fit');$('zoom-100').classList.toggle('active',mode==='100');fitImage();}
new ResizeObserver(fitImage).observe($('stage'));

function drawHistogram(data){
  const canvas=$('histogram'),ctx=canvas.getContext('2d');ctx.clearRect(0,0,canvas.width,canvas.height);
  ctx.strokeStyle='#53644655';ctx.lineWidth=1;
  for(let x=0;x<=4;x++){ctx.beginPath();ctx.moveTo(x*canvas.width/4,0);ctx.lineTo(x*canvas.width/4,canvas.height);ctx.stroke();}
  if(!data)return;
  const max=Math.max(1,...data.channels.flat());
  ['#c78777','#a1bd85','#87a3b3'].forEach((color,c)=>{
    ctx.beginPath();ctx.moveTo(0,canvas.height);
    data.channels[c].forEach((v,i)=>ctx.lineTo(i/(data.channels[c].length-1)*canvas.width,canvas.height-(v/max)**.65*(canvas.height-5)));
    ctx.lineTo(canvas.width,canvas.height);ctx.closePath();ctx.fillStyle=color+'55';ctx.fill();ctx.strokeStyle=color+'cc';ctx.lineWidth=1;ctx.stroke();
  });
  $('shadow-percent').textContent=`${(data.shadows*100).toFixed(1)}%`;$('highlight-percent').textContent=`${(data.highlights*100).toFixed(1)}%`;
}

function drawCurve(){
  const canvas=$('tone-curve');if(!canvas)return;const ctx=canvas.getContext('2d'),w=canvas.width,h=canvas.height;
  ctx.clearRect(0,0,w,h);ctx.lineWidth=1;ctx.strokeStyle='#65734e55';
  for(let i=0;i<=4;i++){ctx.beginPath();ctx.moveTo(i*w/4,0);ctx.lineTo(i*w/4,h);ctx.moveTo(0,i*h/4);ctx.lineTo(w,i*h/4);ctx.stroke();}
  ctx.beginPath();ctx.moveTo(0,h);ctx.lineTo(w,0);ctx.strokeStyle='#8d9c7044';ctx.stroke();
  const points=(state.edits||state.defaults).curve;ctx.beginPath();points.forEach(([x,y],i)=>i?ctx.lineTo(x*w,(1-y)*h):ctx.moveTo(x*w,(1-y)*h));ctx.strokeStyle='#d5e6b0';ctx.lineWidth=2;ctx.stroke();
  for(const [x,y]of points){ctx.beginPath();ctx.arc(x*w,(1-y)*h,5,0,Math.PI*2);ctx.fillStyle='#d5e6b0';ctx.fill();}
}
function setupCurve(canvas){
  let dragging=-1;
  const point=(e)=>{const r=canvas.getBoundingClientRect();return[clamp((e.clientX-r.left)/r.width,0,1),clamp(1-(e.clientY-r.top)/r.height,0,1)];};
  const nearest=(x,y)=>state.edits.curve.findIndex(p=>Math.hypot(p[0]-x,p[1]-y)<.07);
  canvas.addEventListener('pointerdown',e=>{
    if(!state.active)return;const[x,y]=point(e);let idx=nearest(x,y);
    state.undo.push(clone(state.edits));state.redo=[];
    if(idx<0){if(state.edits.curve.length>=12)return;state.edits.curve.push([clamp(x,.01,.99),y]);state.edits.curve.sort((a,b)=>a[0]-b[0]);idx=state.edits.curve.findIndex(p=>p[1]===y&&Math.abs(p[0]-x)<.02);}
    dragging=idx;canvas.setPointerCapture(e.pointerId);drawCurve();
  });
  canvas.addEventListener('pointermove',e=>{
    if(dragging<0)return;const[x,y]=point(e),points=state.edits.curve;
    points[dragging]=[dragging===0?0:dragging===points.length-1?1:clamp(x,points[dragging-1][0]+.005,points[dragging+1][0]-.005),y];
    refreshControls();scheduleRender();scheduleSave();
  });
  const end=()=>{if(dragging>=0){dragging=-1;refreshControls();scheduleRender();scheduleSave();$('undo-button').disabled=false;}};
  canvas.addEventListener('pointerup',end);canvas.addEventListener('pointercancel',end);
  canvas.addEventListener('dblclick',e=>{if(!state.active)return;const[x,y]=point(e),i=nearest(x,y);if(i>0&&i<state.edits.curve.length-1)change(ed=>ed.curve.splice(i,1));});
}

function panel(name){
  const same=state.panel===name;
  state.panel=name;
  document.querySelectorAll('.side-panel').forEach(p=>{p.hidden=p.id!==`panel-${name}`;});
  document.querySelectorAll('[data-panel]').forEach(b=>b.classList.toggle('active',b.dataset.panel===name));
  if(window.innerWidth<=850){if(same)$('panel-library').parentElement.classList.toggle('visible');else $('panel-library').parentElement.classList.add('visible');}
  if(name==='history')loadHistory();refreshControls();
}
async function loadHistory(){
  $('history-list').replaceChildren();if(!state.active)return;
  await flushSave();const id=state.active;
  try{
    const rows=await json(`/api/assets/${id}/history`);if(id!==state.active)return;
    for(const row of rows){const b=document.createElement('button');b.className='history-item';b.textContent=row.revision===0?'Original import':`Revision ${row.revision}`;const small=document.createElement('small');small.textContent=new Date(row.created*1000).toLocaleString();b.append(small);b.onclick=()=>change(e=>{Object.assign(e,clone(row.edits));buildMaskControls();});$('history-list').append(b);}
  }catch(error){toast(error.message,true);}
}

function renderRating(){
  const asset=active();if(!asset)return;$('stars').replaceChildren();
  for(let i=1;i<=5;i++){const b=document.createElement('button');b.textContent=i<=asset.rating?'★':'☆';b.classList.toggle('active',i<=asset.rating);b.title=`${i} star${i>1?'s':''}`;b.setAttribute('aria-label',b.title);b.onclick=()=>mark(asset.rating===i?0:i,asset.flag);$('stars').append(b);}
  $('pick-button').classList.toggle('active',asset.flag==='pick');$('reject-button').classList.toggle('active',asset.flag==='reject');
}
async function mark(rating,flag){if(!active())return;try{upsert(await json(`/api/assets/${state.active}/mark`,{method:'POST',body:{rating,flag}}));renderRating();renderLibrary();}catch(error){toast(error.message,true);}}

function buildMaskControls(){
  const masks=state.edits?.masks||[];$('mask-select').replaceChildren(new Option('No mask selected',''));
  masks.forEach((m,i)=>$('mask-select').append(new Option(`${i+1} · ${m.type==='radial'?'Radial light':'Linear gradient'}`,String(i))));
  if(state.mask>=masks.length)state.mask=-1;$('mask-select').value=state.mask<0?'':String(state.mask);
  const box=$('mask-settings');box.replaceChildren();box.hidden=state.mask<0;
  if(state.mask<0){$('mask-overlay').hidden=true;return;}
  box.className='mask-settings';
  for(const[key,label,min,max,step]of[['exposure','Exposure',-3,3,.05],['temperature','Warmth',-100,100,1],['saturation','Saturation',-100,100,1],['radius','Size',.02,2,.01],['feather','Feather',.01,1,.01],['angle','Angle',-180,180,1]]){
    if(key==='angle'&&masks[state.mask].type!=='linear')continue;
    box.append(slider(`mask-${key}`,label,min,max,step,(value,hist)=>change(e=>{if(e.masks[state.mask])e.masks[state.mask][key]=value;},hist)));
  }
  const label=document.createElement('label');label.className='mask-check';const check=document.createElement('input');check.type='checkbox';check.checked=masks[state.mask].invert;check.onchange=()=>change(e=>{e.masks[state.mask].invert=check.checked;});label.append(check,document.createTextNode('Invert mask'));box.append(label);
  const button=document.createElement('button');button.className='mask-delete';button.textContent='Remove mask';button.onclick=()=>{change(e=>{e.masks.splice(state.mask,1);state.mask=-1;});buildMaskControls();};box.append(button);
  $('mask-overlay').hidden=false;refreshControls();
}
function refreshMaskGuide(){
  const mask=state.edits?.masks[state.mask];if(!mask)return;const guide=$('mask-guide');guide.style.left=`${mask.x*100}%`;guide.style.top=`${mask.y*100}%`;guide.style.width=`${mask.radius*200}%`;guide.style.height=`${mask.radius*200}%`;guide.classList.toggle('linear',mask.type==='linear');guide.style.transform=`translate(-50%,-50%) rotate(${mask.type==='linear'?mask.angle-90:0}deg)`;
}
function addMask(type){
  if(!state.active)return;if(state.edits.masks.length>=8){toast('A photograph can have up to 8 local masks.');return;}
  if(state.crop)cancelCrop();
  change(e=>{e.masks.push({type,x:.5,y:.5,radius:.4,angle:90,feather:.7,invert:false,exposure:.3,temperature:0,saturation:0});state.mask=e.masks.length-1;});buildMaskControls();$('masks-section').scrollIntoView({block:'nearest'});
}
$('mask-overlay').addEventListener('pointerdown',e=>{if(state.mask<0)return;const rect=$('image-frame').getBoundingClientRect();change(ed=>{ed.masks[state.mask].x=clamp((e.clientX-rect.left)/rect.width,0,1);ed.masks[state.mask].y=clamp((e.clientY-rect.top)/rect.height,0,1);});});

function beginCrop(){
  if(!state.active)return;if(state.crop){cancelCrop();return;}
  state.crop=clone(state.edits.crop);state.pendingCrop=clone(state.edits.crop);$('crop-overlay').hidden=false;$('crop-toolbar').hidden=false;$('mask-overlay').hidden=true;$('crop-button').classList.add('active');setCompare(false);setZoom('fit');scheduleRender();showCrop();
}
function showCrop(){const[x,y,w,h]=state.pendingCrop;Object.assign($('crop-box').style,{left:`${x*100}%`,top:`${y*100}%`,width:`${w*100}%`,height:`${h*100}%`});}
function cancelCrop(){state.crop=null;$('crop-overlay').hidden=true;$('crop-toolbar').hidden=true;$('crop-button').classList.remove('active');scheduleRender();}
let cropStart;
$('crop-overlay').addEventListener('pointerdown',e=>{const r=$('image-frame').getBoundingClientRect();cropStart=[clamp((e.clientX-r.left)/r.width,0,1),clamp((e.clientY-r.top)/r.height,0,1)];e.currentTarget.setPointerCapture(e.pointerId);});
$('crop-overlay').addEventListener('pointermove',e=>{
  if(!cropStart)return;const r=$('image-frame').getBoundingClientRect();const end=[clamp((e.clientX-r.left)/r.width,0,1),clamp((e.clientY-r.top)/r.height,0,1)];let w=Math.abs(end[0]-cropStart[0]),h=Math.abs(end[1]-cropStart[1]);
  const aspect=Number($('crop-aspect').value);if(aspect){h=w*(r.width/r.height)/aspect;if(h>1){h=1;w=aspect/(r.width/r.height);}}
  w=clamp(w,.01,1);h=clamp(h,.01,1);
  const x=clamp(Math.min(end[0],cropStart[0]),0,1-w),y=clamp(Math.min(end[1],cropStart[1]),0,1-h);
  state.pendingCrop=[x,y,w,h];showCrop();
});
['pointerup','pointercancel'].forEach(type=>$('crop-overlay').addEventListener(type,()=>{cropStart=null;}));

async function setCompare(value){
  state.compare=value;for(const id of ['before-image','compare-divider','before-label','after-label','compare-toolbar'])$(id).hidden=!value;$('compare-button').classList.toggle('active',value);
  if(value&&state.active){try{const e=clone(state.edits),key=JSON.stringify([state.active,e.mode,e.crop,e.rotation,e.quarter_turns]);if(state.beforeKey!==key)await loadBefore(state.active,e,key);}catch(error){toast(error.message,true);}}
}

async function importFiles(files){
  if(state.importBusy){toast('Please wait for the current import to finish.');return;}
  state.importBusy=true;let imported=0,first;
  for(const file of files){
    try{saveLabel(`Importing ${file.name}…`);const asset=await json(`/api/import?name=${encodeURIComponent(file.name)}`,{method:'POST',raw:file});upsert(asset);first??=asset.id;imported++;renderLibrary();}
    catch(error){toast(`${file.name}: ${error.message}`,true);}
  }
  state.importBusy=false;saveLabel('Originals imported');if(first)await selectPhoto(first);if(imported)toast(`${imported} photograph${imported===1?'':'s'} imported. Original files are stored separately from edits.`);
}

async function download(path, options, filename){
  const response=await request(path,options),blob=await response.blob();const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=filename;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),60000);return response;
}
function showExport(){
  if(!active())return;const preview=active().kind==='raf'&&state.edits.mode==='camera'&&!active().has_render;
  $('preview-export-label').hidden=!preview;$('allow-preview').checked=false;$('export-state').textContent='';$('export-confirm').disabled=false;$('export-dialog').showModal();
}
async function doExport(){
  const asset=active();if(!asset)return;
  if(state.crop){toast('Finish or cancel your crop before exporting.',true);return;}
  const format=$('export-format').value,size=Number($('export-size').value),quality=Number($('export-quality').value),allow=$('allow-preview').checked;
  const preview=asset.kind==='raf'&&state.edits.mode==='camera'&&!asset.has_render;
  if(preview&&!allow){$('export-state').textContent='Please acknowledge the embedded-preview limit, or attach a full rendering first.';return;}
  $('export-confirm').disabled=true;$('export-state').textContent='Developing the full photograph. Keep this window open…';
  try{
    await flushSave();const ext={jpeg:'jpg',png:'png',tiff16:'tif'}[format];const name=asset.name.replace(/\.[^.]+$/,'')+(preview?'-preview':'-studio')+'.'+ext;
    await download(`/api/assets/${asset.id}/export`,{method:'POST',body:{edits:state.edits,format,max_edge:size,quality,allow_preview:allow}},name);
    $('export-state').textContent='Export ready. Check your downloads.';toast('Your edited copy is ready.');
  }catch(error){$('export-state').textContent=error.message;toast(error.message,true);}
  finally{$('export-confirm').disabled=false;}
}

function showMetadata(){
  const asset=active();$('photo-metadata').replaceChildren();
  if(!asset){$('photo-metadata').textContent='Select a photograph to see its details.';$('info-dialog').showModal();return;}
  const dl=document.createElement('dl');dl.className='metadata-table';
  const values={File:asset.name,'Original SHA-256':asset.id,'Edit revision':asset.revision,...Object.fromEntries(Object.entries(asset.metadata).filter(([k])=>k!=='exiftool')),...asset.metadata.exiftool};
  for(const[key,value]of Object.entries(values)){const dt=document.createElement('dt');dt.textContent=key;const dd=document.createElement('dd');dd.textContent=typeof value==='object'?JSON.stringify(value):String(value);dl.append(dt,dd);}
  $('photo-metadata').append(dl);$('info-dialog').showModal();
}

function setupEvents(){
  const open=()=>$('file-input').click();for(const id of ['import-button','sidebar-import','welcome-import'])$(id).onclick=open;
  $('file-input').onchange=e=>{const files=Array.from(e.target.files);e.target.value='';importFiles(files);};
  $('demo-button').onclick=async()=>{try{const asset=await json('/api/demo',{method:'POST',body:{}});upsert(asset);await selectPhoto(asset.id);toast('Synthetic landscape loaded for testing controls. It is not a camera photograph.');}catch(error){toast(error.message,true);}};
  document.querySelectorAll('[data-panel]').forEach(b=>b.onclick=()=>panel(b.dataset.panel));
  document.querySelectorAll('[data-filter]').forEach(b=>b.onclick=()=>{state.filter=b.dataset.filter;document.querySelectorAll('[data-filter]').forEach(x=>x.classList.toggle('active',x===b));renderLibrary();});
  $('photo-search').oninput=e=>{state.query=e.target.value;renderLibrary();};$('photo-sort').onchange=e=>{state.sort=e.target.value;renderLibrary();};
  $('undo-button').onclick=()=>undo();$('redo-button').onclick=()=>undo(true);
  $('reset-button').onclick=()=>{change(e=>{const mode=e.mode;Object.assign(e,clone(state.defaults),{mode});});state.mask=-1;buildMaskControls();};
  $('development-mode').onchange=e=>{state.beforeKey='';change(ed=>{ed.mode=e.target.value;});};
  $('zoom-fit').onclick=()=>setZoom('fit');$('zoom-100').onclick=()=>{setZoom('100');toast('100% displays the working preview pixel for pixel. Exports use the selected source resolution.');};
  $('compare-button').onclick=()=>setCompare(!state.compare);
  $('compare-slider').oninput=e=>{const v=Number(e.target.value);$('before-image').style.clipPath=`inset(0 ${100-v}% 0 0)`;$('compare-divider').style.left=`${v}%`;};
  $('crop-button').onclick=beginCrop;$('crop-cancel').onclick=cancelCrop;
  $('crop-reset').onclick=()=>{state.pendingCrop=[0,0,1,1];showCrop();};
  $('crop-apply').onclick=()=>{const crop=clone(state.pendingCrop);state.crop=null;$('crop-overlay').hidden=true;$('crop-toolbar').hidden=true;$('crop-button').classList.remove('active');change(e=>{e.crop=crop;});};
  $('rotate-button').onclick=()=>{if(state.crop)cancelCrop();change(e=>{e.quarter_turns=(e.quarter_turns+1)%4;e.crop=[0,0,1,1];});};
  $('mask-button').onclick=()=>{if(state.crop)cancelCrop();if(state.mask<0)addMask('radial');else $('mask-overlay').hidden=!$('mask-overlay').hidden;};
  $('add-radial').onclick=()=>addMask('radial');$('add-linear').onclick=()=>addMask('linear');
  $('mask-select').onchange=e=>{state.mask=e.target.value===''?-1:Number(e.target.value);buildMaskControls();};
  $('pick-button').onclick=()=>{if(active())mark(active().rating,active().flag==='pick'?'':'pick');};
  $('reject-button').onclick=()=>{if(active())mark(active().rating,active().flag==='reject'?'':'reject');};
  $('export-button').onclick=showExport;$('export-confirm').onclick=doExport;
  $('export-quality').oninput=e=>{$('quality-value').textContent=e.target.value;};
  $('export-format').onchange=e=>{const hidden=e.target.value!=='jpeg';$('export-quality').hidden=hidden;$('jpeg-quality-label').hidden=hidden;};
  $('info-button').onclick=showMetadata;
  $('save-sidecar').onclick=async()=>{if(!active())return;try{if(!await flushSave())throw new Error('Save your pending adjustments before downloading the sidecar.');await download(`/api/assets/${state.active}/sidecar`,{},active().name.replace(/\.[^.]+$/,'')+'.fujiframe.json');}catch(error){toast(error.message,true);}};
  $('attach-rendering').onclick=()=>$('rendering-input').click();
  $('rendering-input').onchange=async e=>{const file=e.target.files[0],id=state.active;e.target.value='';if(!file||!id)return;try{const asset=await json(`/api/assets/${id}/rendering?name=${encodeURIComponent(file.name)}`,{method:'POST',raw:file});upsert(asset);state.beforeKey='';if(id===state.active){refreshColorNotice();scheduleRender();}toast('Rendering attached. Select Source rendering to edit its camera color.');}catch(error){toast(error.message,true);}};
  $('import-lut').onclick=()=>$('lut-input').click();
  $('lut-input').onchange=async e=>{const file=e.target.files[0];e.target.value='';if(!file)return;try{const lut=await json(`/api/luts?name=${encodeURIComponent(file.name)}`,{method:'POST',raw:file});state.luts=state.luts.filter(l=>l.id!==lut.id);state.luts.push(lut);buildLooks();if(active())change(ed=>{ed.lut_id=lut.id;});toast('3D LUT imported.');}catch(error){toast(error.message,true);}};
  $('lut-select').onchange=e=>change(ed=>{ed.lut_id=e.target.value||null;});
  $('integration-button').onclick=()=>{$('integration-dialog').showModal();};
  $('launch-xraw').onclick=async()=>{try{await json('/api/xraw/open',{method:'POST',body:{}});$('xraw-status').textContent='Launch requested. Open your RAF in X RAW Studio.';}catch(error){$('xraw-status').textContent=error.message;}};
  $('watch-save').onclick=async()=>{try{const result=await json('/api/watch',{method:'POST',body:{path:$('watch-path').value}});$('watch-status').textContent=`Watching ${result.path}. New completed files will appear automatically.`;}catch(error){$('watch-status').textContent=error.message;}};
  $('watch-stop').onclick=async()=>{try{await json('/api/watch',{method:'POST',body:{path:null}});$('watch-path').value='';$('watch-status').textContent='Folder watching stopped.';}catch(error){$('watch-status').textContent=error.message;}};
  $('reload-button').onclick=()=>location.reload();
  let dragDepth=0;
  document.addEventListener('dragenter',e=>{if([...e.dataTransfer.types].includes('Files')){e.preventDefault();dragDepth++;$('drop-overlay').hidden=false;}});
  document.addEventListener('dragover',e=>{if([...e.dataTransfer.types].includes('Files'))e.preventDefault();});
  document.addEventListener('dragleave',()=>{dragDepth--;if(dragDepth<=0)$('drop-overlay').hidden=true;});
  document.addEventListener('drop',e=>{e.preventDefault();dragDepth=0;$('drop-overlay').hidden=true;if(e.dataTransfer.files.length)importFiles(Array.from(e.dataTransfer.files));});
  document.addEventListener('keydown',e=>{
    if(['INPUT','TEXTAREA','SELECT'].includes(document.activeElement.tagName)||document.querySelector('dialog[open]'))return;
    if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='z'){e.preventDefault();undo(e.shiftKey);}
    else if(e.key==='\\'&&state.active)setCompare(!state.compare);
    else if(e.key.toLowerCase()==='p'&&active())mark(active().rating,active().flag==='pick'?'':'pick');
    else if(e.key.toLowerCase()==='x'&&active())mark(active().rating,active().flag==='reject'?'':'reject');
    else if(/^[0-5]$/.test(e.key)&&active())mark(Number(e.key),active().flag);
    else if(e.key==='Escape'){if(state.crop)cancelCrop();$('mask-overlay').hidden=true;}
    else if(e.key==='ArrowRight'||e.key==='ArrowLeft'){const idx=state.assets.findIndex(a=>a.id===state.active);const next=state.assets[idx+(e.key==='ArrowRight'?1:-1)];if(next)selectPhoto(next.id);}
  });
  window.addEventListener('beforeunload',e=>{if(state.dirty.size||state.saving){e.preventDefault();e.returnValue='';}});
  let pan;
  $('stage').addEventListener('pointerdown',e=>{if(state.zoom!=='100'||state.crop||!$('mask-overlay').hidden)return;pan=[e.clientX,e.clientY,$('stage').scrollLeft,$('stage').scrollTop];$('stage').setPointerCapture(e.pointerId);$('stage').classList.add('dragging');});
  $('stage').addEventListener('pointermove',e=>{if(pan){$('stage').scrollLeft=pan[2]-(e.clientX-pan[0]);$('stage').scrollTop=pan[3]-(e.clientY-pan[1]);}});
  ['pointerup','pointercancel'].forEach(type=>$('stage').addEventListener(type,()=>{pan=null;$('stage').classList.remove('dragging');}));
}

function undo(redo=false){
  const from=redo?state.redo:state.undo,to=redo?state.undo:state.redo;if(!from.length)return;to.push(clone(state.edits));state.edits=from.pop();state.mask=-1;buildMaskControls();refreshControls();scheduleRender();scheduleSave();$('undo-button').disabled=!state.undo.length;$('redo-button').disabled=!state.redo.length;
}

async function pollCatalog(){
  try{if(document.hidden||state.importBusy)return;const assets=await json('/api/assets');let changed=false;
    for(const asset of assets){if(!state.assets.some(a=>a.id===asset.id)){upsert(asset);changed=true;}}
    if(changed){renderLibrary();toast('New photographs arrived in your watched folder.');}
  }catch{/* Retain the active editing state if the desktop process is temporarily unavailable. */}
}

async function init(){
  try{
    const data=await json('/api/state');Object.assign(state,{assets:data.assets,csrf:data.csrf,defaults:data.defaults,looks:data.looks,luts:data.luts});
    $('project-name').textContent=data.project_name;$('watch-path').value=data.watch_folder||'';
    if(!data.capabilities.watch_folder){$('watch-save').disabled=true;$('watch-stop').disabled=true;$('watch-status').textContent='Run the desktop app to watch a folder on your computer.';}
    if(!data.capabilities.x_raw_studio)$('xraw-status').textContent=data.capabilities.preview_environment?'Launch the desktop app to use X RAW Studio.':'Install X RAW Studio, or point Studio to the installed application with --x-raw-studio.';
    if(data.watch_folder)$('watch-status').textContent=`Watching ${data.watch_folder}`;
    buildControls();buildLooks();renderLibrary();drawHistogram(null);setupEvents();
    if(state.assets.length)await selectPhoto(state.assets[0].id);
    setInterval(pollCatalog,5000);
  }catch(error){$('fatal-error').hidden=false;$('fatal-message').textContent=`${error.message}. Start the desktop service with “python -m studio”, then reload this page.`;$('reload-button').onclick=()=>location.reload();}
}
init();
