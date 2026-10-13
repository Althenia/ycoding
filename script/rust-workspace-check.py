import json
import re
import subprocess
import sys
from pathlib import Path

root = Path(__file__).resolve().parents[1]
manifest = root / "rust" / "Cargo.toml"
metadata = json.loads(
    subprocess.run(
        ["cargo", "metadata", "--format-version", "1", "--locked", "--manifest-path", str(manifest)],
        check=True,
        capture_output=True,
        text=True,
    ).stdout
)
packages = {package["id"]: package for package in metadata["packages"]}
by_name = {package["name"]: package for package in packages.values()}
workspace_ids = set(metadata["workspace_members"])
workspace_nodes = {node["id"]: node for node in metadata["resolve"]["nodes"]}

expected = {
    "ycoding-schema": set(),
    "ycoding-protocol": set(),
    "ycoding-store": {"ycoding-schema"},
    "ycoding-ai": {"ycoding-schema"},
    "ycoding-core": {"ycoding-ai", "ycoding-schema", "ycoding-store"},
    "ycoding-runtime": {"ycoding-core", "ycoding-protocol"},
}
errors = []
for name, allowed in expected.items():
    package = by_name.get(name)
    if package is None or package["id"] not in workspace_ids:
        errors.append(f"missing workspace crate {name}")
        continue
    actual = {
        packages[dependency]["name"]
        for dependency in workspace_nodes[package["id"]]["dependencies"]
        if dependency in workspace_ids
    }
    unexpected = actual - allowed
    missing = allowed - actual
    if unexpected:
        errors.append(f"{name} has forbidden workspace dependencies: {', '.join(sorted(unexpected))}")
    if missing:
        errors.append(f"{name} is missing required workspace dependencies: {', '.join(sorted(missing))}")

browser_roots = ("apps/web/src", "extensions/chrome", "packages/client/src")
for name in ("ycoding-core", "ycoding-store"):
    package = by_name.get(name)
    if package is None:
        continue
    source = Path(package["manifest_path"]).parent
    for file in [*source.rglob("*.rs"), source / "Cargo.toml"]:
        text = file.read_text(encoding="utf-8")
        for browser_root in browser_roots:
            if browser_root in text:
                errors.append(f"{name} reaches browser-facing TypeScript path {browser_root} in {file.relative_to(root)}")

allowed_licenses = {
    "0BSD", "AGPL-3.0-only", "AGPL-3.0-or-later", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause",
    "BSL-1.0", "CC0-1.0", "CDLA-Permissive-2.0", "ISC", "MIT", "MIT-0", "MPL-2.0", "OpenSSL",
    "Unicode-3.0", "Unlicense", "Zlib",
}
license_ids = set()
license_failures = []

def license_expression_allowed(expression):
    expression = expression.replace("/", " OR ")
    tokens = re.findall(r"[A-Za-z0-9][A-Za-z0-9.+-]*|[()]", expression)
    position = 0

    def parse_or():
        nonlocal position
        values = [parse_and()]
        while position < len(tokens) and tokens[position] == "OR":
            position += 1
            values.append(parse_and())
        return any(values)

    def parse_and():
        nonlocal position
        values = [parse_atom()]
        while position < len(tokens) and tokens[position] == "AND":
            position += 1
            values.append(parse_atom())
        return all(values)

    def parse_atom():
        nonlocal position
        if position >= len(tokens):
            raise ValueError("incomplete SPDX expression")
        if tokens[position] == "(":
            position += 1
            value = parse_or()
            if position >= len(tokens) or tokens[position] != ")":
                raise ValueError("unmatched SPDX parenthesis")
            position += 1
            return value
        identifier = tokens[position]
        position += 1
        if position < len(tokens) and tokens[position] == "WITH":
            position += 1
            if position >= len(tokens) or tokens[position] in {"AND", "OR", ")"}:
                raise ValueError("missing SPDX exception")
            position += 1
        return identifier in allowed_licenses

    try:
        result = parse_or()
        if position != len(tokens):
            raise ValueError("unexpected SPDX expression token")
        return result
    except ValueError:
        return False

for package in sorted(packages.values(), key=lambda item: item["name"]):
    expression = package.get("license")
    if not expression:
        license_failures.append(f"{package['name']} {package['version']}: missing SPDX license")
        continue
    identifiers = re.findall(r"[A-Za-z0-9][A-Za-z0-9.+-]*", expression)
    license_ids.update(identifier for identifier in identifiers if identifier not in {"AND", "OR", "WITH"})
    if not license_expression_allowed(expression):
        license_failures.append(f"{package['name']} {package['version']}: {expression}")

print("Transitive Cargo license expressions:")
for package in sorted(packages.values(), key=lambda item: item["name"]):
    print(f"  {package['name']} {package['version']}: {package.get('license') or 'MISSING'}")
print("License identifiers: " + (", ".join(sorted(license_ids)) if license_ids else "none"))
print("Bundled native notices: DuckDB/libduckdb-sys carries an MIT license and bundles C++/third_party source; Cargo metadata does not enumerate embedded component notices, so release packaging must retain the upstream notice set. rusqlite/libsqlite3-sys wrappers are MIT; bundled SQLite 3.53.2 C source is public domain.")
if license_failures:
    errors.extend(f"incompatible or unverified license: {failure}" for failure in license_failures)
if errors:
    print("Rust workspace boundary check failed:", file=sys.stderr)
    for error in errors:
        print(f"  {error}", file=sys.stderr)
    raise SystemExit(1)
print("Rust workspace dependency direction and license closure passed.")
