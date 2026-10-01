"""Pre-commit check: make sure nothing from the real restaurant list is about to
be published. Compares staged files against tests/fixture.json (names,
descriptions, deals), ignoring case and punctuation.

Run from the project root after `git add`:  python tools/check_no_private_data.py
Exits with status 1 if anything matches.
"""
import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FIXTURE = ROOT / "tests" / "fixture.json"
# Text the code legitimately needs: the tab's own structure.
ALLOWED = {"name", "to try", "avoid", "would recommend want to return"}


def norm(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", s.lower()).strip()


def main() -> int:
    if not FIXTURE.exists():
        print("tests/fixture.json not found; run tools/export_fixture.py first.")
        return 1
    rows = json.loads(FIXTURE.read_text(encoding="utf-8"))["values"]
    names = {norm(r[0]) for r in rows if r[0] and not r[0].startswith("http")}
    names = {n for n in names if len(n) > 4} - ALLOWED
    phrases = {norm(r[k]) for r in rows for k in (2, 4) if r[k] and len(norm(r[k])) > 12}

    staged = subprocess.run(["git", "diff", "--cached", "--name-only", "--diff-filter=AM"],
                            capture_output=True, text=True, cwd=ROOT).stdout.split()
    hits = []
    for f in staged:
        if f.endswith(".png"):
            continue
        text = " " + norm((ROOT / f).read_text(encoding="utf-8")) + " "
        hits += [(f, n) for n in names | phrases if f" {n} " in text]

    for f, n in sorted(hits):
        print(f"{f}: {n}")
    print(f"Checked {len(staged)} staged files: {'FOUND private data' if hits else 'clean'}")
    return 1 if hits else 0


if __name__ == "__main__":
    sys.exit(main())
