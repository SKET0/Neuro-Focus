"""Local dev server for Neuro-Focus that disables browser caching,
so edits to HTML/CSS/JS always show up on a normal refresh.

Usage: python3 serve.py              (then open http://localhost:8000)
       python3 serve.py 8000 8001 8002

A browser keeps one sign-in per address, so each extra port gives you another account
side by side: e.g. the teacher on http://localhost:8000 and students on :8001 and :8002.
http://127.0.0.1:<port> also counts as a separate address.
"""
import sys
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer


class NoCacheHandler(SimpleHTTPRequestHandler):
    extensions_map = {**SimpleHTTPRequestHandler.extensions_map, ".js": "text/javascript"}

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


if __name__ == "__main__":
    ports = [int(arg) for arg in sys.argv[1:]] or [8000]
    servers = [ThreadingHTTPServer(("127.0.0.1", port), NoCacheHandler) for port in ports]
    for server in servers[1:]:
        threading.Thread(target=server.serve_forever, daemon=True).start()
    for port in ports:
        print(f"Serving Neuro-Focus at http://localhost:{port}")
    print("(Ctrl+C to stop)")
    try:
        servers[0].serve_forever()
    except KeyboardInterrupt:
        pass
