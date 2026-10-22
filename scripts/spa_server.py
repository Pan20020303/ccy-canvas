#!/usr/bin/env python3
"""SPA-aware static file server.

Serves files from `--dir` (default: dist) and, when the requested path doesn't
match a real file, falls back to /index.html so React Router (SPA) routes
like /app, /admin, /login keep working after a hard refresh.

Usage:
    python3 scripts/spa_server.py --port 5173 --dir dist
"""

from __future__ import annotations

import argparse
import os
import sys
from http.server import HTTPServer, SimpleHTTPRequestHandler
from socketserver import ThreadingMixIn


class SPARequestHandler(SimpleHTTPRequestHandler):
    """Static file handler that rewrites missing routes to /index.html.

    Real files / asset bundles / favicons are served as-is. Anything else that
    accepts text/html is treated as an SPA route and gets the index.
    """

    def translate_path(self, path: str) -> str:  # noqa: D401
        # Strip query string before resolving against the filesystem.
        path = path.split("?", 1)[0].split("#", 1)[0]
        full = super().translate_path(path)

        if os.path.isfile(full):
            return full
        # Directory: let SimpleHTTPRequestHandler serve index.html if it exists.
        if os.path.isdir(full):
            return full

        # Anything else: rewrite to index.html so React Router takes over.
        return os.path.join(self.directory, "index.html")  # type: ignore[arg-type]

    def end_headers(self) -> None:
        # Prevent caching of index.html so deploys are picked up immediately.
        if self.path.endswith("/") or self.path in ("", "/index.html"):
            self.send_header("Cache-Control", "no-store, must-revalidate")
        super().end_headers()


class ThreadingHTTPServer(ThreadingMixIn, HTTPServer):
    """One thread per request — http.server is single-threaded by default."""

    daemon_threads = True
    allow_reuse_address = True


def main() -> int:
    p = argparse.ArgumentParser(description="SPA-aware static file server")
    p.add_argument("--port", type=int, default=5173)
    p.add_argument("--host", default="0.0.0.0")
    p.add_argument("--dir",  default="dist")
    args = p.parse_args()

    target = os.path.abspath(args.dir)
    if not os.path.isdir(target):
        print(f"error: directory not found: {target}", file=sys.stderr)
        return 1
    if not os.path.isfile(os.path.join(target, "index.html")):
        print(f"error: {target} has no index.html — did you run build-web?", file=sys.stderr)
        return 1

    os.chdir(target)
    httpd = ThreadingHTTPServer((args.host, args.port),
                                lambda *a, **kw: SPARequestHandler(*a, directory=target, **kw))
    print(f"Serving {target} on http://{args.host}:{args.port}  (Ctrl+C to stop)")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nshutting down")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
