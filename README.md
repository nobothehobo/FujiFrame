# FujiFrame

A quiet, local-only web app for adding photo mats to Fujifilm JPEGs and other photographs. No account, uploads, API keys, runtime dependencies or build step.

## Run

```sh
npm start
# Open http://localhost:5173
npm test
npm run check
```

Python 3 serves the app; Node 20+ runs the tests. Any static HTTPS host can serve this folder as-is. HTTPS (or localhost) enables offline caching and supported native file sharing. Do not open index.html directly from a file URL because it uses ES modules.

## Use

1. Choose up to 20 JPEG, PNG or WebP photos. Reorder with the arrows.
2. Choose the mat width, paper color and optional extra bottom space. Follow each photo for individual framing, or choose a common square, 4:5 or 1.91:1 carousel canvas.
3. Add an optional name/credit on the mat or in a photo corner. Serif/sans, color, size and opacity are adjustable.
4. Choose full resolution or an explicitly smaller copy, and exclude or retain supported metadata.
5. Prepare, then download individually, download an ordered ZIP, or use the native share sheet when supported. On iPhone, choose Save Image(s) in the share sheet. Camera-roll access cannot be forced by a website; Download and Open photo provide fallbacks.

The logo is an original SVG combining a mat/frame with a mountain photograph. The interface uses system fonts, no CDN or analytics.

## Resolution and color

Full-resolution mode places the photo at its native, orientation-correct dimensions, on integer pixel coordinates, without cropping or scaling. Mixed-orientation carousel photos share a canvas large enough for the entire batch. Adding borders increases output dimensions. PNG exports avoid additional lossy JPEG compression; original files are never overwritten.

Browser decoding/rendering uses sRGB and can convert input profiles or reduce higher bit depths. This is not a byte-for-byte archival or color-critical workflow. RAW/RAF and HEIC are intentionally unsupported; export camera JPEGs or PNGs first. A social copy never upscales a smaller source and is at most 1080 pixels wide. Instagram may resize files and strip metadata after upload.

Full-resolution X-T5 exports can require hundreds of MB of working memory per photo, and mobile memory limits vary. Large exports use a streaming, band-based PNG encoder rather than one full-size canvas, avoiding common mobile canvas-area limits. Files are processed sequentially and decoded full-size images are released after each export. Unsupported exports fail visibly; they never silently downsize. Use smaller copies, smaller batches, or a desktop browser when necessary. Prepared files remain in memory until settings change or the page closes.

## Metadata

**Exclude is the default:** the output receives no source EXIF, XMP, GPS, dates or text metadata. PNG technical chunks produced by the browser remain.

**Keep supported metadata:** copies standard JPEG/PNG EXIF, basic JPEG XMP and PNG text chunks into standard PNG eXIf/iTXt/text chunks. Camera settings, dates, lens data and GPS are retained when available. EXIF orientation becomes 1 and existing width/height tags are updated to match the framed output. The stale thumbnail directory reference is removed. TIFF data is not moved, preserving Fujifilm MakerNote offsets. GPS is included, so choose Exclude before public sharing if desired.

XMP is copied verbatim and may describe original dimensions. Legacy IPTC/Photoshop, extended XMP and WebP metadata are not copied; the app reports limitations. Malformed metadata fails the export rather than silently claiming retention. Different photo apps have different support for EXIF in PNG. Original ICC profiles are not copied because they may mislabel browser-rendered sRGB pixels.

## Deployment

Publish the folder to any static HTTPS host. There is no server-side image processing. For GitHub Pages, choose the branch containing the app and `/ (root)` in repository Settings → Pages. Availability for private repositories depends on your GitHub plan. This repository contains a CI workflow to run the core tests; it does not automatically publish the app.

## Testing

`npm test` covers native-size geometry across mixed orientations, consistent carousel canvases, integer pixel alignment, extra bottom mats, optional downsizing, EXIF orientation/dimension repair, malformed metadata, PNG insertion and ZIP bytes/order. `tests/browser-smoke.cjs` is an optional integration check using Playwright and Sharp installed in your environment. It verifies actual browser exports against decoded source pixels, metadata exclusion/retention, rotation, responsive layout and full-resolution X-T5-size export. Run it while the local server is running.

Native rendering integration checks (via @napi-rs/canvas and Sharp) also cover exact decoded pixel preservation, equivalence of band-based and ordinary canvas PNG encoding with a watermark, and 7728 × 5152 source export. Run `tests/render-smoke.cjs` with those optional modules available.

Real iPhone Safari share-sheet targets and memory limits require testing on the device; Chromium emulation cannot certify those OS behaviors.

Independent project, not affiliated with Fujifilm.
