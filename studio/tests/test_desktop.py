import hashlib
import io
import json
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import Request, urlopen

import numpy as np
from PIL import Image

from studio.catalog import Catalog, ConflictError
from studio.integration import FolderWatcher
from studio.server import Studio, make_server


def photo_bytes():
    output = io.BytesIO()
    Image.new("RGB", (120, 80), (135, 122, 98)).save(output, "JPEG")
    return output.getvalue()


class CatalogTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.catalog = Catalog(Path(self.temp.name) / "catalog")
        self.data = photo_bytes()
        self.asset = self.catalog.import_bytes("DSCF0123.JPG", self.data)

    def tearDown(self):
        self.catalog.db.close()
        self.temp.cleanup()

    def test_duplicate_import_and_source_immutability(self):
        duplicate = self.catalog.import_bytes("another.jpg", self.data)
        self.assertEqual(duplicate["id"], self.asset["id"])
        self.assertEqual(len(self.catalog.list()), 1)
        self.catalog.save(self.asset["id"], {"exposure": 1.25}, 0)
        path = Path(self.catalog.get(self.asset["id"], True)["path"])
        self.assertEqual(hashlib.sha256(path.read_bytes()).hexdigest(), self.asset["id"])

    def test_persistent_edits_sidecar_history_and_revision_conflict(self):
        saved = self.catalog.save(self.asset["id"], {"exposure": .5}, 0)
        self.assertEqual(saved["revision"], 1)
        with self.assertRaises(ConflictError):
            self.catalog.save(self.asset["id"], {"exposure": 1}, 0)
        sidecar = json.loads((self.catalog.root / "sidecars" / (self.asset["id"] + ".fujiframe.json")).read_text())
        self.assertEqual(sidecar["source_sha256"], self.asset["id"])
        self.assertEqual(len(self.catalog.history(self.asset["id"])), 2)
        other = Catalog(self.catalog.root)
        try:
            self.assertEqual(other.get(self.asset["id"])["edits"]["exposure"], .5)
        finally:
            other.db.close()

    def test_bad_imports_are_not_recorded(self):
        for name, data in (("bad.exe", self.data), ("bad.jpg", b"not a photo"), ("bad.raf", b"not a RAF")):
            with self.subTest(name=name), self.assertRaises(Exception):
                self.catalog.import_bytes(name, data)
        self.assertEqual(len(self.catalog.list()), 1)

    def test_watcher_waits_for_stability_and_ignores_its_own_catalog(self):
        folder = Path(self.temp.name) / "incoming"; folder.mkdir()
        watcher = FolderWatcher(self.catalog)
        with self.assertRaises(ValueError):
            watcher.configure(str(self.catalog.root))
        watcher.configure(str(folder))
        (folder / "new.jpg").write_bytes(self.data)
        with patch("studio.integration.time.monotonic", return_value=10):
            watcher.scan()
        self.assertEqual(watcher.imported, {})
        with patch("studio.integration.time.monotonic", return_value=14):
            watcher.scan()
        self.assertEqual(len(watcher.imported), 1)
        self.assertFalse(watcher.errors)


class HttpTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.studio = Studio(self.temp.name, preview=True)
        self.server = make_server(self.studio, "127.0.0.1", 0)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True); self.thread.start()
        self.url = f"http://127.0.0.1:{self.server.server_port}"

    def tearDown(self):
        self.server.shutdown(); self.server.server_close()
        self.studio.catalog.db.close(); self.temp.cleanup()

    def call(self, path, value=None, raw=None, csrf=True):
        data = raw if raw is not None else json.dumps(value).encode() if value is not None else None
        headers = {"X-Studio-CSRF": self.studio.csrf} if csrf else {}
        return urlopen(Request(self.url + path, data=data, headers=headers), timeout=20)

    def test_csrf_rejects_cross_site_writes_and_preview_native_integrations(self):
        with self.assertRaises(HTTPError) as error:
            self.call("/api/demo", {}, csrf=False)
        self.assertEqual(error.exception.code, 403)
        with self.assertRaises(HTTPError) as error:
            self.call("/api/watch", {"path":"/tmp"})
        self.assertEqual(error.exception.code, 403)

    def test_import_edit_export_and_restart_visible_catalog(self):
        asset = json.load(self.call("/api/import?name=DSCF0012.jpg", raw=photo_bytes()))
        saved = json.load(self.call(f"/api/assets/{asset['id']}/edits", {"edits":{"exposure": .5},"revision":0}))
        self.assertEqual(saved["revision"], 1)
        response = self.call(f"/api/assets/{asset['id']}/export", {"format":"tiff16"})
        self.assertEqual(response.headers["Content-Type"], "image/tiff")
        import tifffile
        out = tifffile.imread(io.BytesIO(response.read()))
        self.assertEqual(out.shape, (80,120,3)); self.assertEqual(out.dtype, np.uint16)
        state = json.load(self.call("/api/state"))
        self.assertEqual(state["assets"][0]["edits"]["exposure"], .5)

    def test_embedded_preview_cannot_masquerade_as_full_raw_export(self):
        asset = self.studio.catalog.import_bytes("test.jpg", photo_bytes())
        with patch.object(self.studio, "source", return_value=(np.full((20,30,3), .3, np.float32), False, True)):
            with self.assertRaisesRegex(ValueError, "embedded preview"):
                self.studio.render(asset["id"], {"format":"jpeg"}, export=True)
            data, _, _, meta = self.studio.render(asset["id"], {"format":"jpeg", "allow_preview":True}, export=True)
            self.assertTrue(data); self.assertTrue(meta["preview_only"])

    def test_before_preview_has_matching_crop_and_rotation(self):
        asset = self.studio.catalog.import_bytes("test.jpg", photo_bytes())
        body = {"edits":{"quarter_turns":1,"crop":[0,0,.5,1]}, "before":True}
        data, _, _, meta = self.studio.render(asset["id"], body)
        self.assertEqual((meta["width"],meta["height"]), (40,120))


if __name__ == "__main__":
    unittest.main()
