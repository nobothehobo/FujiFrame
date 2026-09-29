import { layout, paint } from './framing.js';
import { extractMetadata, attachMetadata } from './metadata.js';
import { makeZip } from './archive.js';
import { tiledPng } from './png-export.js';
const $ = id => document.getElementById(id);
const photos = [], outputs = [];
let selected = 0, busy = false, pendingPreview = 0;
const keys = ['ratio','border','bottom','paper','watermark','placement','corner','font','ink','textSize','opacity','resolution','metadata'];
function settings() {
  const value = Object.fromEntries(keys.map(key => [key, $(key).type === 'checkbox' ? $(key).checked : $(key).value]));
  for (const key of ['border','textSize','opacity']) value[key] = Number(value[key]);
  return value;
}
function tell(message) { $('status').textContent = message; }
function lock(value) {
  busy = value;
  document.querySelectorAll('#settings input,#settings select,#settings button,#choose,#add,#clear,#filmstrip button,#export,#zip').forEach(el => { el.disabled = value; });
  $('export').disabled = value || !photos.length;
}
function invalidate() {
  for (const output of outputs) { URL.revokeObjectURL(output.url); URL.revokeObjectURL(output.previewUrl); }
  outputs.length = 0; $('exports').replaceChildren(); $('results').hidden = true;
}
function syncControls() {
  for (const key of ['border','textSize','opacity']) $(key + '-value').value = $(key).value + '%';
  $('metadata-hint').textContent = $('metadata').value === 'keep'
    ? 'Includes GPS if present. Standard EXIF, basic XMP and PNG text only; see the note below.'
    : 'Camera details, dates and GPS are excluded from the export.';
  document.querySelectorAll('#swatches button').forEach(el => el.setAttribute('aria-pressed', String(el.dataset.color === $('paper').value)));
  $('paper-name').textContent = document.querySelector('#swatches button[aria-pressed="true"]')?.getAttribute('aria-label') || 'Custom paper';
}
function refresh() {
  invalidate(); syncControls();
  cancelAnimationFrame(pendingPreview);
  pendingPreview = requestAnimationFrame(preview);
}
function preview() {
  $('empty').hidden = !!photos.length; $('preview').hidden = !photos.length;
  $('add').hidden = $('clear').hidden = !photos.length;
  $('export').disabled = busy || !photos.length;
  if (!photos.length) { $('photo-info').textContent = 'No uploads. No account. Just your photographs.'; return; }
  const photo = photos[selected], opts = settings(), g = layout(photo.width, photo.height, opts, photos);
  const scale = Math.min(1, 1100 / Math.max(g.width, g.height));
  const small = Object.fromEntries(Object.entries(g).map(([key, value]) => [key, value * scale]));
  const canvas = $('preview'); canvas.width = Math.max(1, Math.round(small.width)); canvas.height = Math.max(1, Math.round(small.height));
  paint(canvas.getContext('2d'), photo.thumb, small, opts);
  $('photo-info').textContent = `${selected + 1} / ${photos.length} · ${photo.file.name} · ${photo.width} × ${photo.height} → ${g.width} × ${g.height}px`;
}
function strip() {
  $('filmstrip').replaceChildren();
  photos.forEach((photo, index) => {
    const item = document.createElement('div'); item.className = 'film-item';
    const button = document.createElement('button'); button.className = 'thumb' + (index === selected ? ' active' : '');
    button.title = photo.file.name; button.setAttribute('aria-label', `Preview photo ${index + 1}: ${photo.file.name}`);
    button.setAttribute('aria-pressed', String(index === selected));
    const image = document.createElement('img'); image.src = photo.thumbUrl; image.alt = ''; button.append(image);
    button.onclick = () => { selected = index; strip(); preview(); };
    const actions = document.createElement('div'); actions.className = 'film-actions';
    const number = document.createElement('span'); number.textContent = String(index + 1).padStart(2, '0'); actions.append(number);
    for (const [label, title, delta] of [['←','Move earlier',-1],['→','Move later',1],['×','Remove photo',0]]) {
      const action = document.createElement('button'); action.textContent = label; action.setAttribute('aria-label', `${title} ${index + 1}`);
      action.disabled = busy || (delta !== 0 && (index + delta < 0 || index + delta >= photos.length));
      action.onclick = () => {
        if (busy) return;
        if (delta) { [photos[index], photos[index + delta]] = [photos[index + delta], photos[index]]; selected = index + delta; }
        else { photo.thumb.close?.(); URL.revokeObjectURL(photo.thumbUrl); photos.splice(index, 1); selected = Math.max(0, Math.min(selected, photos.length - 1)); }
        strip(); refresh();
      }; actions.append(action);
    }
    item.append(button, actions); $('filmstrip').append(item);
  });
}
async function decode(file) {
  // ImageBitmap applies EXIF orientation. <img> fallback supports older Safari.
  if (typeof createImageBitmap === 'function') {
    try { return await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch { /* fallback */ }
  }
  const image = new Image(), url = URL.createObjectURL(file);
  try { image.src = url; await image.decode(); return image; } finally { URL.revokeObjectURL(url); }
}
function dimensions(image) { return [image.naturalWidth || image.width, image.naturalHeight || image.height]; }
function toBlob(canvas) {
  return new Promise((resolve, reject) => {
    try { canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('Canvas export failed')), 'image/png'); }
    catch (error) { reject(error); }
  });
}
async function addFiles(files) {
  if (busy) return;
  lock(true); invalidate(); const errors = [];
  try {
    for (const file of files) {
      if (photos.length >= 20) { errors.push('Batch limit is 20 photos.'); break; }
      if (!/\.(jpe?g|png|webp)$/i.test(file.name)) { errors.push(`${file.name}: choose JPEG, PNG or WebP (export RAW/HEIC first).`); continue; }
      tell(`Opening ${file.name}…`);
      let image;
      try {
        image = await decode(file); const [width, height] = dimensions(image);
        if (!width || !height) throw new Error('Image has no dimensions');
        const canvas = document.createElement('canvas'), scale = Math.min(1, 1100 / Math.max(width, height));
        canvas.width = Math.max(1, Math.round(width * scale)); canvas.height = Math.max(1, Math.round(height * scale));
        canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
        const blob = await toBlob(canvas), thumbUrl = URL.createObjectURL(blob), thumb = new Image();
        thumb.src = thumbUrl;
        try { await thumb.decode(); } catch (error) { URL.revokeObjectURL(thumbUrl); throw error; }
        photos.push({ file, width, height, thumb, thumbUrl });
        canvas.width = canvas.height = 1;
      } catch { errors.push(`${file.name}: unable to open this image. Try a camera JPEG or desktop browser.`); }
      finally { image?.close?.(); }
    }
    selected = Math.min(selected, Math.max(0, photos.length - 1)); strip(); preview();
    tell(errors.length ? errors.join('\n') : `${photos.length} photo${photos.length === 1 ? '' : 's'} ready. Choose your mat, then prepare.`);
  } finally { lock(false); }
}
function download(blob, name) {
  const url = URL.createObjectURL(blob), a = document.createElement('a'); a.href = url; a.download = name;
  document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 60000);
}
function canShare(files) { try { return !!navigator.canShare?.({ files }); } catch { return false; } }
async function share(files) {
  try { await navigator.share({ files }); tell('Share sheet opened. Choose Save Image(s) to add to Photos.'); }
  catch (error) { if (error.name !== 'AbortError') tell('Sharing is unavailable for these files. Use Download or Open photo instead.'); }
}
function showOutput(output) {
  const card = document.createElement('article'); card.className = 'export-card';
  // Reuse small preview so a grid of 40MP exports does not decode all at once.
  const img = document.createElement('img'); img.src = output.previewUrl; img.alt = output.file.name;
  const text = document.createElement('p'); text.textContent = `${output.file.name}\n${output.width} × ${output.height} · ${(output.file.size / 1048576).toFixed(1)} MB`;
  const save = document.createElement('a'); save.href = output.url; save.download = output.file.name; save.textContent = 'Download';
  const open = document.createElement('a'); open.href = output.url; open.target = '_blank'; open.rel = 'noopener'; open.textContent = 'Open photo';
  card.append(img, text, save, open);
  if (canShare([output.file])) { const button = document.createElement('button'); button.textContent = 'Share / Save Image'; button.onclick = () => share([output.file]); card.append(button); }
  $('exports').append(card);
}
async function prepare() {
  if (busy || !photos.length) return;
  lock(true); invalidate(); const opts = settings(), errors = [], warnings = new Set();
  try {
    for (let i = 0; i < photos.length; i++) {
      const photo = photos[i], g = layout(photo.width, photo.height, opts, photos);
      tell(`Preparing ${i + 1} of ${photos.length}: ${photo.file.name}…`);
      await new Promise(resolve => requestAnimationFrame(resolve));
      let image, canvas;
      try {
        image = await decode(photo.file);
        let blob;
        if (g.width * g.height > 12000000) blob = await tiledPng(image, g, opts);
        else {
          canvas = document.createElement('canvas'); canvas.width = g.width; canvas.height = g.height;
          const ctx = canvas.getContext('2d', { colorSpace: 'srgb' });
          if (!ctx) throw new Error('No canvas available');
          paint(ctx, image, g, opts);
          const pixel = ctx.getImageData(0, 0, 1, 1).data;
          if (pixel[3] === 0) throw new Error('Canvas exceeds device limit');
          blob = await toBlob(canvas);
        }
        if (opts.metadata === 'keep') {
          const metadata = extractMetadata(new Uint8Array(await photo.file.arrayBuffer()));
          metadata.warnings.forEach(warning => warnings.add(warning));
          // Malformed metadata fails this file instead of silently dropping it.
          blob = await attachMetadata(blob, metadata, g.width, g.height);
        }
        const stem = photo.file.name.replace(/\.[^.]+$/, '').replace(/[^\p{L}\p{N}._-]/gu, '_').slice(0, 80);
        const file = new File([blob], `${String(i + 1).padStart(2, '0')}_${stem}_framed.png`, { type: 'image/png' });
        const thumb = document.createElement('canvas'), scale = Math.min(1, 600 / Math.max(g.width, g.height));
        thumb.width = Math.max(1, Math.round(g.width * scale)); thumb.height = Math.max(1, Math.round(g.height * scale));
        const small = Object.fromEntries(Object.entries(g).map(([key, value]) => [key, value * scale]));
        paint(thumb.getContext('2d'), photo.thumb, small, opts);
        const previewUrl = URL.createObjectURL(await toBlob(thumb)); thumb.width = thumb.height = 1;
        const output = { file, url: URL.createObjectURL(file), previewUrl, width: g.width, height: g.height };
        outputs.push(output); showOutput(output);
      } catch (error) {
        errors.push(`${photo.file.name}: export failed (${error.message}). Try a smaller copy or a desktop browser. If keeping metadata fails, try Exclude.`);
      } finally { image?.close?.(); if (canvas) canvas.width = canvas.height = 1; }
    }
    $('results').hidden = !outputs.length;
    $('share-all').hidden = !outputs.length || !canShare(outputs.map(output => output.file));
    tell([`${outputs.length} of ${photos.length} photos prepared${errors.length ? ' — some need attention' : '. Ready to save'}.`, ...warnings, ...errors].join('\n'));
    if (outputs.length) $('results').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
  } finally { lock(false); }
}
$('settings').addEventListener('submit', event => event.preventDefault());
$('settings').addEventListener('input', refresh);
document.querySelectorAll('#swatches button').forEach(button => { button.onclick = () => { $('paper').value = button.dataset.color; refresh(); }; });
for (const id of ['choose','add']) $(id).onclick = () => $('files').click();
$('files').onchange = event => { addFiles([...event.target.files]); event.target.value = ''; };
$('clear').onclick = () => { if (busy) return; photos.forEach(photo => { photo.thumb.close?.(); URL.revokeObjectURL(photo.thumbUrl); }); photos.length = 0; selected = 0; strip(); refresh(); tell(''); };
for (const type of ['dragenter','dragover']) $('drop').addEventListener(type, event => { event.preventDefault(); if (!busy) $('drop').classList.add('dragging'); });
for (const type of ['dragleave','drop']) $('drop').addEventListener(type, event => { event.preventDefault(); $('drop').classList.remove('dragging'); });
$('drop').addEventListener('drop', event => addFiles([...event.dataTransfer.files]));
$('export').onclick = prepare;
$('share-all').onclick = () => share(outputs.map(output => output.file));
$('zip').onclick = async () => {
  if (busy || !outputs.length) return;
  lock(true); tell('Packing your carousel…');
  try { const zip = await makeZip(outputs.map(output => output.file)); download(zip, 'FujiFrame-carousel.zip'); tell('Carousel ZIP downloaded. Files are numbered in your chosen order.'); }
  catch (error) { tell(error.message); } finally { lock(false); }
};
syncControls();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});
