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
import time
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
        if url.path not in ("/mock-exec", "/mock-exec-slow"):
            return super().do_GET()
        if url.path == "/mock-exec-slow":
            time.sleep(3)  # a slow Sheet, for testing the instant start from the saved list
        params = parse_qs(url.query)
        if params.get("key") != ["test"]:
            body = {"error": "bad-key"}
        elif params.get("action") == ["times"]:
            body = fake_times(params)
        elif params.get("action") == ["find"]:
            q = params.get("q", [""])[0]
            body = {"candidates": [] if q.lower() == "nowhere" else [
                {"id": "fake-1", "name": q.title(), "addr": "800 Example Ave, Seattle", "lat": 47.6125, "lng": -122.3365,
                 "cuisine": "Ramen restaurant", "status": "OPERATIONAL", "maps": "https://maps.google.com/?q=47.6125,-122.3365",
                 "utc": -420, "hours": [[d, 1100, d, 2200] for d in range(7)]},
                {"id": "fake-2", "name": q.title() + " (Eastside)", "addr": "900 Example Way, Bellevue", "lat": 47.6101, "lng": -122.2015,
                 "cuisine": "Ramen restaurant", "status": "OPERATIONAL", "maps": "", "utc": -420, "hours": []},
            ]}
        elif params.get("action") == ["geocode"]:
            # Any text "finds" a fixed spot on Capitol Hill, except "nowhere".
            q = params.get("q", [""])[0]
            body = ({"error": "not-found"} if q.lower() == "nowhere"
                    else {"lat": 47.6205, "lng": -122.3212, "label": f"{q.title()}, Seattle, WA, USA"})
        else:
            body = json.loads((ROOT / "tests" / "mock_exec.json").read_text(encoding="utf-8"))
            for place in body["places"]:
                place["visit"] = VISITS.get(place["key"])
                place["pending"] = place["key"] in PENDING
                e = {f: {"sheet": place[f], "now": v} for f, v in EDITS.get(place["key"], {}).items()}
                if e:
                    place.update({f: x["now"] for f, x in e.items()})
                place["edited"] = e or None
            body["places"] += ADDED
        self.send_json(body)

    def do_POST(self):
        """Fake "mark visited": visits are kept in memory until the server restarts."""
        if urlparse(self.path).path != "/mock-exec":
            return self.send_error(404)
        req = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
        if req.get("key") != "test":
            body = {"error": "bad-key"}
        elif req.get("action") == "add":
            key = " ".join(req.get("name", "").lower().split())
            listed = {p["key"] for p in json.loads((ROOT / "tests" / "mock_exec.json").read_text(encoding="utf-8"))["places"]}
            if key in listed or any(p["key"] == key for p in ADDED):
                body = {"error": "already-listed"}
            else:
                loc = req.get("loc")
                ADDED.append({"key": key, "name": req["name"].strip(), "section": "try", "row": "added", "desc": req.get("desc", ""),
                              "hood": req.get("hood", ""), "deals": req.get("deals", ""), "menu": "", "tags": [], "fav": False,
                              "struck": False, "added": True, "cuisine": (loc or {}).get("cuisine", ""),
                              "closed": "open" if loc else "", "locs": [loc] if loc else [], "visit": None, "pending": not loc})
                body = {"ok": True, "key": key}
        elif req.get("action") == "edit":
            sheet = next((p for p in json.loads((ROOT / "tests" / "mock_exec.json").read_text(encoding="utf-8"))["places"]
                          if p["key"] == req.get("place")), None)
            if not sheet:
                body = {"error": "no-such-place"}
            else:
                mine = EDITS.setdefault(sheet["key"], {})
                for f in ("desc", "deals"):
                    now = str(req.get(f, "")).strip()
                    if now == sheet[f]:
                        mine.pop(f, None)
                    else:
                        mine[f] = now
                e = {f: {"sheet": sheet[f], "now": v} for f, v in mine.items()}
                body = {"ok": True, "desc": mine.get("desc", sheet["desc"]), "deals": mine.get("deals", sheet["deals"]), "edited": e or None}
        elif req.get("action") == "fill":
            looked = len(PENDING)
            PENDING.clear()  # pretend Google was asked about every waiting place
            body = {"ok": True, "looked": looked, "remaining": 0}
        elif req.get("action") != "visit":
            body = {"error": "bad-request"}
        elif req.get("place") == "unplaced bakery":
            body = {"error": "busy"}  # lets the app's "Sheet is busy" message be tested
        else:
            if req.get("verdict") in ("Loved", "Good", "Meh"):
                first = VISITS.get(req["place"], {}).get("date", "2026-10-02")
                VISITS[req["place"]] = {"date": first, "verdict": req["verdict"],
                                        "deals": req.get("deals", "").strip(), "notes": req.get("notes", "").strip()}
            else:
                VISITS.pop(req["place"], None)
            body = {"ok": True, "visit": VISITS.get(req["place"])}
        self.send_json(body)

    def send_json(self, body):
        data = json.dumps(body).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


VISITS = {}  # place key -> visit, for the fake script
ADDED = []   # places "added from the app", for the fake script
EDITS = {}   # place key -> {field: edited text}, for the fake script
PENDING = {"unplaced bakery"}  # places "not looked up yet", until the app asks for a lookup


if __name__ == "__main__":
    print(f"Serving on http://localhost:{PORT}/  (fake script at /mock-exec, key 'test')")
    ThreadingHTTPServer(("", PORT), Handler).serve_forever()
