"""python -m studio [--project directory]"""
import argparse
import os
from pathlib import Path
import threading
import webbrowser

from .server import Studio, make_server


def main():
    parser = argparse.ArgumentParser(description="FujiFrame Studio — local photo editor")
    parser.add_argument("--project", default=str(Path.home() / "Pictures" / "FujiFrame-Studio"))
    parser.add_argument("--port", type=int, default=int(os.environ.get("PORT", "8765")))
    parser.add_argument("--no-browser", action="store_true")
    parser.add_argument("--watch", help="Existing X Acquire / Tether App / X RAW Studio output folder")
    parser.add_argument("--x-raw-studio", help="Installed .app or .exe application path")
    parser.add_argument("--preview", action="store_true", help="Managed UI QA only; disables native integrations and binds all interfaces")
    args = parser.parse_args()
    studio = Studio(args.project, preview=args.preview, xraw=args.x_raw_studio)
    if args.watch:
        if args.preview:
            parser.error("--watch cannot be used with --preview")
        studio.watcher.configure(args.watch)
    host = "0.0.0.0" if args.preview else "127.0.0.1"
    server = make_server(studio, host, args.port)
    url = f"http://127.0.0.1:{server.server_port}"
    print(f"FujiFrame Studio {url}", flush=True)
    print("Source photos stay on this computer. Press Ctrl+C to quit.", flush=True)
    if not args.no_browser and not args.preview:
        threading.Timer(.6, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        studio.watcher.stop_event.set()
        server.server_close()


if __name__ == "__main__":
    main()
