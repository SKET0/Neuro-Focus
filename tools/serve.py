"""Local dev server for Neuro-Focus that disables browser caching,
so edits to HTML/CSS/JS always show up on a normal refresh.

Usage (from the project folder): python3 tools/serve.py              (then open http://localhost:8000)
                                 python3 tools/serve.py 8000 8001 8002

It always serves the project root (the folder above tools/), wherever it is started from.

A browser keeps one sign-in per address, so each extra port gives you another account
side by side: e.g. the teacher on http://localhost:8000 and students on :8001 and :8002.
http://127.0.0.1:<port> also counts as a separate address.
"""
import sys
import threading
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent


class NoCacheHandler(SimpleHTTPRequestHandler):
    extensions_map = {**SimpleHTTPRequestHandler.extensions_map, ".js": "text/javascript"}

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


if __name__ == "__main__":
    ports = [int(arg) for arg in sys.argv[1:]] or [8000]
    handler = partial(NoCacheHandler, directory=str(PROJECT_ROOT))
    servers = [ThreadingHTTPServer(("127.0.0.1", port), handler) for port in ports]
    for server in servers[1:]:
        threading.Thread(target=server.serve_forever, daemon=True).start()
    for port in ports:
        print(f"Serving Neuro-Focus at http://localhost:{port}")
    print("(Ctrl+C to stop)")
    try:
        servers[0].serve_forever()
    except KeyboardInterrupt:
        pass
