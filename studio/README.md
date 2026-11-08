# FujiFrame Studio

A local desktop photo editor with a browser interface, designed around Fujifilm
X-T5 files. This is an early working editor, not a complete Lightroom replacement.
It runs a Python service on your computer; the interface opens in your browser.
The existing FujiFrame framing app is a separate workspace.

## Start

Install **64-bit Python 3.11 or newer** from https://www.python.org/downloads/.
Download this branch as a ZIP or clone it:

```sh
git clone --branch codex/fujiframe-studio https://github.com/nobothehobo/FujiFrame.git
cd FujiFrame
```

**Windows:** double-click `Launch-Studio.bat`.

**macOS / Linux:** run `bash Launch-Studio.command` in Terminal. You can also make
the file executable with `chmod +x Launch-Studio.command`, then launch it directly.

The launcher creates a virtual environment and installs dependencies on its first
run. Keep the terminal open while editing. Stop the app with Ctrl+C. If dependency
installation fails, delete `.venv-studio` and run the launcher again.

Manual installation:

```sh
python -m venv .venv-studio
# Windows: .venv-studio\Scripts\activate
# macOS / Linux: source .venv-studio/bin/activate
python -m pip install -r studio/requirements.txt
python -m studio
```

Studio opens http://127.0.0.1:8765. Use `--port 8766` if that port is occupied.
Install ExifTool from https://exiftool.org/ to display Fujifilm MakerNote recipe
tags. ExifTool is optional and is not bundled; source-file metadata is retained
inside the unmodified original regardless of whether ExifTool is available.

## What works

- Local catalog with imported source copies, SHA-256 duplicate detection,
  ratings, picks/rejects, search, sorting, and a filmstrip.
- RAF development with rawpy / LibRaw, camera white balance, 16-bit linear-sRGB
  decoding and float32 adjustments. Actual X-T5 RAF compression variants still
  require verification with camera files.
- Exposure in stops; contrast, highlights, shadows, whites/blacks, relative
  warmth and tint, vibrance, saturation, an eight-channel HSL mixer, and an
  interactive piecewise linear RGB tone curve.
- Radial and linear local masks with feathering, inversion, exposure, warmth,
  and saturation. Up to eight masks, using normalized coordinates in the visible
  cropped composition. Changing a crop also changes that coordinate frame.
- Crop, common aspect ratios, straighten, 90-degree rotation, float-precision
  sharpening/texture, deterministic grain, vignette, original Studio creative
  looks, and user-provided 3D `.cube` LUTs with trilinear interpolation.
- Fit / pixel-for-pixel **preview** zoom, panning, matched-geometry before/after
  split comparison, undo/redo in the current session, persisted edit revisions,
  and downloadable JSON sidecars.
- Full-source-resolution JPEG, lossless 8-bit PNG, and uncompressed **16-bit RGB
  TIFF** export, with an sRGB ICC profile. Smaller exports never upscale.
- Optional watched transfer/export folder and launch of installed X RAW Studio
  on macOS / Windows. There is no direct USB or Wi-Fi control in this version.

## Film simulations: the important distinction

| Workflow | What Studio edits | Fujifilm rendering | Full sensor editing latitude |
| --- | --- | --- | --- |
| Import camera JPEG / rendered TIFF | Rendered RGB image | Source rendering is retained as the starting point | No; the image is already rendered |
| RAF, Source rendering, no attachment | Embedded camera JPEG preview | Retains the preview's camera rendering | No; preview resolution and bit depth only |
| RAF + attached X RAW Studio output | Attached rendered RGB image | Uses Fujifilm's camera processing | No; adjust RAW settings in X RAW Studio first |
| RAF, Neutral RAW / LibRaw | Independently developed sensor data | No official Fujifilm film simulation | Yes, within this implementation's RAW pipeline |

Fujifilm states that [X RAW Studio](https://www.fujifilm-x.com/global/support/download/software/x-raw-studio/)
uses the connected camera's processor. [The X-T5 manual](https://app.fujifilm-dsc.com/en-int/manual/x-t5/connections/raw/)
explains the USB RAW conversion mode. Studio does not contain Fujifilm's color
engine, Adobe Camera Matching profiles, or licensed camera profiles. Studio looks
have independent names and are not reproductions of official film simulations.
Importing a LUT does not turn LibRaw into Fujifilm's RAW engine.

To use the exact camera-rendered starting color:

1. Import your original RAF into Studio.
2. Connect your X-T5 by USB. Choose **USB RAW CONV./BACKUP RESTORE** under
   Network/USB → Connection Mode; set USB power/communication to **AUTO** or
   **POWER SUPPLY OFF/COMM ON**. Follow Fujifilm's instructions for your firmware.
3. Open X RAW Studio, load that RAF, and choose the simulation and RAW settings.
4. Export its supported JPEG or RGB TIFF format in **sRGB**.
5. In Studio, use **Attach X RAW Studio rendering** on that RAF and select the
   matching exported image. Choose **Source rendering** as the foundation.
6. Make further adjustments and export an edited copy.

Attachment is explicit. Studio does not guess which RAF belongs to an export.
The app can launch X RAW Studio; it does not automate that app's controls or
conversion. The embedded-preview route cannot export without an explicit
acknowledgment of its lower-resolution source, and its filename includes
`-preview`. A 16-bit TIFF made from a JPEG cannot restore lost JPEG precision.

## Transfer integration

Use X Acquire or Fujifilm Tether App to write photos into a transfer folder. Open
**Camera workflow** and enter that folder's absolute path. Studio imports copied
files after their size and modification time remain stable for at least three
seconds. Files that are still being written are retried. Only files directly
inside that folder are watched; subfolders and symlinks are not followed.

You can also start with:

```sh
python -m studio --watch /absolute/path/to/Incoming
python -m studio --x-raw-studio "/Applications/FUJIFILM X RAW STUDIO.app"
python -m studio --project /absolute/path/to/My-Catalog
```

Fujifilm's [Camera Control SDK](https://www.fujifilm-x.com/global/camera-control-sdk/)
lists the X-T5 and supports transfer and basic remote controls. It **does not
provide RAF conversion**. Fujifilm also states that individual use of this SDK
to connect to/control a camera voids the camera's limited product warranty.
Review its license and terms before a future SDK integration. No SDK is
downloaded or used by Studio. See [INTEGRATION.md](INTEGRATION.md) for the
implementation boundary and next development steps.

## Color, resolution, and current limits

Processing uses linear-sRGB exposure/white-balance math followed by
display-referred color and tone adjustments. RAW decoding has 16-bit output;
working RGB buffers use float32. This is an SDR sRGB workflow. It does not
implement a full color-managed, wide-gamut/HDR editing pipeline, soft proofing,
AI denoising, healing/content-aware editing, lens profiles, perspective correction,
subject segmentation, or a mature asset-management database.

Input RGB TIFFs may be 8- or 16-bit, three interleaved channels. Tagged non-sRGB
TIFFs are rejected rather than converted through an 8-bit path. Untagged TIFFs
are assumed sRGB: export in that color space. JPEG/PNG/WebP imports go through
Pillow's 8-bit sRGB conversion, with ICC conversion when available. HEIF/HEIC,
CMYK/planar/float TIFFs and TIFF alpha are not supported. Straightening keeps
the canvas size; crop away any newly exposed black corners.

The interactive image is capped at 1440 px for responsiveness. **100% zoom is
100% of that preview**, not a native-resolution sensor inspection. Export loads
the source again and does not use the preview as the full-resolution input,
except for an explicitly acknowledged embedded JPEG preview export.

Processing is serialized to limit peak memory. Full 7728 × 5152 editing/export
can use several GB of RAM; 16 GB system memory is a practical target. Detail
filter radii and procedural grain are measured in working pixels, so their
apparent strength can vary between the small preview and full export. Use an
export to judge these effects. Export is one photo at a time in this version.

Original EXIF, MakerNotes and other source metadata remain in the copied source
file and relevant readable tags in the sidecar. Edited exports exclude source
EXIF/GPS; they carry an sRGB ICC profile. Sidecars use Studio's own schema,
not Adobe XMP; Lightroom cannot automatically reproduce this pipeline's edits.
Downloaded sidecars are a record of edits; a sidecar-import UI is not yet built.

## Local data and security

The default catalog is `~/Pictures/FujiFrame-Studio`. It contains immutable
source copies in `originals/`, attached files in `renders/`, `.cube` files in
`luts/`, `catalog.sqlite3`, generated `cache/`, and versioned edit sidecars in
`sidecars/`. Back up the whole catalog for a portable copy. Importing copies
files and requires additional disk space. There is no delete UI yet.

The normal service binds to **127.0.0.1**, validates local hostnames, rejects
cross-site browser requests, and requires a session CSRF header on writes. There
are no analytics, external scripts, cloud photo uploads, or account requirements.
Dependency installation uses the package index. External Fujifilm links open only
when you select them. This local service is not designed for public deployment.

`--preview` is for managed UI QA only. It binds all interfaces and disables
folder watching/application launch. Never expose this mode on an untrusted
network or use it for your private catalog.

## Validation and desktop packaging

```sh
python -m unittest discover -s studio/tests -v
npm test
npm run check
# Optional: several GB RAM, synthetic X-T5-size image (not a RAF/hardware test)
python -m studio.tests.full_resolution_smoke
```

Tests cover float processing, linear exposure, immutable source files, crop/mask
geometry, ICC tagging, >8-bit TIFF precision, LUT order, orientation, bad inputs,
catalog persistence, concurrent-edit conflicts, folder stability, HTTP editing /
export, and refusal to disguise a camera preview as a full RAW export.

The manual **Build Studio desktop bundles** GitHub Actions workflow builds
PyInstaller folders on Windows, macOS and Linux. Builds are unsigned and are not
installers. They have not been tested on physical Windows/macOS computers. Source
launchers are the primary setup route until platform testing is complete.

Browser visual QA could not run in the managed preview environment because that
environment does not include the native Python imaging dependencies. Actual X-T5
RAFs, camera transfer, X RAW Studio launching, and real camera-rendered TIFFs
still need verification on the photographer's computer. Do not infer hardware
compatibility from the synthetic processing tests.

Independent project, not affiliated with Fujifilm, Adobe, or Google.
