"""Supported round-trip / watched-folder integration; no private USB protocol."""
from pathlib import Path
import os
import platform
import subprocess
import threading
import time

from .catalog import EXTENSIONS, MAX_BYTES


def xraw_path(configured=None):
    candidates = [configured] if configured else []
    if platform.system() == "Darwin":
        candidates += ["/Applications/FUJIFILM X RAW STUDIO.app"]
    elif platform.system() == "Windows":
        for variable in ("ProgramFiles", "ProgramFiles(x86)"):
            base = os.environ.get(variable, "")
            if base:
                candidates += [str(p) for p in Path(base).glob("FUJIFILM*/**/*RAW*STUDIO*.exe")]
    return next((Path(p).resolve() for p in candidates if p and Path(p).exists()), None)


def open_xraw(configured=None):
    path = xraw_path(configured)
    if not path:
        raise ValueError("X RAW Studio was not found. Install it, or launch with --x-raw-studio followed by its application path.")
    if platform.system() == "Darwin" and path.suffix.lower() == ".app":
        subprocess.Popen(["open", "-a", str(path)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    elif platform.system() == "Windows" and path.suffix.lower() == ".exe":
        subprocess.Popen([str(path)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    else:
        raise ValueError("Launching X RAW Studio is supported on macOS and Windows")


class FolderWatcher:
    """Wait for stable size/mtime, import copies, and retry incomplete writes."""
    def __init__(self, catalog):
        self.catalog = catalog
        self.stop_event = threading.Event()
        self.observed = {}
        self.imported = {}
        self.errors = {}
        self.thread = threading.Thread(target=self.run, daemon=True)

    def configure(self, path):
        if not path:
            self.catalog.set_setting("watch_folder", None)
            self.observed.clear()
            return
        directory = Path(path).expanduser().resolve()
        if not directory.is_dir():
            raise ValueError("Choose an existing transfer folder on this computer")
        # Catalog copies/exports must never re-import themselves recursively.
        if directory == self.catalog.root or directory.is_relative_to(self.catalog.root):
            raise ValueError("Choose a transfer folder outside the Studio catalog")
        self.catalog.set_setting("watch_folder", str(directory))
        self.observed.clear()

    def scan(self):
        path = self.catalog.setting("watch_folder")
        if not path:
            return
        now = time.monotonic()
        for file in Path(path).iterdir():
            if not file.is_file() or file.is_symlink() or file.suffix.lower() not in EXTENSIONS:
                continue
            stat = file.stat()
            if not 0 < stat.st_size <= MAX_BYTES:
                continue
            key, signature = str(file), (stat.st_size, stat.st_mtime_ns)
            if self.imported.get(key) == signature:
                continue
            previous = self.observed.get(key)
            if not previous or previous[0] != signature:
                self.observed[key] = (signature, now)
                continue
            if now - previous[1] < 3:
                continue
            try:
                self.catalog.import_path(file)
                self.imported[key] = signature
                self.errors.pop(key, None)
            except Exception as exc:
                self.errors[key] = str(exc)
                self.observed[key] = (signature, now)  # bounded retry interval

    def run(self):
        while not self.stop_event.wait(2):
            try:
                self.scan()
            except OSError as exc:
                self.errors["folder"] = str(exc)
