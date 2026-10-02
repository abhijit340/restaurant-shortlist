"""Publish guard: the script must never change the human-edited restaurant tab.

Google Sheets has no "read-only for scripts" permission (the script runs as the
Sheet's owner), so this check enforces the rule in the code itself. It fails,
and tools/deploy_script.ps1 refuses to publish, unless:

 1. The restaurant tab (SOURCE_TAB) is opened in exactly one function,
    readSourcePlaces_, and nowhere else.
 2. That function only calls read methods on it (get…), nothing that writes,
    clears, deletes, inserts, sorts, or moves.
 3. No other code can reach the tab indirectly: sheets are only ever opened by
    the names SOURCE_TAB, DATA_TAB, or ADDED_TAB (no getSheets(), getActiveSheet(), …).
 4. Nothing deletes or renames whole tabs.
 5. Code that touches ADDED_TAB (places added from the phone) may add rows but
    never delete, clear, sort, or move anything.

Run from the project root:  python tools/check_sheet_writes.py
"""
import re
import sys
from pathlib import Path

CODE = Path(__file__).resolve().parent.parent / "apps-script" / "Code.gs"
READER = "readSourcePlaces_"

# Any method that changes a sheet or range.
WRITES = re.compile(
    r"\.(set[A-Z]\w*|clear\w*|delete\w*|append\w*|insert\w*|remove\w*|move\w*|sort|copyTo|"
    r"merge\w*|breakApart|protect|hide\w*|unhide\w*|activate|autoResize\w*|randomize|trimWhitespace|"
    r"splitTextToColumns|removeDuplicates|createFilter|applyRowBanding|applyColumnBanding)\s*\(")
# Ways to get hold of a sheet without naming it.
INDIRECT = re.compile(r"\.(getSheets|getActiveSheet|getSheetById|getActiveRange|getActiveCell|getRangeByName|getNamedRanges)\s*\(")
# What code touching the added-from-app tab must never do (adding rows is fine).
REMOVALS = re.compile(r"\.(clear\w*|delete\w*|remove\w*|move\w*|sort|randomize|removeDuplicates)\s*\(")
TAB_LEVEL = re.compile(r"\.(deleteSheet|deleteActiveSheet|renameActiveSheet|setActiveSheet|duplicateActiveSheet)\s*\(")


def strip_comments(code: str) -> str:
    code = re.sub(r"/\*.*?\*/", lambda m: "\n" * m.group().count("\n"), code, flags=re.S)
    return re.sub(r"//[^\n]*", "", code)


def function_bodies(code: str) -> dict:
    """Top-level `function name(...) { ... }` → body text, by brace matching."""
    out = {}
    for m in re.finditer(r"^function\s+(\w+)\s*\([^)]*\)\s*\{", code, flags=re.M):
        depth, i = 1, m.end()
        while depth and i < len(code):
            depth += {"{": 1, "}": -1}.get(code[i], 0)
            i += 1
        out[m.group(1)] = code[m.end():i - 1]
    return out


def main() -> int:
    code = strip_comments(CODE.read_text(encoding="utf-8"))
    bodies = function_bodies(code)
    problems = []

    if READER not in bodies:
        problems.append(f"{READER} not found: the guard no longer knows where the restaurant tab is read.")
    else:
        for bad in WRITES.findall(bodies[READER]):
            problems.append(f"{READER} calls .{bad}(): it may only read the restaurant tab.")

    for name, body in bodies.items():
        if name != READER and "SOURCE_TAB" in body:
            problems.append(f"{name} refers to SOURCE_TAB: only {READER} may open the restaurant tab.")
        for bad in INDIRECT.findall(body):
            problems.append(f"{name} calls .{bad}(): sheets must be opened by name so the restaurant tab can't be reached by accident.")
        for bad in TAB_LEVEL.findall(body):
            problems.append(f"{name} calls .{bad}(): deleting or renaming tabs is not allowed.")
        for arg in re.findall(r"getSheetByName\(\s*([^)]*?)\s*\)", body):
            if arg not in ("SOURCE_TAB", "DATA_TAB", "ADDED_TAB"):
                problems.append(f"{name} opens a sheet by {arg!r}: only SOURCE_TAB (read), DATA_TAB, and ADDED_TAB are allowed.")
        if "ADDED_TAB" in body:
            for bad in REMOVALS.findall(body):
                problems.append(f"{name} touches ADDED_TAB and calls .{bad}(): that tab is add-rows-only.")

    # SOURCE_TAB outside any function: only its own definition is allowed.
    outside = code
    for body in bodies.values():
        outside = outside.replace(body, "")
    if len(re.findall(r"\bSOURCE_TAB\b", outside)) != 1:
        problems.append("SOURCE_TAB is used outside functions beyond its one definition.")

    for msg in problems:
        print("BLOCKED:", msg)
    print("Restaurant tab is read-only in the script:", "NO, see above" if problems else "yes")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
