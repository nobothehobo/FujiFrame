"""Loopback-only desktop service. Images never leave the user's computer."""
from __future__ import annotations

import hashlib
import io
import json
import mimetypes
import os
from pathlib import Path
import secrets
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, unquote, urlsplit

import numpy as np
from PIL import Image, ImageDraw

from . import __version__
from .catalog import Catalog, ConflictError, MAX_BYTES
from .engine import DEFAULTS, LOOKS, encode, grade, histogram, load_rgb, parse_cube, validate_edits
from .integration import FolderWatcher, open_xraw, xraw_path

WEB_ROOT = Path(__file__).parent / "web"


class Studio:
    def __init__(self, project, *, preview=False, xraw=None):
        self.catalog = Catalog(project)
        self.preview = preview
        self.xraw = xraw
        self.csrf = secrets.token_urlsafe(32)
        self.render_lock = threading.Lock()
        self.watcher = FolderWatcher(self.catalog)
        if not preview:
            self.watcher.thread.start()

    def source(self, asset_id, edits, max_edge):
        row = self.catalog.get(asset_id, True)
        is_raf = row["path"].lower().endswith(".raf")
        raw = is_raf and edits["mode"] == "raw"
        path = row["path"] if raw or not row["render_path"] else row["render_path"]
        preview_only = is_raf and not raw and not row["render_path"]
        # Cache only bounded previews; never retain a full 40MP working buffer.
        cache = self.catalog.root / "cache" / f"{asset_id}-{edits['mode']}-{max_edge}.npy"
        if max_edge and cache.exists():
            rgb = np.load(cache, allow_pickle=False)
            linear = raw
        else:
            rgb, linear = load_rgb(path, raw=raw, max_edge=max_edge)
            if max_edge:
                np.save(cache, rgb, allow_pickle=False)
        return rgb, linear, preview_only

    def render(self, asset_id, body, *, export=False):
        edits = validate_edits(body.get("edits", self.catalog.get(asset_id)["edits"]))
        max_edge = int(body.get("max_edge", 0 if export else 1440))
        if max_edge not in (0, 1080, 1440, 1600, 2048, 3000):
            raise ValueError("Choose an available export size")
        if not export:
            max_edge = min(max_edge or 1440, 1600)
        with self.render_lock:
            source, linear, preview_only = self.source(asset_id, edits, max_edge)
            if export and preview_only and not body.get("allow_preview", False):
                raise ValueError("This is the RAF embedded preview. Attach an X RAW Studio rendering, select neutral RAW development, or explicitly choose preview export.")
            lut = None
            if edits["lut_id"]:
                path = self.catalog.root / "luts" / (edits["lut_id"] + ".cube")
                if not path.is_file():
                    raise ValueError("The selected LUT is missing from this catalog")
                lut = parse_cube(path.read_text(encoding="utf-8-sig"))
            if body.get("before"):
                image = grade(source, {key: edits[key] for key in ("mode", "quarter_turns", "rotation", "crop")}, linear=linear)
            else:
                image = grade(source, edits, linear=linear, lut=lut)
            fmt = body.get("format", "jpeg") if export else "jpeg"
            data, mime, suffix = encode(image, fmt, body.get("quality", 95))
            meta = {"width": image.shape[1], "height": image.shape[0], "preview_only": preview_only,
                "pipeline": "LibRaw · neutral RAW" if linear else ("Embedded camera preview" if preview_only else "Imported rendering"),
                "histogram": histogram(image) if not export else None}
            return data, mime, suffix, meta

    def state(self):
        with self.catalog.lock:
            luts = [dict(r) for r in self.catalog.db.execute("SELECT * FROM luts ORDER BY name")]
        return {"version": __version__, "csrf": self.csrf, "defaults": DEFAULTS, "looks": LOOKS,
            "assets": self.catalog.list(), "luts": luts, "project_name": self.catalog.root.name,
            "capabilities": {"raw": True, "tiff16": True, "direct_camera_control": False,
                "x_raw_studio": not self.preview and bool(xraw_path(self.xraw)),
                "watch_folder": not self.preview, "preview_environment": self.preview},
            "watch_folder": self.catalog.setting("watch_folder"), "watch_errors": dict(self.watcher.errors)}

    def thumbnail(self, asset_id):
        file = self.catalog.root / "cache" / (asset_id + "-thumbnail.jpg")
        with self.render_lock:
            if not file.exists():
                row = self.catalog.get(asset_id, True)
                rgb, linear = load_rgb(row["render_path"] or row["path"], max_edge=320)
                data, _, _ = encode(grade(rgb, {}, linear=linear), "jpeg", 85)
                file.write_bytes(data)
            return file.read_bytes()


def make_server(studio, host="127.0.0.1", port=8765):
    class Handler(BaseHTTPRequestHandler):
        server_version = "FujiFrameStudio/" + __version__

        def log_message(self, fmt, *args):
            # Imported filenames and local paths do not enter request logs.
            if os.environ.get("STUDIO_VERBOSE") == "1":
                super().log_message(fmt, *args)

        def _guard(self, mutate=False):
            host_header = self.headers.get("Host", "")
            if not studio.preview and host_header.split(":")[0] not in ("localhost", "127.0.0.1"):
                raise PermissionError("Unexpected host")
            if self.headers.get("Sec-Fetch-Site") == "cross-site":
                raise PermissionError("Cross-site requests are not allowed")
            if mutate and not secrets.compare_digest(self.headers.get("X-Studio-CSRF", ""), studio.csrf):
                raise PermissionError("Reload Studio to renew this editing session")

        def _bytes(self, data, mime="application/json", status=200, headers=None):
            self.send_response(status)
            self.send_header("Content-Type", mime)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Referrer-Policy", "same-origin")
            self.send_header("Content-Security-Policy", "default-src 'self'; img-src 'self' blob: data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; object-src 'none'; frame-ancestors 'self'")
            for key, value in (headers or {}).items():
                self.send_header(key, value)
            self.end_headers()
            self.wfile.write(data)

        def _json(self, value, status=200):
            self._bytes(json.dumps(value, ensure_ascii=True).encode(), status=status)

        def _body(self, limit=MAX_BYTES):
            try:
                length = int(self.headers.get("Content-Length", "0"))
            except ValueError:
                raise ValueError("Invalid content length")
            if length < 0 or length > limit:
                raise ValueError("Request is too large")
            data = self.rfile.read(length)
            if len(data) != length:
                raise ValueError("Upload was interrupted")
            return data

        def _input(self):
            return json.loads(self._body(2 * 1024 * 1024) or b"{}")

        def _error(self, exc):
            if isinstance(exc, PermissionError):
                status = 403
            elif isinstance(exc, KeyError):
                status = 404
            elif isinstance(exc, ConflictError):
                status = 409
            else:
                status = 400
            self._json({"error": str(exc)}, status)

        def do_GET(self):
            try:
                self._guard()
                path = urlsplit(self.path).path
                if path == "/api/state":
                    return self._json(studio.state())
                if path == "/api/assets":
                    return self._json(studio.catalog.list())
                parts = path.strip("/").split("/")
                if len(parts) == 4 and parts[:2] == ["api", "assets"]:
                    asset_id, action = parts[2:]
                    if action == "history":
                        return self._json(studio.catalog.history(asset_id))
                    if action == "sidecar":
                        studio.catalog.get(asset_id)
                        file = studio.catalog.root / "sidecars" / (asset_id + ".fujiframe.json")
                        return self._bytes(file.read_bytes(), headers={"Content-Disposition": 'attachment; filename="photo.fujiframe.json"'})
                    if action == "thumbnail":
                        return self._bytes(studio.thumbnail(asset_id), "image/jpeg")
                if path.startswith("/api/"):
                    return self._json({"error": "Unknown endpoint"}, 404)
                file = (WEB_ROOT / (unquote(path).lstrip("/") or "index.html")).resolve()
                if not file.is_relative_to(WEB_ROOT.resolve()) or not file.is_file():
                    return self._json({"error": "Not found"}, 404)
                mime = mimetypes.guess_type(str(file))[0] or "application/octet-stream"
                return self._bytes(file.read_bytes(), mime)
            except (BrokenPipeError, ConnectionResetError):
                pass
            except Exception as exc:
                self._error(exc)

        def do_POST(self):
            try:
                self._guard(mutate=True)
                split = urlsplit(self.path)
                path, query = split.path, parse_qs(split.query)
                if path == "/api/import":
                    return self._json(studio.catalog.import_bytes(query.get("name", ["photo.jpg"])[0], self._body()))
                if path == "/api/demo":
                    return self._json(studio.catalog.import_bytes("Studio test landscape.jpg", demo_image()))
                if path == "/api/luts":
                    data = self._body(12 * 1024 * 1024)
                    parse_cube(data.decode("utf-8-sig"))
                    identity = hashlib.sha256(data).hexdigest()
                    file = studio.catalog.root / "luts" / (identity + ".cube")
                    file.write_bytes(data)
                    name = Path(query.get("name", ["Custom LUT"])[0]).name[:200]
                    with studio.catalog.lock:
                        studio.catalog.db.execute("INSERT OR REPLACE INTO luts VALUES(?,?)", (identity, name))
                        studio.catalog.db.commit()
                    return self._json({"id": identity, "name": name})
                if path == "/api/watch":
                    if studio.preview:
                        raise PermissionError("Folder integration is available when Studio runs on your desktop")
                    studio.watcher.configure(self._input().get("path"))
                    return self._json({"path": studio.catalog.setting("watch_folder")})
                if path == "/api/xraw/open":
                    if studio.preview:
                        raise PermissionError("Launch Studio on your desktop to open X RAW Studio")
                    open_xraw(studio.xraw)
                    return self._json({"opened": True})
                parts = path.strip("/").split("/")
                if len(parts) == 4 and parts[:2] == ["api", "assets"]:
                    asset_id, action = parts[2:]
                    if action == "rendering":
                        with studio.render_lock:
                            asset = studio.catalog.attach(asset_id, query.get("name", ["render.jpg"])[0], self._body())
                        return self._json(asset)
                    body = self._input()
                    if action == "edits":
                        return self._json(studio.catalog.save(asset_id, body["edits"], body.get("revision")))
                    if action == "mark":
                        return self._json(studio.catalog.mark(asset_id, body.get("rating", 0), body.get("flag", "")))
                    if action in ("preview", "export"):
                        data, mime, suffix, meta = studio.render(asset_id, body, export=action == "export")
                        headers = {"X-Studio-Meta": json.dumps(meta, ensure_ascii=True, separators=(",", ":"))}
                        if action == "export":
                            headers["Content-Disposition"] = f'attachment; filename="FujiFrame-{asset_id[:8]}{suffix}"'
                        return self._bytes(data, mime, headers=headers)
                return self._json({"error": "Unknown endpoint"}, 404)
            except (BrokenPipeError, ConnectionResetError):
                pass
            except Exception as exc:
                self._error(exc)

    server = ThreadingHTTPServer((host, port), Handler)
    server.daemon_threads = True
    return server


def demo_image():
    """A clearly labelled synthetic test scene, independent of photo licences."""
    w, h = 1800, 1200
    yy, xx = np.mgrid[0:h, 0:w]
    sky = np.stack([.30 + yy / h * .5, .48 + yy / h * .32, .58 + yy / h * .15], axis=2)
    im = Image.fromarray(np.uint8(np.clip(sky, 0, 1) * 255))
    draw = ImageDraw.Draw(im)
    draw.ellipse((1280, 170, 1435, 325), fill=(246, 220, 164))
    draw.polygon([(0, 690), (180, 540), (330, 600), (605, 295), (860, 565), (1040, 370), (1460, 710), (1800, 410), (1800, 1200), (0, 1200)], fill=(93, 115, 116))
    draw.polygon([(480, 440), (605, 295), (733, 435), (652, 410), (610, 450), (570, 405)], fill=(218, 220, 208))
    draw.polygon([(870, 535), (1040, 370), (1214, 520), (1090, 493), (1034, 454), (1008, 500)], fill=(206, 213, 201))
    draw.polygon([(0, 810), (350, 670), (570, 790), (970, 650), (1430, 730), (1800, 620), (1800, 1200), (0, 1200)], fill=(49, 77, 67))
    draw.polygon([(0, 1200), (0, 920), (650, 827), (1400, 880), (1800, 805), (1800, 1200)], fill=(130, 143, 102))
    draw.polygon([(750, 1200), (900, 1020), (1190, 910), (1250, 877), (1290, 880), (1260, 932), (1040, 1070), (1010, 1200)], fill=(183, 177, 139))
    rng = np.random.default_rng(7)
    pixels = np.asarray(im, dtype=np.float32)
    pixels += rng.normal(0, 2, (h, w, 1))
    output = io.BytesIO()
    Image.fromarray(np.uint8(np.clip(pixels, 0, 255))).save(output, "JPEG", quality=96)
    return output.getvalue()
