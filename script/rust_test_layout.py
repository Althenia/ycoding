import json
import re
import sys
import tomllib
from pathlib import Path


MODULE = re.compile(r'\s*#\[path\s*=\s*"([^"\n]+)"\]\s*(?:pub\s+)?mod\s+([A-Za-z_]\w*)\s*;')


def inspect_layout(root: Path):
    packages = {}
    errors = []
    for manifest in sorted((root / "rust" / "crates").glob("*/Cargo.toml")):
        config = tomllib.loads(manifest.read_text())
        name = config["package"]["name"]
        tests = (manifest.parent / "tests").resolve()
        sources = set(tests.glob("*.rs"))
        declarations = config.get("test", [])
        roots = {}
        groups = {}
        for target in declarations:
            file = (manifest.parent / target.get("path", f"tests/{target['name']}.rs")).resolve()
            if not file.is_relative_to(tests):
                errors.append(f"{name}: test target {target['name']} escapes its test directory")
                continue
            if not file.is_file():
                errors.append(f"{name}: missing test target {target['name']}")
                continue
            if target["name"] in roots:
                errors.append(f"{name}: duplicate test target {target['name']}")
                continue
            roots[target["name"]] = file
            content = file.read_text()
            entries = list(MODULE.finditer(content))
            if entries and not MODULE.sub("", content).strip():
                groups[file] = entries

        if groups and config["package"].get("autotests", True):
            errors.append(f"{name}: suite aggregation requires autotests = false")

        mapping = {}

        def register(file, target, prefix):
            source = str(file.relative_to(tests))
            if file not in sources:
                errors.append(f"{name}: missing test source {source}")
                return
            if source in mapping:
                errors.append(f"{name}: test source {source} is registered more than once")
                return
            mapping[source] = {"target": target, "prefix": prefix}

        if config["package"].get("autotests", True):
            for file in sorted(sources):
                if file.stem not in roots:
                    register(file, file.stem, "")
            for target, file in roots.items():
                if file not in groups:
                    register(file, target, "")
        if config["package"].get("autotests", True) is False:
            for target, file in roots.items():
                if file not in groups:
                    register(file, target, "")
                    continue
                for entry in groups[file]:
                    source = (file.parent / entry.group(1)).resolve()
                    if source.parent != tests:
                        errors.append(f"{name}: suite module escapes its test directory")
                        continue
                    if source in groups:
                        errors.append(f"{name}: nested suite roots are not test sources")
                        continue
                    register(source, target, f"{entry.group(2)}::")

        for file in sorted(sources - groups.keys()):
            if str(file.relative_to(tests)) not in mapping:
                errors.append(f"{name}: unregistered test source {file.name}")
        packages[name] = dict(sorted(mapping.items()))

    return {"packages": packages}, errors


if __name__ == "__main__":
    report, failures = inspect_layout(Path(sys.argv[1]) if len(sys.argv) == 2 else Path(__file__).resolve().parents[1])
    print(json.dumps(report, sort_keys=True))
    if failures:
        print("\n".join(failures), file=sys.stderr)
        sys.exit(1)
