"""Local dev server for Neuro-Focus that disables browser caching,
so edits to HTML/CSS/JS always show up on a normal refresh.

Usage: python3 serve.py   (then open http://localhost:8000)
"""
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer


class NoCacheHandler(SimpleHTTPRequestHandler):
    extensions_map = {**SimpleHTTPRequestHandler.extensions_map, ".js": "text/javascript"}

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


if __name__ == "__main__":
    server = ThreadingHTTPServer(("127.0.0.1", 8000), NoCacheHandler)
    print("Serving Neuro-Focus at http://localhost:8000 (Ctrl+C to stop)")
    server.serve_forever()
