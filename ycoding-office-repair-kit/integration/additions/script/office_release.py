#!/usr/bin/env python3
"""YCoding release contract + additive Pages builder. No provider/agent execution."""
from __future__ import annotations
import argparse
import hashlib
import html
import json
import os
from pathlib import Path
import re
import stat
import tarfile
from urllib.parse import unquote, urlparse
from urllib.request import Request, urlopen
import zipfile

VERSION = re.compile(r"(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?\Z")
REPOSITORY = re.compile(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+\Z")

def version(value: str) -> str:
    if not VERSION.fullmatch(value):
        raise ValueError("Version must be a release version without the leading v")
    # SemVer numeric prerelease identifiers cannot contain leading zeroes.
    suffix = value.split('+', 1)[0].partition('-')[2]
    if any(x.isdigit() and len(x) > 1 and x.startswith('0') for x in suffix.split('.')):
        raise ValueError('Invalid numeric prerelease identifier')
    return value

def assets(v: str) -> dict[str, tuple[str, ...]]:
    version(v)
    return {
        f'ycoding-{v}-darwin-arm64.tar.gz': ('ycoding', 'ycoding-computer-helper'),
        f'ycoding-{v}-darwin-x64.tar.gz': ('ycoding', 'ycoding-computer-helper'),
        f'ycoding-{v}-linux-x64.tar.gz': ('ycoding',),
        f'ycoding-{v}-windows-x64.zip': ('ycoding.exe',),
        f'ycoding-office-{v}-darwin-universal.dmg': (),
        f'ycoding-office-{v}-linux-x64.tar.gz': ('ycoding-office', 'ycoding-office.pck'),
        f'ycoding-office-{v}-windows-x64.zip': ('ycoding-office.exe', 'ycoding-office.pck'),
    }

def digest(path: Path) -> str:
    result = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            result.update(block)
    return result.hexdigest()

def parse_checksums(text: str) -> dict[str, str]:
    result = {}
    for line in text.splitlines():
        if not line.strip():
            continue
        m = re.fullmatch(r'([0-9a-fA-F]{64}) [ *]([A-Za-z0-9._+-]+)', line)
        if not m or m[2] in result:
            raise ValueError('Malformed or duplicate checksum entry')
        result[m[2]] = m[1].lower()
    if not result:
        raise ValueError('Empty checksum manifest')
    return result

def verify_container(path: Path, expected: tuple[str, ...]) -> None:
    if path.name.endswith('.dmg'):
        # UDIF images produced by hdiutil end with a 512-byte trailer.
        with path.open('rb') as stream:
            if path.stat().st_size < 512:
                raise ValueError('Truncated DMG')
            stream.seek(-512, 2)
            if stream.read(4) != b'koly':
                raise ValueError('DMG has no UDIF trailer')
        return  # This is NOT native mount, signature, app-version or launch verification.
    if path.name.endswith('.tar.gz'):
        with tarfile.open(path, 'r:gz') as archive:
            entries = archive.getmembers()
            if len(entries) != len(expected) or {e.name for e in entries} != set(expected):
                raise ValueError(f'Unexpected archive layout: {path.name}')
            for entry in entries:
                if not entry.isfile() or entry.size <= 0:
                    raise ValueError('Archive contains a link, directory or empty payload')
                if not entry.name.endswith('.pck') and not entry.mode & 0o111:
                    raise ValueError('Binary has no executable mode')
    elif path.name.endswith('.zip'):
        with zipfile.ZipFile(path) as archive:
            entries = archive.infolist()
            if len(entries) != len(expected) or {e.filename for e in entries} != set(expected):
                raise ValueError(f'Unexpected ZIP layout: {path.name}')
            for entry in entries:
                if entry.is_dir() or entry.file_size <= 0 or stat.S_ISLNK(entry.external_attr >> 16):
                    raise ValueError('ZIP contains invalid payload')
            if archive.testzip() is not None:
                raise ValueError('ZIP CRC failure')
    else:
        raise ValueError('Unsupported release container')

def verify_directory(directory: Path, v: str) -> dict:
    expected = assets(v)
    sums = directory / f'ycoding-{v}-checksums.txt'
    if sums.is_symlink():
        raise ValueError('Refusing symlinked checksum manifest')
    checks = parse_checksums(sums.read_text())
    if set(checks) != set(expected):
        raise ValueError('Checksum entries must exactly match all seven CLI/Office archives')
    result = []
    for name, contents in expected.items():
        path = directory / name
        if path.is_symlink() or not path.is_file() or path.stat().st_size == 0:
            raise ValueError(f'Missing or unsafe asset: {name}')
        actual = digest(path)
        if checks[name] != actual:
            raise ValueError(f'Checksum mismatch: {name}')
        verify_container(path, contents)
        result.append({'name': name, 'sha256': actual, 'bytes': path.stat().st_size})
    return {'version': v, 'assets': result, 'scope': 'integrity and archive layout only; native execution/signing/provider evidence is separate'}

def select_release(releases: list[dict], repo: str) -> dict | None:
    if not REPOSITORY.fullmatch(repo):
        raise ValueError('Invalid GitHub repository')
    eligible = []
    for release in releases:
        tag = release.get('tag_name', '')
        if release.get('draft') or release.get('prerelease') or not isinstance(tag, str) or not tag.startswith('v'):
            continue
        try:
            v = version(tag[1:])
        except ValueError:
            continue
        if '-' in v.split('+', 1)[0]:
            continue
        needed = set(assets(v)) | {f'ycoding-{v}-checksums.txt'}
        payloads = release.get('assets', [])
        if not isinstance(payloads, list):
            continue
        selected = {}
        valid = True
        for item in payloads:
            name = item.get('name')
            if name not in needed:
                continue
            expected_url = f'https://github.com/{repo}/releases/download/{tag}/{name}'
            if (name in selected or item.get('state') != 'uploaded' or not isinstance(item.get('size'), int)
                    or item['size'] <= 0 or unquote(item.get('browser_download_url', '')) != expected_url):
                valid = False
                break
            selected[name] = item['browser_download_url']
        if valid and set(selected) == needed:
            eligible.append((tuple(int(p) for p in v.split('+', 1)[0].split('.')), release.get('published_at', ''),
                             {'version': v, 'tag': tag, 'assets': selected, 'url': f'https://github.com/{repo}/releases/tag/{tag}'}))
    return max(eligible, key=lambda item: (item[0], item[1]))[2] if eligible else None

def fetch_releases(repo: str) -> list[dict]:
    if not REPOSITORY.fullmatch(repo):
        raise ValueError('Invalid repository')
    headers = {'Accept': 'application/vnd.github+json', 'User-Agent': 'ycoding-office-pages'}
    token = os.environ.get('GH_TOKEN')
    if token:
        headers['Authorization'] = f'Bearer {token}'
    result = []
    for page in range(1, 11):
        request = Request(f'https://api.github.com/repos/{repo}/releases?per_page=100&page={page}', headers=headers)
        with urlopen(request, timeout=30) as response:
            block = json.load(response)
        if not isinstance(block, list):
            raise ValueError('Unexpected GitHub release response')
        result.extend(block)
        if len(block) < 100:
            return result
    raise ValueError('Release pagination exceeds 1000 records; refine explicit selection rather than guessing')

def office_html(selected: dict | None, repo: str) -> str:
    esc = html.escape
    if selected:
        v = selected['version']
        rows = []
        for target, ext, label in [('darwin-universal', 'dmg', 'macOS · Apple Silicon / Intel'),
                                   ('linux-x64', 'tar.gz', 'Linux · x64'), ('windows-x64', 'zip', 'Windows · x64')]:
            name = f'ycoding-office-{v}-{target}.{ext}'
            rows.append(f'<li><a href="{esc(selected["assets"][name], quote=True)}">{label}</a></li>')
        body = f'''<p class="badge">Latest complete stable Office release · {esc(v)}</p>
<h1>Your coding agents, in an office.</h1><p>A native Godot client for your local YCoding service.</p>
<ul class="downloads">{''.join(rows)}</ul>
<p><a href="{esc(selected['url'], quote=True)}">Release notes and CLI downloads</a> · <a href="{esc(selected['assets'][f'ycoding-{v}-checksums.txt'], quote=True)}">SHA-256 checksums</a></p>
<h2>Install CLI + Office</h2><p>On macOS/Linux, download and review the maintained installer first:</p>
<pre>curl -fL https://althenia.github.io/ycoding/install.sh -o install-ycoding.sh
# Review the script before executing it.
YCODING_VERSION={esc(v)} sh install-ycoding.sh --office</pre>
<p>Windows: download and review <a href="install-office.ps1">the PowerShell installer</a>, then run:</p>
<pre>powershell -File install-office.ps1 -Version {esc(v)} -Yes -DesktopShortcut</pre>
<p>Native signature, notarization and system compatibility status are documented in the release notes; checksums alone do not establish those properties. Do not disable OS security checks.</p>'''
    else:
        body = '<p class="badge">Office downloads not yet available</p><h1>YCoding Office</h1><p>No complete stable CLI + Office release is currently published. No download links have been fabricated.</p>'
    return f'''<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>YCoding Office downloads</title>
<style>:root{{color-scheme:dark light}}body{{font:16px/1.6 system-ui,sans-serif;margin:0;background:#181a21;color:#e8ebf2}}main{{max-width:960px;margin:0 auto;padding:48px 24px}}a{{color:#96c4ff}}h1{{font-size:40px;line-height:1.15}}.badge{{color:#9ad9b2}}.downloads{{display:flex;gap:16px;flex-wrap:wrap;list-style:none;padding:0}}.downloads a{{display:block;background:#2e3442;padding:18px 24px;border-radius:12px}}pre{{padding:20px;background:#252a35;overflow:auto;border-radius:12px}}footer{{margin-top:40px;color:#bbc1ce}}@media(prefers-color-scheme:light){{body{{background:#f6f7fa;color:#202636}}a{{color:#205ba5}}.badge{{color:#28633a}}pre,.downloads a{{background:#e5e9f1}}}}</style></head><body><main><nav><a href="../">YCoding documentation</a></nav>{body}<footer><p>The website hosts documentation and downloads only. It does not execute agents, connect to your local service, or collect provider credentials.</p></footer></main></body></html>'''

def build_website(outdir: Path, repo: str, releases: list[dict]) -> None:
    # Only extend the existing Pages artifact, never recursively delete any path.
    if outdir.is_symlink() or not (outdir / 'index.html').is_file():
        raise ValueError('Build the existing Pages artifact first')
    target = outdir / 'office'
    if target.is_symlink():
        raise ValueError('Refusing symlinked Office page')
    target.mkdir(exist_ok=True)
    selected = select_release(releases, repo)
    (target / 'index.html').write_text(office_html(selected, repo))
    (target / 'downloads.json').write_text(json.dumps({'repository': repo, 'release': selected}, indent=2) + '\n')
    installer = Path(__file__).resolve().with_name('install-office.ps1')
    if not installer.is_file():
        raise ValueError('Windows installer is missing from script/')
    (target / 'install-office.ps1').write_bytes(installer.read_bytes())
    index = outdir / 'index.html'
    content = index.read_text()
    if 'href="office/"' not in content:
        if '</main>' not in content:
            raise ValueError('Existing Pages index changed; merge download navigation explicitly')
        content = content.replace('</main>', '<p><a href="office/">YCoding Office downloads</a></p></main>', 1)
        index.write_text(content)

def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    v = sub.add_parser('verify'); v.add_argument('--directory', type=Path, required=True); v.add_argument('--version', required=True)
    w = sub.add_parser('website'); w.add_argument('--outdir', type=Path, required=True); w.add_argument('--repo', default=os.environ.get('GH_REPO', 'Althenia/ycoding'))
    args = parser.parse_args()
    if args.command == 'verify':
        print(json.dumps(verify_directory(args.directory, version(args.version)), indent=2))
    else:
        build_website(args.outdir, args.repo, fetch_releases(args.repo))
        print('Office download page built from actual GitHub release metadata')

if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError, tarfile.TarError, zipfile.BadZipFile) as error:
        raise SystemExit(f'office-release: {error}')
