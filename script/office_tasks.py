#!/usr/bin/env python3
"""Local tasks delegating to existing YCoding owners. No implicit Git writes or publication."""
from __future__ import annotations
import argparse
import json
import os
from pathlib import Path
import platform
import re
import shutil
import subprocess
import tarfile
import tempfile
import sys
from office_release import digest, parse_checksums, verify_container, version

ERRORS = re.compile(r'SCRIPT ERROR|Parse Error|Compile Error')
TARGETS = {'darwin-universal': 'dmg', 'linux-x64': 'tar.gz', 'windows-x64': 'zip'}

def run(cmd: list[str], cwd: Path, env: dict | None = None, timeout: int = 900) -> None:
    print('+', ' '.join(cmd), flush=True)
    completed = subprocess.run(cmd, cwd=cwd, env=env, text=True, stdout=subprocess.PIPE,
                               stderr=subprocess.STDOUT, timeout=timeout)
    print(completed.stdout, end='')
    if completed.returncode or ERRORS.search(completed.stdout):
        raise ValueError('Command failed or Godot emitted script errors; see output above')

def repo_root(path: Path | None) -> Path:
    root = path.resolve() if path else Path(__file__).resolve().parent.parent
    if not (root / 'apps/office/project.godot').is_file() or not (root / 'package.json').is_file():
        raise ValueError('Expected the existing YCoding checkout with apps/office')
    return root

def godot_binary() -> str:
    requested = os.environ.get('GODOT_BIN')
    candidates = [requested] if requested else [shutil.which('godot'), shutil.which('godot4'), '/Applications/Godot.app/Contents/MacOS/Godot']
    for item in candidates:
        if item:
            path = shutil.which(item) or item
            if Path(path).is_file() and os.access(path, os.X_OK):
                return str(Path(path).resolve())
    raise ValueError('Set GODOT_BIN to the installed pinned standard Godot engine')

def environment(godot: str, temp: Path) -> dict:
    env = os.environ.copy(); env['GODOT_BIN'] = godot; env['TMPDIR'] = str(temp)
    return env

def verify(root: Path, godot: str) -> None:
    with tempfile.TemporaryDirectory(prefix='ycoding-office-check-') as temp:
        env = environment(godot, Path(temp))
        run(['sh', str(root / 'apps/office/tools/verify.sh')], root, env)
        run(['sh', str(root / 'apps/office/tools/verify-integration.sh')], root, env)
    print('Godot headless scene/loopback checks only; real-provider and UI acceptance are separate.')

def build(root: Path, v: str, target: str, outdir: Path, godot: str) -> None:
    version(v)
    source = root / 'apps/office'
    out = outdir.resolve()
    if out == root or source == out or source in out.parents or out.exists():
        raise ValueError('Use a fresh output directory outside apps/office')
    if target == 'darwin-universal' and platform.system() != 'Darwin':
        raise ValueError('DMG build requires macOS')
    # Don't follow source symlinks into credentials or unrelated files.
    ignored = {'.godot', '.git', 'node_modules', '__pycache__', 'dist'}
    for base, dirs, files in os.walk(source, followlinks=False):
        dirs[:] = [d for d in dirs if d not in ignored]
        for name in dirs + files:
            if (Path(base) / name).is_symlink():
                raise ValueError('Build staging refuses symlinks; audit the resource dependency explicitly')
    original = (source / 'project.godot').read_bytes()
    with tempfile.TemporaryDirectory(prefix='ycoding-office-build-') as temp:
        stage = Path(temp) / 'repo'; stage.mkdir()
        project = stage / 'apps/office'
        shutil.copytree(source, project, ignore=shutil.ignore_patterns(*ignored))
        env = environment(godot, Path(temp))
        run([godot, '--headless', '--path', str(project), '--editor', '--import'], stage, env)
        run(['sh', str(project / 'tools/verify.sh')], stage, env)
        run(['sh', str(project / 'tools/verify-integration.sh')], stage, env)
        out.parent.mkdir(parents=True, exist_ok=True)
        run(['sh', str(project / 'tools/build-release.sh'), '--version', v, '--target', target, '--outdir', str(out)], stage, env, 1800)
    if (source / 'project.godot').read_bytes() != original:
        raise ValueError('Original project changed concurrently; inspect before trusting this candidate')
    print(f'Candidate exported to {out}; native launch/provider/signing NOT verified by export.')

def install_local(artifact: Path, target: str, v: str) -> None:
    version(v)
    expected = f'ycoding-office-{v}-{target}.{TARGETS[target]}'
    if artifact.is_symlink() or artifact.name != expected or not artifact.is_file():
        raise ValueError('Artifact name/path does not match requested version and target')
    sums = artifact.parent / f'ycoding-office-{v}-checksums.txt'
    if not sums.exists():
        sums = artifact.parent / f'ycoding-{v}-checksums.txt'
    if sums.is_symlink() or parse_checksums(sums.read_text()).get(expected) != digest(artifact):
        raise ValueError('Artifact checksum verification failed')
    if target == 'darwin-universal':
        if platform.system() != 'Darwin':
            raise ValueError('macOS artifact requires macOS')
        verify_container(artifact, ())
        destination = Path.home() / 'Applications' / f'YCoding Office {v}.app'
        if destination.exists() or destination.is_symlink():
            raise ValueError('Destination exists; no automatic replacement')
        destination.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix='ycoding-office-mount-') as temp:
            mount = Path(temp) / 'mount'; mount.mkdir()
            run(['hdiutil', 'attach', '-readonly', '-nobrowse', '-mountpoint', str(mount), str(artifact.resolve())], Path(temp))
            try:
                app = mount / 'YCoding Office.app'
                if not app.is_dir() or app.is_symlink():
                    raise ValueError('DMG is missing the expected app bundle')
                staged = destination.parent / f'.ycoding-office-{v}-staging'
                if staged.exists():
                    raise ValueError('Stale staging directory exists; review it manually')
                try:
                    run(['ditto', str(app), str(staged)], Path(temp))
                    os.rename(staged, destination)
                finally:
                    if staged.exists():
                        shutil.rmtree(staged)
            finally:
                run(['hdiutil', 'detach', str(mount)], Path(temp))
    elif target == 'linux-x64':
        if platform.system() != 'Linux' or platform.machine().lower() not in ('x86_64', 'amd64'):
            raise ValueError('Linux x64 artifact requires a Linux x64 host')
        verify_container(artifact, ('ycoding-office', 'ycoding-office.pck'))
        destination = Path.home() / '.local/share/ycoding-office' / v
        if destination.exists() or destination.is_symlink():
            raise ValueError('Destination exists; no automatic replacement')
        destination.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix='.staging-', dir=destination.parent) as temp:
            stage = Path(temp) / 'payload'; stage.mkdir()
            with tarfile.open(artifact) as archive:
                for name in ('ycoding-office', 'ycoding-office.pck'):
                    # Exact files only; never extract arbitrary paths or links.
                    stream = archive.extractfile(name)
                    if stream is None:
                        raise ValueError('Missing payload')
                    with stream, (stage / name).open('wb') as output:
                        shutil.copyfileobj(stream, output)
            (stage / 'ycoding-office').chmod(0o755)
            os.rename(stage, destination)
    else:
        raise ValueError('Use reviewed script/install-office.ps1 for Windows release installation; local ZIP extraction is manual')
    print(f'Installed GUI only: {destination}. CLI/service and first-run compatibility must be verified separately.')

def main() -> None:
    p = argparse.ArgumentParser(description=__doc__); p.add_argument('--repo', type=Path)
    sub = p.add_subparsers(dest='command', required=True)
    sub.add_parser('doctor'); sub.add_parser('verify'); sub.add_parser('pages'); sub.add_parser('run')
    b = sub.add_parser('build'); b.add_argument('--version', required=True); b.add_argument('--target', choices=TARGETS, required=True); b.add_argument('--outdir', type=Path, required=True)
    i = sub.add_parser('install-release'); i.add_argument('--version', required=True); i.add_argument('--yes', action='store_true')
    l = sub.add_parser('install-local'); l.add_argument('--version', required=True); l.add_argument('--target', choices=TARGETS, required=True); l.add_argument('--artifact', type=Path, required=True); l.add_argument('--yes', action='store_true')
    args = p.parse_args(); root = repo_root(args.repo)
    if args.command == 'doctor':
        print(json.dumps({'repository': str(root), 'platform': platform.system(), 'architecture': platform.machine(),
                          'bun': shutil.which('bun'), 'git': shutil.which('git'), 'sh': shutil.which('sh'),
                          'godot': os.environ.get('GODOT_BIN') or shutil.which('godot'),
                          'office_project': str(root / 'apps/office/project.godot'),
                          'evidence': 'tool discovery only; no app/provider run'}, indent=2))
    elif args.command == 'run':
        # Native foreground launch for local audit/development; not a completion claim.
        subprocess.run([godot_binary(), '--path', str(root / 'apps/office')], cwd=root, check=True)
    elif args.command == 'verify':
        verify(root, godot_binary())
    elif args.command == 'build':
        build(root, args.version, args.target, args.outdir, godot_binary())
    elif args.command == 'pages':
        run(['bun', 'script/build-pages.ts', '--outdir', 'dist/pages'], root)
        run([sys.executable, 'script/office_release.py', 'website', '--outdir', 'dist/pages'], root)
    elif args.command == 'install-release':
        version(args.version)
        if not args.yes:
            print('Preview only: maintained script/install.sh --office, YCODING_VERSION=' + args.version + '; repeat with --yes to install.')
            return
        env = os.environ.copy(); env['YCODING_VERSION'] = args.version
        run(['sh', 'script/install.sh', '--office'], root, env)
    else:
        if not args.yes:
            print('Preview only: install GUI artifact into a fresh per-user versioned location; repeat with --yes.')
            return
        install_local(args.artifact, args.target, args.version)

if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        raise SystemExit(f'office-tasks: {error}')
