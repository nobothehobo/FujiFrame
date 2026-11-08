"""SQLite catalog, immutable source copies, and versioned adjustments."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import threading
import time
import uuid

from PIL import Image, ExifTags

from .engine import DEFAULTS, validate_edits

EXTENSIONS = {".raf", ".jpg", ".jpeg", ".png", ".tif", ".tiff", ".webp"}
MAX_BYTES = 250 * 1024 * 1024


def atomic_json(path, value):
    temporary = path.with_name(path.name + "." + uuid.uuid4().hex + ".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(temporary, path)


def read_metadata(path):
    result = {}
    try:
        with Image.open(path) as im:
            result.update({"width": im.width, "height": im.height})
            exif = im.getexif()
            values = {ExifTags.TAGS.get(k, str(k)): v for k, v in exif.items()}
            try:
                values.update({ExifTags.TAGS.get(k, str(k)): v for k, v in exif.get_ifd(34665).items()})
            except (KeyError, TypeError):
                pass
            for key in ("Make", "Model", "LensModel", "DateTimeOriginal", "FNumber", "ExposureTime", "ISOSpeedRatings", "FocalLength"):
                if key in values:
                    value = values[key]
                    result[key] = str(value) if not isinstance(value, (str, int, float)) else value
    except (OSError, ValueError):
        pass
    exiftool = shutil.which("exiftool")
    if exiftool:
        proc = subprocess.run([exiftool, "-j", "-G1", "-s", "-Make", "-Model", "-LensModel", "-DateTimeOriginal",
            "-FNumber", "-ExposureTime", "-ISO", "-FocalLength", "-ImageWidth", "-ImageHeight", "-FujiFilm:all", str(path)],
            capture_output=True, timeout=20, check=False)
        if proc.returncode == 0:
            rows = json.loads(proc.stdout)
            if rows:
                result["exiftool"] = {k: v for k, v in rows[0].items() if k != "SourceFile"}
                for key, value in result["exiftool"].items():
                    if key.split(":")[-1] in ("Make", "Model", "LensModel", "DateTimeOriginal", "FNumber", "ExposureTime", "ISO", "FocalLength"):
                        result[key.split(":")[-1]] = value
                film = result["exiftool"].get("FujiFilm:FilmMode", "")
                saturation = result["exiftool"].get("FujiFilm:Saturation", "")
                result["film_simulation"] = f"{film} · {saturation}".strip(" ·")
    result["metadata_reader"] = "ExifTool" if exiftool else "Pillow (install ExifTool for Fujifilm recipe tags)"
    return result


class Catalog:
    def __init__(self, root):
        self.root = Path(root).expanduser().resolve()
        for name in ("originals", "renders", "luts", "sidecars", "cache", "exports"):
            (self.root / name).mkdir(parents=True, exist_ok=True)
        self.lock = threading.RLock()
        self.db = sqlite3.connect(self.root / "catalog.sqlite3", check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        self.db.executescript("""
          PRAGMA journal_mode=WAL;
          CREATE TABLE IF NOT EXISTS assets (
            id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL,
            metadata TEXT NOT NULL, edits TEXT NOT NULL, render_path TEXT,
            rating INTEGER NOT NULL DEFAULT 0, flag TEXT NOT NULL DEFAULT '',
            created REAL NOT NULL, revision INTEGER NOT NULL DEFAULT 0
          );
          CREATE TABLE IF NOT EXISTS revisions (
            asset_id TEXT NOT NULL, revision INTEGER NOT NULL, edits TEXT NOT NULL,
            created REAL NOT NULL, PRIMARY KEY(asset_id, revision)
          );
          CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS luts (id TEXT PRIMARY KEY, name TEXT NOT NULL);
        """)
        self.db.commit()

    def public(self, row):
        d = dict(row)
        d["metadata"] = json.loads(d["metadata"])
        d["edits"] = json.loads(d["edits"])
        d["kind"] = "raf" if Path(d["path"]).suffix.lower() == ".raf" else "render"
        d["has_render"] = bool(d["render_path"])
        d["preview_only"] = d["kind"] == "raf" and d["edits"]["mode"] == "camera" and not d["has_render"]
        d.pop("path")
        d.pop("render_path")
        return d

    def list(self):
        with self.lock:
            return [self.public(r) for r in self.db.execute("SELECT * FROM assets ORDER BY created DESC")]

    def get(self, asset_id, private=False):
        with self.lock:
            row = self.db.execute("SELECT * FROM assets WHERE id=?", (asset_id,)).fetchone()
            if row is None:
                raise KeyError("Photo not found")
            return dict(row) if private else self.public(row)

    def import_bytes(self, name, data):
        name = Path(name.replace("\\", "/")).name
        suffix = Path(name).suffix.lower()
        if suffix not in EXTENSIONS:
            raise ValueError("Import RAF, JPEG, PNG, WebP, or RGB TIFF files")
        if not data or len(data) > MAX_BYTES:
            raise ValueError("File must be between 1 byte and 250 MB")
        identity = hashlib.sha256(data).hexdigest()
        with self.lock:
            existing = self.db.execute("SELECT * FROM assets WHERE id=?", (identity,)).fetchone()
            if existing:
                return self.public(existing)
            path = self.root / "originals" / (identity + suffix)
            path.write_bytes(data)
            try:
                if suffix == ".raf":
                    if not data.startswith(b"FUJIFILMCCD-RAW"):
                        raise ValueError("File does not contain a Fujifilm RAF header")
                    import rawpy
                    with rawpy.imread(str(path)) as raw:
                        raw.extract_thumb()  # reject corrupt/unreadable RAFs on import
                else:
                    with Image.open(path) as image:
                        image.verify()
                metadata = read_metadata(path)
            except Exception:
                path.unlink(missing_ok=True)
                raise
            edits = validate_edits({})
            self.db.execute("INSERT INTO assets(id,name,path,metadata,edits,created) VALUES(?,?,?,?,?,?)",
                (identity, name, str(path), json.dumps(metadata), json.dumps(edits), time.time()))
            self.db.execute("INSERT INTO revisions VALUES(?,?,?,?)", (identity, 0, json.dumps(edits), time.time()))
            self.db.commit()
            self._sidecar(identity)
            return self.get(identity)

    def import_path(self, path):
        path = Path(path).resolve()
        if not path.is_file() or path.stat().st_size > MAX_BYTES:
            raise ValueError("Photo is missing or larger than 250 MB")
        return self.import_bytes(path.name, path.read_bytes())

    def save(self, asset_id, data, expected_revision):
        edits = validate_edits(data)
        with self.lock:
            row = self.get(asset_id, True)
            if expected_revision != row["revision"]:
                raise ConflictError("This photo changed in another window. Reload it before saving.")
            if json.loads(row["edits"]) == edits:
                return self.get(asset_id)
            revision = row["revision"] + 1
            self.db.execute("UPDATE assets SET edits=?,revision=? WHERE id=?", (json.dumps(edits), revision, asset_id))
            self.db.execute("INSERT INTO revisions VALUES(?,?,?,?)", (asset_id, revision, json.dumps(edits), time.time()))
            self.db.commit()
            self._sidecar(asset_id)
            return self.get(asset_id)

    def mark(self, asset_id, rating, flag):
        if not isinstance(rating, int) or not 0 <= rating <= 5 or flag not in ("", "pick", "reject"):
            raise ValueError("Invalid rating or flag")
        with self.lock:
            self.get(asset_id)
            self.db.execute("UPDATE assets SET rating=?,flag=? WHERE id=?", (rating, flag, asset_id))
            self.db.commit()
            self._sidecar(asset_id)
            return self.get(asset_id)

    def attach(self, asset_id, name, data):
        asset = self.get(asset_id, True)
        if not asset["path"].lower().endswith(".raf"):
            raise ValueError("Attach a camera rendering to a RAF original")
        suffix = Path(name).suffix.lower()
        if suffix not in (".jpg", ".jpeg", ".tif", ".tiff", ".png"):
            raise ValueError("Choose the corresponding JPEG, TIFF, or PNG rendering")
        if not data or len(data) > MAX_BYTES:
            raise ValueError("Rendering must be at most 250 MB")
        identity = hashlib.sha256(data).hexdigest()
        path = self.root / "renders" / (identity + suffix)
        path.write_bytes(data)
        try:
            from .engine import load_rgb
            load_rgb(path, max_edge=64)
        except Exception:
            path.unlink(missing_ok=True)
            raise
        with self.lock:
            self.db.execute("UPDATE assets SET render_path=? WHERE id=?", (str(path), asset_id))
            self.db.commit()
            for cached in (self.root / "cache").glob(asset_id + "*"):
                cached.unlink(missing_ok=True)
            self._sidecar(asset_id)
            return self.get(asset_id)

    def _sidecar(self, asset_id):
        row = self.get(asset_id, True)
        atomic_json(self.root / "sidecars" / (asset_id + ".fujiframe.json"), {
            "schema": "fujiframe-studio/v1", "source_sha256": asset_id,
            "source_name": row["name"], "render_file": Path(row["render_path"]).name if row["render_path"] else None,
            "revision": row["revision"], "edits": json.loads(row["edits"]),
            "rating": row["rating"], "flag": row["flag"], "source_metadata": json.loads(row["metadata"]),
        })

    def history(self, asset_id):
        with self.lock:
            self.get(asset_id)
            return [{**dict(r), "edits": json.loads(r["edits"])} for r in self.db.execute(
                "SELECT revision,edits,created FROM revisions WHERE asset_id=? ORDER BY revision DESC LIMIT 100", (asset_id,))]

    def set_setting(self, key, value):
        with self.lock:
            self.db.execute("INSERT OR REPLACE INTO settings VALUES(?,?)", (key, json.dumps(value)))
            self.db.commit()

    def setting(self, key, default=None):
        with self.lock:
            row = self.db.execute("SELECT value FROM settings WHERE key=?", (key,)).fetchone()
            return json.loads(row[0]) if row else default


class ConflictError(ValueError):
    pass
