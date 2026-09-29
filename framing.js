export function layout(width, height, settings, batch = []) {
  const pad = Math.round(Math.min(width, height) * settings.border / 100);
  const extra = settings.bottom ? pad : 0;
  const ratio = { square: 1, portrait: 4 / 5, landscape: 1.91 }[settings.ratio];
  let w = width + pad * 2, h = height + pad * 2 + extra;
  if (ratio) {
    // A common full-resolution canvas: no photo is cropped or upscaled.
    for (const image of batch) {
      const p = Math.round(Math.min(image.width, image.height) * settings.border / 100);
      w = Math.max(w, image.width + p * 2);
      h = Math.max(h, image.height + p * 2 + (settings.bottom ? p : 0));
    }
    if (w / h > ratio) h = Math.ceil(w / ratio);
    else w = Math.ceil(h * ratio);
  }
  const scale = settings.resolution === 'social' ? Math.min(1, 1080 / w) : 1;
  return {
    width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)),
    x: Math.floor((w - width) / 2) * scale, y: Math.floor((h - height - extra) / 2) * scale,
    photoWidth: width * scale, photoHeight: height * scale, scale, pad: pad * scale
  };
}

export function paint(ctx, source, geometry, settings) {
  const g = geometry;
  ctx.fillStyle = settings.paper;
  ctx.fillRect(0, 0, g.width, g.height);
  ctx.imageSmoothingEnabled = g.scale !== 1;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, g.x, g.y, g.photoWidth, g.photoHeight);
  if (!settings.watermark.trim()) return;
  const text = settings.watermark.trim().slice(0, 120);
  const size = Math.max(8, Math.min(g.photoWidth, g.photoHeight) * settings.textSize / 100);
  const inset = Math.max(size, Math.min(g.photoWidth, g.photoHeight) * 0.025);
  ctx.save();
  ctx.font = `${size}px ${settings.font === 'serif' ? 'Georgia, serif' : 'Arial, sans-serif'}`;
  const left = settings.corner.endsWith('left');
  ctx.textAlign = left ? 'left' : 'right';
  ctx.fillStyle = settings.ink;
  ctx.globalAlpha = settings.opacity / 100;
  if (settings.placement === 'mat') {
    const space = g.height - g.y - g.photoHeight;
    if (space > 2) {
      const matSize = Math.min(size, space * 0.55);
      ctx.font = `${matSize}px ${settings.font === 'serif' ? 'Georgia, serif' : 'Arial, sans-serif'}`;
      ctx.textBaseline = 'middle';
      ctx.fillText(text, left ? g.x : g.x + g.photoWidth, g.y + g.photoHeight + space / 2, g.photoWidth);
    }
  } else {
    const top = settings.corner.startsWith('top');
    ctx.textBaseline = top ? 'top' : 'bottom';
    ctx.fillText(text, left ? g.x + inset : g.x + g.photoWidth - inset,
      top ? g.y + inset : g.y + g.photoHeight - inset, Math.max(1, g.photoWidth - inset * 2));
  }
  ctx.restore();
}
