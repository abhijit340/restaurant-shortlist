"""Local test server: serves the app, plus a fake version of the Sheet's script
at /mock-exec so the app can be tested without Google (and without spending
any of the free allowance).

  python tools/dev_server.py        then open http://localhost:8123/
  In the app's setup screen use URL http://localhost:8123/mock-exec, key "test".

The fake travel times come from straight-line distance:
walking ≈ 20 min/mile, transit ≈ 8 min + 6 min/mile (none past 6 miles).
"""
import json
import math
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

ROOT = Path(__file__).resolve().parent.parent
PORT = 8123


def miles(a, b):
    r = math.radians
    h = (math.sin(r(b[0] - a[0]) / 2) ** 2
         + math.cos(r(a[0])) * math.cos(r(b[0])) * math.sin(r(b[1] - a[1]) / 2) ** 2)
    return 2 * 3958.8 * math.asin(math.sqrt(h))


def fake_times(params):
    origin = tuple(map(float, params["from"][0].split(",")))
    dests = [tuple(map(float, d.split(","))) for d in params["to"][0].split("|")]
    d = [miles(origin, x) for x in dests]
    return {
        "walk": [round(m * 20) for m in d],
        "transit": [round(8 + m * 6) if m < 6 else None for m in d],
    }


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        # Lets the live site (github.io) use this fake script too, for testing the real build.
        self.send_header("Access-Control-Allow-Origin", "*")
        super().end_headers()

    def do_GET(self):
        url = urlparse(self.path)
        if url.path != "/mock-exec":
            return super().do_GET()
        params = parse_qs(url.query)
        if params.get("key") != ["test"]:
            body = {"error": "bad-key"}
        elif params.get("action") == ["times"]:
            body = fake_times(params)
        elif params.get("action") == ["geocode"]:
            # Any text "finds" a fixed spot on Capitol Hill, except "nowhere".
            q = params.get("q", [""])[0]
            body = ({"error": "not-found"} if q.lower() == "nowhere"
                    else {"lat": 47.6205, "lng": -122.3212, "label": f"{q.title()}, Seattle, WA, USA"})
        else:
            body = json.loads((ROOT / "tests" / "mock_exec.json").read_text(encoding="utf-8"))
        data = json.dumps(body).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


if __name__ == "__main__":
    print(f"Serving on http://localhost:{PORT}/  (fake script at /mock-exec, key 'test')")
    ThreadingHTTPServer(("", PORT), Handler).serve_forever()
