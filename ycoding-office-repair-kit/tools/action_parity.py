#!/usr/bin/env python3
"""Validate the TUI action parity ledger against the live keybind registry.

R6-06's acceptance is "classify every current action with implementation evidence or
explicit justified scope treatment; no silent removals". A ledger that is only prose
cannot demonstrate that: an action can be added to the TUI, or removed from the office,
and every prose claim stays exactly as true as it was. This checker makes both claims
mechanical.

It reads the LIVE registry (`packages/tui/src/config/keybind.ts`) and the ledger
(`tracking/tui-action-ledger.json`), then fails on:

  * an action in the registry that the ledger does not classify (an unclassified action);
  * a ledger row for an action the registry no longer has (a silent removal);
  * a row whose classification is not one of the declared classes;
  * a row with no basis, or a basis for an IMPLEMENTED class that cites no office path;
  * an implemented row that cites an office file which does not exist.

The last two are what keep the ledger honest: "equivalent" means the office has it, so
it must name where, and that path must resolve in this checkout.
"""
from pathlib import Path
import argparse, json, re, sys

# The classes a row may carry. `equivalent` and `gap` are the two that decide whether
# work remains; the rest are scope treatments that need no office surface.
CLASSES = {
    "equivalent",   # the office implements it; the basis must name an office path
    "gap",          # a real capability the office lacks; a task owns it
    "widget",       # text-editing mechanics a native widget owns
    "terminal",     # meaningless outside a terminal
    "diff_viewer",  # the TUI's diff viewer; the office presents changes as drawer detail
    "n/a",          # deliberately absent by product rule
}

# Classes whose basis must cite an existing office path, because they claim the office
# implements the action rather than merely accounting for it.
MUST_CITE_OFFICE = {"equivalent"}

# The registry lives in the repository, the ledger inside the kit, and the office paths a
# basis cites are repository-relative. One root cannot serve all three: the kit ships
# without the repository around it, so the repository root is discovered from the kit
# rather than assumed to be the same directory.
REGISTRY_TAIL = "packages/tui/src/config/keybind.ts"
LEDGER_TAIL = "tracking/tui-action-ledger.json"
OFFICE_PATH = re.compile(r"apps/office/[\w/.\-]+")


def repo_root(kit_root: Path) -> Path:
    """The repository root that holds the registry the ledger classifies.

    `--root` names the KIT (its tracking directory holds the ledger). The repository is
    found by walking up for the registry, so the checker works from either directory.
    """
    start = kit_root.resolve()
    for candidate in (start, *start.parents):
        if (candidate / REGISTRY_TAIL).is_file():
            return candidate
    return kit_root


def registry_actions(root: Path) -> dict[str, dict]:
    """Every action the live TUI keybind registry declares.

    Parsed from the source because the registry is TypeScript, which no interpreter here
    can import. A definition is `name: keybind(<default>, "description")` nested two
    spaces inside `Definitions`; `default` may span a line, so the pattern is non-greedy
    up to the quoted description that always closes it.
    """
    text = (root / REGISTRY_TAIL).read_text()
    block = re.search(r"export const Definitions = \{(.*?)\n\}", text, re.S)
    if block is None:
        raise ValueError(f"no Definitions block in {REGISTRY_TAIL}")
    found: dict[str, dict] = {}
    pattern = re.compile(
        r'^\s{2}([a-z_0-9]+):\s*keybind\(\s*(.*?),\s*"((?:[^"\\]|\\.)*)"\s*,?\s*\)\s*,\s*$',
        re.M | re.S,
    )
    for match in pattern.finditer(block.group(1)):
        default = re.sub(r"\s+", " ", match.group(2)).strip().strip('"')
        found[match.group(1)] = {
            "default": default,
            "bound_by_default": default not in ("none", "false"),
            "description": match.group(3),
        }
    if not found:
        raise ValueError(f"parsed no actions from {REGISTRY_TAIL}")
    return found


def check(root: Path) -> list[str]:
    errors: list[str] = []
    repo = repo_root(root)
    try:
        live = registry_actions(repo)
    except (OSError, ValueError) as exc:
        return [f"registry unreadable: {exc}"]
    ledger_path = root / LEDGER_TAIL
    if not ledger_path.is_file():
        return [f"missing ledger: {LEDGER_TAIL}"]
    try:
        rows = json.loads(ledger_path.read_text())["actions"]
    except (json.JSONDecodeError, KeyError) as exc:
        return [f"ledger unreadable: {exc}"]

    by_name = {str(row.get("name", "")): row for row in rows}
    if len(by_name) != len(rows):
        errors.append("ledger has duplicate action names")

    for name in sorted(set(live) - set(by_name)):
        errors.append(f"unclassified action: {name}")

    for name in sorted(set(by_name) - set(live)):
        errors.append(f"ledger row for an action the registry does not have: {name}")

    for name in sorted(set(live) & set(by_name)):
        row = by_name[name]
        row_class = str(row.get("classification", ""))
        basis = str(row.get("basis", "")).strip()
        if row_class not in CLASSES:
            errors.append(f"{name}: unknown classification {row_class!r}")
            continue
        if not basis:
            errors.append(f"{name}: no basis")
        # The registry's own default must not silently drift out of the ledger.
        if str(row.get("default", "")) != live[name]["default"]:
            errors.append(
                f"{name}: default drifted (ledger {row.get('default')!r}, "
                f"registry {live[name]['default']!r})"
            )
        if row_class in MUST_CITE_OFFICE:
            cited = OFFICE_PATH.findall(basis)
            if not cited:
                errors.append(f"{name}: {row_class} cites no office path")
                continue
            for path in cited:
                if not (repo / path).exists():
                    errors.append(f"{name}: {row_class} cites a missing path {path}")
    return errors


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parent.parent)
    args = parser.parse_args()
    errors = check(args.root)
    if errors:
        print("\n".join(errors))
        return 1
    live = registry_actions(repo_root(args.root))
    try:
        rows = json.loads((args.root / LEDGER_TAIL).read_text())["actions"]
    except (json.JSONDecodeError, KeyError, OSError):
        # check() already reported the cause; report the failure rather than a count.
        return 1
    counts: dict[str, int] = {}
    for row in rows:
        counts[str(row.get("classification", ""))] = counts.get(str(row.get("classification", "")), 0) + 1
    summary = ", ".join(f"{k}={counts[k]}" for k in sorted(counts))
    print(
        f"TUI action parity: {len(live)} live actions, all classified ({summary}). "
        "Every implemented action names an office path that exists."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
