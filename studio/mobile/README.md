# FujiFrame Studio for iPhone

A browser-native companion to desktop Studio. Open the hosted HTTPS link in
Safari. It does not need a computer or Python service running. On iPhone, use
Safari → Share → Add to Home Screen for a standalone app window.

**Live app:** https://fujiframe-studio-mobile.nobothehobo.chatgpt.site

The Site is private to its owner and may ask you to continue with ChatGPT.

## Mobile editing

- Import rendered camera JPEG, PNG, WebP, and browser-readable HEIC images.
- Read the embedded JPEG preview from a Fujifilm RAF. This does **not** develop
  the RAW data; preview-only status is visible and export requires acknowledgment.
- Nondestructive exposure/tone controls, white balance offsets, vibrance,
  saturation, eight-channel HSL, interactive RGB curves, independent creative
  looks, imported 3D `.cube` LUTs, grain, vignette, crops, straightening and rotation.
- Up to eight feathered radial/linear masks for exposure, warmth and saturation.
- Before/after split, pinch zoom/pan, undo/redo, persisted edit states and portable
  edit files. A desktop edit file may restore compatible settings; desktop RAW
  development and unsupported detail controls are not reproduced.
- Phone-local photo library in IndexedDB. No image upload endpoints, external
  image resources, analytics, or accounts for photo storage. A private hosted
  Site may require its owner's ChatGPT sign-in to open the application itself.
- Full-source-resolution, 8-bit sRGB PNG export in 96-row bands, with validated PNG
  chunks and no full-sized output canvas. JPEG at 95% quality is capped at 16 MP;
  the user explicitly selects a smaller size or full-resolution PNG for larger
  photos. No silent downsizing or upscaling.
- Prepare the image first, then tap **Share / Save Image** to preserve the user
  activation required by iPhone's share sheet. Download/Open Image are fallbacks.

## Color and file boundaries

Camera JPEGs start with the camera's rendered film simulation. Browser decoding
and edits operate on rendered sRGB RGB8; this version does not include Fujifilm's
film-simulation engine, neutral full-sensor RAW development, high-bit TIFF
editing, direct USB/Wi-Fi control, lens corrections, healing, AI denoise or HDR.
An 8-bit output does not recover precision from a JPEG. For exact camera color
at full source resolution, import the full camera JPEG or an sRGB JPEG rendered
through X RAW Studio. Creative looks are independent effects, not official sims.

RAF imports store their embedded JPEG preview for editing; the original RAF stays
in the user's Files. SHA-256 identifies the original supplied file. Rendered
imports store the supplied image Blob. Browser storage is local to the device /
browser / Site origin and can be cleared or evicted. Download finished images
and edit files for backup. Private browsing or insufficient storage can leave
edits session-only; the app reports that state.

PNG/JPEG exports omit source EXIF/GPS metadata. The PNG includes an sRGB chunk.
Canvas input decoding/color conversion is browser-owned. Transparent inputs
are composited on black. The preview is capped at 1280 px; Fit and pinch zoom
refer to this preview. Export redraws from the original rendered source.
Grain is evaluated in output pixels and may look finer in a full export.
Straightening can expose black corners; crop them away.

## Implementation

`engine.js` is a pure JavaScript grading/geometry/PNG module. `worker.js` keeps
pixel processing off the interface thread, with an in-page fallback. Full PNG
exports process narrow bands with global mask coordinates so band boundaries do
not change grading. `storage.js` owns IndexedDB transactions. `sw.js` caches only
the application shell; no photo files are sent to a server. Mobile uses its own
scope/database/cache, separate from FujiFrame Quick.

Host this folder as static assets at an HTTPS origin. The deployed Site uses
`dist/` containing these same files. No build dependencies or backend are needed.
For local source work, use a localhost static server (secure-context features
such as Web Crypto, service workers and sharing require HTTPS or localhost).

```sh
node --test studio/mobile/tests/*.test.js
node --check studio/mobile/app.js
```

Tests cover unchanged neutral source pixels, linear exposure, exact geometry,
band/full-frame equivalence, LUT order, neutral HSL behavior, malformed edits,
RAF boundaries, PNG CRCs, sRGB tagging, exact decompressed rows and cancellation.
Desktop Chromium UI QA does not certify real iPhone memory, Safari image decoding,
Home Screen persistence, or native share-sheet targets; test those on the device.

The responsive interface was checked at 393 × 852 px without horizontal overflow.
The private Site's sign-in gate prevented a complete signed-in browser editing /
sharing test in the cloud browser. The managed HTTP preview also lacks the secure
context needed for Web Crypto imports, so it was used only for layout/navigation
checks. The ten pure processing/export tests pass; real Safari and camera files
still need device verification. [Phone layout preview](docs/phone-layout.jpg).
