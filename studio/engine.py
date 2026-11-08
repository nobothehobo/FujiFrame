"""Float32 linear-sRGB development, display-referred grading, and 16-bit output.

No Fujifilm or Adobe profiles are included. The camera-rendered route preserves
the source rendering; LibRaw is an independent, neutral RAW developer.
"""
from __future__ import annotations

import io
import math
from pathlib import Path

import numpy as np
from PIL import Image, ImageCms, ImageOps
import tifffile


LIMITS = {
    "exposure": (-5, 5), "contrast": (-100, 100), "highlights": (-100, 100),
    "shadows": (-100, 100), "whites": (-100, 100), "blacks": (-100, 100),
    "temperature": (-100, 100), "tint": (-100, 100), "vibrance": (-100, 100),
    "saturation": (-100, 100), "texture": (0, 100), "sharpness": (0, 100),
    "grain": (0, 100), "vignette": (-100, 100), "rotation": (-45, 45),
    "lut_amount": (0, 100),
}
DEFAULTS = {name: 0.0 for name in LIMITS}
DEFAULTS.update({"curve": [[0, 0], [1, 1]], "hsl": {}, "masks": [],
                 "crop": [0, 0, 1, 1], "quarter_turns": 0, "look": "source",
                 "mode": "camera", "lut_id": None, "lut_amount": 100})
LOOKS = {
    "source": {"name": "Source color", "description": "Keep the source rendering"},
    "meadow": {"name": "Meadow", "description": "Soft greens · warm light", "contrast": -8, "temperature": 8, "vibrance": 12, "blacks": 6},
    "chrome": {"name": "Quiet Chrome", "description": "Muted color · deep shadows", "saturation": -22, "contrast": 15, "shadows": -8, "temperature": 3},
    "gold": {"name": "Golden Hour", "description": "Warm highlights · gentle contrast", "temperature": 22, "tint": 4, "contrast": 5, "highlights": -18},
    "mono": {"name": "Silver Mono", "description": "Luminous monochrome", "saturation": -100, "contrast": 18, "blacks": -8},
}
HUES = {"red": 0, "orange": 30, "yellow": 60, "green": 120, "aqua": 180, "blue": 240, "purple": 280, "magenta": 320}
SRGB_ICC = ImageCms.ImageCmsProfile(ImageCms.createProfile("sRGB")).tobytes()


def finite(value, low, high):
    if isinstance(value, bool):
        raise ValueError("A numeric adjustment cannot be true or false")
    v = float(value)
    if not math.isfinite(v) or not low <= v <= high:
        raise ValueError(f"Adjustment must be between {low} and {high}")
    return v


def validate_edits(data):
    if not isinstance(data, dict):
        raise ValueError("Edits must be an object")
    out = {**DEFAULTS}
    for key, bounds in LIMITS.items():
        out[key] = finite(data.get(key, DEFAULTS[key]), *bounds)
    out["mode"] = data.get("mode", "camera")
    if out["mode"] not in ("camera", "raw"):
        raise ValueError("Unknown development mode")
    out["look"] = data.get("look", "source")
    if out["look"] not in LOOKS:
        raise ValueError("Unknown creative look")
    turns = finite(data.get("quarter_turns", 0), 0, 3)
    if not turns.is_integer():
        raise ValueError("Quarter turns must be an integer")
    out["quarter_turns"] = int(turns)
    crop = data.get("crop", [0, 0, 1, 1])
    if not isinstance(crop, list) or len(crop) != 4:
        raise ValueError("Crop requires x, y, width, height")
    x, y, w, h = [finite(v, 0, 1) for v in crop]
    if w < .01 or h < .01 or x + w > 1.00001 or y + h > 1.00001:
        raise ValueError("Crop lies outside the image")
    out["crop"] = [x, y, w, h]
    curve = data.get("curve", DEFAULTS["curve"])
    if not isinstance(curve, list) or not 2 <= len(curve) <= 12:
        raise ValueError("Curve requires 2–12 points")
    out["curve"] = [[finite(p[0], 0, 1), finite(p[1], 0, 1)] for p in curve if isinstance(p, list) and len(p) == 2]
    if len(out["curve"]) != len(curve) or out["curve"][0][0] != 0 or out["curve"][-1][0] != 1:
        raise ValueError("Curve must start at x=0 and end at x=1")
    if any(a[0] >= b[0] for a, b in zip(out["curve"], out["curve"][1:])):
        raise ValueError("Curve x positions must increase")
    hsl = data.get("hsl", {})
    if not isinstance(hsl, dict) or set(hsl) - set(HUES):
        raise ValueError("Unknown HSL channel")
    out["hsl"] = {k: {j: finite(v.get(j, 0), -100, 100) for j in ("hue", "saturation", "luminance")} for k, v in hsl.items()}
    masks = data.get("masks", [])
    if not isinstance(masks, list) or len(masks) > 8:
        raise ValueError("At most 8 local masks are supported")
    out["masks"] = []
    for m in masks:
        if not isinstance(m, dict) or m.get("type") not in ("radial", "linear"):
            raise ValueError("Mask must be radial or linear")
        out["masks"].append({"type": m["type"], "x": finite(m.get("x", .5), 0, 1),
            "y": finite(m.get("y", .5), 0, 1), "radius": finite(m.get("radius", .4), .02, 2),
            "angle": finite(m.get("angle", 90), -180, 180), "feather": finite(m.get("feather", .7), .01, 1),
            "invert": bool(m.get("invert", False)), "exposure": finite(m.get("exposure", 0), -3, 3),
            "temperature": finite(m.get("temperature", 0), -100, 100),
            "saturation": finite(m.get("saturation", 0), -100, 100)})
    lut_id = data.get("lut_id")
    if lut_id is not None and (not isinstance(lut_id, str) or len(lut_id) != 64 or any(c not in "0123456789abcdef" for c in lut_id)):
        raise ValueError("Invalid LUT identifier")
    out["lut_id"] = lut_id
    return out


def to_linear(rgb):
    return np.where(rgb <= .04045, rgb / 12.92, ((rgb + .055) / 1.055) ** 2.4).astype(np.float32)


def to_srgb(rgb):
    rgb = np.maximum(rgb, 0)
    return np.where(rgb <= .0031308, rgb * 12.92, 1.055 * rgb ** (1 / 2.4) - .055).astype(np.float32)


def resize_float(rgb, max_edge):
    h, w = rgb.shape[:2]
    if not max_edge or max(w, h) <= max_edge:
        return rgb
    scale = max_edge / max(w, h)
    size = (max(1, round(w * scale)), max(1, round(h * scale)))
    return np.stack([np.asarray(Image.fromarray(rgb[:, :, c]).resize(size, Image.Resampling.LANCZOS), dtype=np.float32) for c in range(3)], axis=2)


def load_rgb(path, *, raw=False, preview=False, max_edge=0):
    """Return normalized, orientation-correct float32 sRGB; RAW is linear."""
    path = Path(path)
    if path.suffix.lower() == ".raf":
        import rawpy
        with rawpy.imread(str(path)) as photo:
            if raw:
                # Full X-Trans demosaic even for previews: half_size is not an
                # interchangeable Bayer shortcut for every X-Trans generation.
                rgb = photo.postprocess(use_camera_wb=True, output_bps=16,
                    output_color=rawpy.ColorSpace.sRGB, no_auto_bright=True,
                    gamma=(1, 1), highlight_mode=rawpy.HighlightMode.Blend)
                return resize_float(rgb.astype(np.float32) / 65535, max_edge), True
            thumb = photo.extract_thumb()
            if thumb.format == rawpy.ThumbFormat.JPEG:
                return load_pillow(io.BytesIO(thumb.data), max_edge), False
            im = Image.fromarray(thumb.data)
            im.thumbnail((max_edge or im.width, max_edge or im.height))
            return np.asarray(im.convert("RGB"), dtype=np.float32) / 255, False
    if path.suffix.lower() in (".tif", ".tiff"):
        with tifffile.TiffFile(path) as tf:
            page = tf.pages[0]
            arr = page.asarray()
            if arr.ndim != 3 or arr.shape[2] != 3 or arr.dtype not in (np.dtype("uint8"), np.dtype("uint16")):
                raise ValueError("TIFF must be interleaved 8- or 16-bit RGB")
            profile = page.tags.get("InterColorProfile")
            # ICC conversion for high-bit sources needs a high-bit CMS. Never
            # silently reduce those sources through Pillow's 8-bit transform.
            if profile and bytes(profile.value) != SRGB_ICC:
                name = ImageCms.getProfileDescription(ImageCms.ImageCmsProfile(io.BytesIO(profile.value))).strip().lower()
                if "srgb" not in name:
                    raise ValueError("Convert this TIFF to sRGB in its exporting app first; high-bit non-sRGB ICC conversion is not implemented")
            rgb = arr[:, :, :3].astype(np.float32) / np.iinfo(arr.dtype).max
            orient = page.tags.get("Orientation")
            value = orient.value if orient else 1
            transforms = {2: lambda a: a[:, ::-1], 3: lambda a: a[::-1, ::-1], 4: lambda a: a[::-1],
                5: lambda a: a.transpose(1, 0, 2), 6: lambda a: np.rot90(a, 3),
                7: lambda a: a.transpose(1, 0, 2)[::-1, ::-1], 8: lambda a: np.rot90(a)}
            rgb = transforms.get(value, lambda a: a)(rgb)
            return resize_float(rgb, max_edge), False
    return load_pillow(path, max_edge), False


def load_pillow(source, max_edge=0):
    with Image.open(source) as src:
        im = ImageOps.exif_transpose(src)
        if max_edge:
            im.thumbnail((max_edge, max_edge), Image.Resampling.LANCZOS)
        if src.info.get("icc_profile"):
            profile = ImageCms.ImageCmsProfile(io.BytesIO(src.info["icc_profile"]))
            im = ImageCms.profileToProfile(im.convert("RGB"), profile, ImageCms.createProfile("sRGB"), outputMode="RGB")
        if "A" in im.getbands():
            bg = Image.new("RGB", im.size, "white")
            bg.paste(im, mask=im.getchannel("A"))
            im = bg
        return np.asarray(im.convert("RGB"), dtype=np.float32) / 255


def mask_weights(shape, mask):
    h, w = shape[:2]
    yy, xx = np.ogrid[:h, :w]
    dx = xx / max(w - 1, 1) - mask["x"]
    dy = yy / max(h - 1, 1) - mask["y"]
    if mask["type"] == "radial":
        distance = np.sqrt(dx * dx + dy * dy) / mask["radius"]
        weight = np.clip((1 - distance) / mask["feather"], 0, 1)
    else:
        rad = math.radians(mask["angle"])
        weight = np.clip(.5 + (dx * math.cos(rad) + dy * math.sin(rad)) / (mask["radius"] * mask["feather"]), 0, 1)
    weight = np.broadcast_to(weight, (h, w)).astype(np.float32)
    return (1 - weight if mask["invert"] else weight)[:, :, None]


def rgb_hsl(rgb):
    mx, mn = rgb.max(axis=2), rgb.min(axis=2)
    delta = mx - mn
    light = (mx + mn) / 2
    saturation = delta / np.maximum(1 - np.abs(2 * light - 1), 1e-6)
    hue = np.zeros_like(mx)
    r, g, b = rgb.transpose(2, 0, 1)
    d = np.maximum(delta, 1e-6)
    hue = np.where(mx == r, ((g - b) / d) % 6, hue)
    hue = np.where((mx == g) & (mx != r), (b - r) / d + 2, hue)
    hue = np.where((mx == b) & (mx != r) & (mx != g), (r - g) / d + 4, hue)
    return hue / 6, np.clip(saturation, 0, 1), light


def hsl_rgb(h, s, l):
    a = s * np.minimum(l, 1 - l)
    values = []
    for n in (0, 8, 4):
        k = (n + h * 12) % 12
        values.append(l - a * np.maximum(-1, np.minimum(np.minimum(k - 3, 9 - k), 1)))
    return np.stack(values, axis=2)


def parse_cube(text):
    size, rows, domain_min, domain_max = None, [], np.zeros(3), np.ones(3)
    for line in text.splitlines():
        parts = line.split("#", 1)[0].strip().split()
        if not parts or parts[0] == "TITLE":
            continue
        key = parts[0]
        if key == "LUT_3D_SIZE":
            size = int(parts[1])
            if not 2 <= size <= 65:
                raise ValueError("3D LUT size must be 2–65")
        elif key == "DOMAIN_MIN":
            domain_min = np.array([float(v) for v in parts[1:]])
        elif key == "DOMAIN_MAX":
            domain_max = np.array([float(v) for v in parts[1:]])
        elif key.startswith("LUT_"):
            raise ValueError("Only 3D .cube LUTs are supported")
        else:
            if len(parts) != 3:
                raise ValueError("Invalid LUT row")
            rows.append([float(v) for v in parts])
    if not size or len(rows) != size ** 3:
        raise ValueError("LUT row count does not match its 3D size")
    if domain_min.shape != (3,) or domain_max.shape != (3,) or np.any(domain_max <= domain_min):
        raise ValueError("Invalid LUT domain")
    table = np.asarray(rows, dtype=np.float32).reshape(size, size, size, 3)
    if not all(np.isfinite(a).all() for a in (table, domain_min, domain_max)):
        raise ValueError("LUT values must be finite")
    return table, domain_min.astype(np.float32), domain_max.astype(np.float32)


def apply_lut(rgb, lut):
    table, lo, hi = lut
    n = table.shape[0]
    pos = np.clip((rgb - lo) / (hi - lo), 0, 1) * (n - 1)
    low = np.floor(pos).astype(np.int32)
    high = np.minimum(low + 1, n - 1)
    frac = pos - low
    out = np.zeros_like(rgb)
    # .cube ordering is R-fastest, then G, then B.
    for bz in (0, 1):
        for gy in (0, 1):
            for rx in (0, 1):
                indices = [high[..., c] if bit else low[..., c] for c, bit in enumerate((rx, gy, bz))]
                weight = np.prod(np.stack([frac[..., c] if bit else 1 - frac[..., c] for c, bit in enumerate((rx, gy, bz))]), axis=0)
                out += table[indices[2], indices[1], indices[0]] * weight[..., None]
    return out


def grade(rgb, edits, *, linear=False, lut=None):
    e = validate_edits(edits)
    # Masks use coordinates in the visible, cropped composition. Apply geometry
    # before local adjustments so their UI positions match rotated/cropped photos.
    rgb = geometry(rgb, e)
    look = LOOKS[e["look"]]
    values = {k: e[k] + look.get(k, 0) for k in LIMITS}
    image = rgb.copy() if linear else to_linear(rgb)
    temp, tint = values["temperature"] / 100, values["tint"] / 100
    image *= np.array([2 ** (.45 * temp + .18 * tint), 2 ** (-.18 * tint), 2 ** (-.45 * temp + .18 * tint)], dtype=np.float32)
    image *= np.float32(2 ** values["exposure"])
    for mask in e["masks"]:
        weight = mask_weights(image.shape, mask)
        gains = np.array([2 ** (.45 * mask["temperature"] / 100), 1, 2 ** (-.45 * mask["temperature"] / 100)], dtype=np.float32)
        image *= 1 + weight * (np.float32(2 ** mask["exposure"]) * gains - 1)
    image = to_srgb(image)
    lum = np.sum(image * np.array([.2126, .7152, .0722], dtype=np.float32), axis=2, keepdims=True)
    shadow = np.clip(1 - lum, 0, 1) ** 2
    high = np.clip(lum, 0, 1) ** 2
    delta = (values["shadows"] * shadow + values["highlights"] * high) / 400
    delta += values["blacks"] / 350 * shadow ** 2 + values["whites"] / 350 * high ** 2
    image += delta
    image = (image - .5) * (1 + values["contrast"] / 140) + .5
    image = np.maximum(image, 0)
    lum = np.sum(image * np.array([.2126, .7152, .0722], dtype=np.float32), axis=2, keepdims=True)
    saturation = max(0, 1 + values["saturation"] / 100)
    chroma = image.max(axis=2, keepdims=True) - image.min(axis=2, keepdims=True)
    sat = saturation * (1 + values["vibrance"] / 100 * (1 - np.clip(chroma, 0, 1)))
    image = lum + (image - lum) * sat
    for mask in e["masks"]:
        weight = mask_weights(image.shape, mask)
        image = image + weight * (image - lum) * (mask["saturation"] / 100)
    if any(any(v for v in channel.values()) for channel in e["hsl"].values()):
        h, s, l = rgb_hsl(np.clip(image, 0, 1))
        base_hue = h.copy()
        for name, adjustment in e["hsl"].items():
            distance = np.abs((base_hue * 360 - HUES[name] + 180) % 360 - 180)
            weight = np.clip(1 - distance / 45, 0, 1) ** 2
            h += weight * adjustment["hue"] / 100 * (30 / 360)
            s *= 1 + weight * adjustment["saturation"] / 100
            l += weight * adjustment["luminance"] / 100 * .25
        image = hsl_rgb(h % 1, np.clip(s, 0, 1), np.clip(l, 0, 1))
    if e["curve"] != DEFAULTS["curve"]:
        points = np.asarray(e["curve"], dtype=np.float32)
        image = np.interp(image, points[:, 0], points[:, 1]).astype(np.float32)
    if lut is not None and e["lut_id"]:
        image += (apply_lut(image, lut) - image) * (e["lut_amount"] / 100)
    # Texture/sharpen use float32 Gaussian approximations, retaining 16-bit tonal
    # precision in the final buffer rather than round-tripping through RGB8.
    for key, radius, scale in (("texture", 4, .75), ("sharpness", 1, 1.5)):
        if values[key]:
            blurred = float_blur(image, radius)
            image += (image - blurred) * (values[key] / 100 * scale)
    if values["vignette"] or values["grain"]:
        h, w = image.shape[:2]
        yy, xx = np.ogrid[-1:1:complex(h), -1:1:complex(w)]
        if values["vignette"]:
            image *= (1 - values["vignette"] / 180 * np.clip((xx * xx + yy * yy) / 2, 0, 1))[..., None]
        if values["grain"]:
            noise = np.random.default_rng(42).normal(0, values["grain"] / 6000, (h, w, 1)).astype(np.float32)
            image += noise
    image = np.clip(image, 0, 1)
    return np.ascontiguousarray(image)


def geometry(image, edits):
    if edits["quarter_turns"]:
        image = np.rot90(image, -edits["quarter_turns"])
    if edits["rotation"]:
        image = np.stack([np.asarray(Image.fromarray(image[:, :, c]).rotate(-edits["rotation"], Image.Resampling.BICUBIC, expand=False), dtype=np.float32) for c in range(3)], axis=2)
    x, y, cw, ch = edits["crop"]
    h, w = image.shape[:2]
    left, top = min(w - 1, round(x * w)), min(h - 1, round(y * h))
    image = image[top:max(top + 1, min(h, round((y + ch) * h))), left:max(left + 1, min(w, round((x + cw) * w)))]
    return np.ascontiguousarray(image)


def float_blur(image, radius):
    # Repeated separable box filters approximate a Gaussian, in float32.
    result = image.copy()
    for _ in range(3):
        for axis in (0, 1):
            r = max(1, radius)
            padding = [(0, 0)] * 3
            padding[axis] = (r + 1, r)
            padded = np.pad(result, padding, mode="edge")
            accum = np.cumsum(padded, axis=axis, dtype=np.float64)
            high = [slice(None)] * 3
            low = [slice(None)] * 3
            high[axis] = slice(2 * r + 1, None)
            low[axis] = slice(None, -(2 * r + 1))
            result = ((accum[tuple(high)] - accum[tuple(low)]) / (2 * r + 1)).astype(np.float32)
    return result


def encode(rgb, fmt="jpeg", quality=95):
    output = io.BytesIO()
    if fmt == "tiff16":
        tifffile.imwrite(output, np.round(np.clip(rgb, 0, 1) * 65535).astype(np.uint16),
            photometric="rgb", metadata=None, iccprofile=SRGB_ICC,
            description="FujiFrame Studio - 16-bit sRGB", compression=None)
        return output.getvalue(), "image/tiff", ".tif"
    im = Image.fromarray(np.round(np.clip(rgb, 0, 1) * 255).astype(np.uint8))
    if fmt == "png":
        im.save(output, "PNG", icc_profile=SRGB_ICC)
        return output.getvalue(), "image/png", ".png"
    if fmt != "jpeg":
        raise ValueError("Export format must be jpeg, png, or tiff16")
    im.save(output, "JPEG", quality=int(finite(quality, 1, 100)), subsampling=0, icc_profile=SRGB_ICC)
    return output.getvalue(), "image/jpeg", ".jpg"


def histogram(rgb):
    tiny = rgb[::max(1, rgb.shape[0] // 300), ::max(1, rgb.shape[1] // 400)]
    bins = [np.histogram(tiny[..., c], bins=128, range=(0, 1))[0].tolist() for c in range(3)]
    return {"channels": bins, "shadows": float((tiny.min(axis=2) <= .002).mean()),
            "highlights": float((tiny.max(axis=2) >= .998).mean())}
