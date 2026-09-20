#!/usr/bin/env python3
"""Install the repository-pinned Godot editor/templates into explicit local paths."""
from __future__ import annotations
import argparse,hashlib,json,os,platform,shutil,stat,subprocess,tempfile,zipfile
from pathlib import Path
from urllib.request import urlopen
VERSION='4.7.2'
BASE=f'https://github.com/godotengine/godot-builds/releases/download/{VERSION}-stable'
FILES={
 'Linux':('Godot_v4.7.2-stable_linux.x86_64.zip','9aa00f7a605200940bce3027a567b782f49bd8e940dd06ae9e987bd65aee1b1467edd56ed84fcdcbdd44354bf613bdbb4e5d2913e925850368e150c59ed54c65'),
 'Darwin':('Godot_v4.7.2-stable_macos.universal.zip','38aa16e5bba2083941fc5b3e54be0089bd4cc35e32415f5b9fd9a8a6a7b9818255d44532ea8ef94b5aef56c4b407c2d634fa4f657e4ebe681ebbf59b7bac69ca'),
 'templates':('Godot_v4.7.2-stable_export_templates.tpz','ca4d71c4d7b81dfc15d1a98baa07534aa95b03fdda78a0075b06672e1648d2e5f40980c9adc28d23e1b92e732ee7bf3461997aa804af74ec2fcd7a93ccb84079')}
def download_verified(name:str,checksum:str,dest:Path)->None:
 h=hashlib.sha512();total=0
 with urlopen(f'{BASE}/{name}',timeout=60) as response, dest.open('xb') as output:
  if not response.url.startswith('https://'):raise ValueError('Refusing non-HTTPS redirect')
  while block:=response.read(1024*1024):
   total+=len(block)
   if total>2*1024**3:raise ValueError('Download exceeds bounded size')
   h.update(block);output.write(block)
 if h.hexdigest()!=checksum:raise ValueError('Publisher checksum mismatch: '+name)
def extract_checked(archive:Path,dest:Path)->None:
 with zipfile.ZipFile(archive) as z:
  for e in z.infolist():
   rel=Path(e.filename);target=(dest/rel).resolve()
   if rel.is_absolute() or '..' in rel.parts or dest.resolve() not in target.parents or stat.S_ISLNK(e.external_attr>>16):raise ValueError('Unsafe ZIP path/link')
   if e.is_dir():target.mkdir(parents=True,exist_ok=True);continue
   target.parent.mkdir(parents=True,exist_ok=True)
   with z.open(e) as src,target.open('xb') as out:shutil.copyfileobj(src,out)
   mode=(e.external_attr>>16)&0o777
   if mode:target.chmod(mode)
def install(directory:Path,github:bool=False)->Path:
 host=platform.system()
 if host not in ('Linux','Darwin') or (host=='Linux' and platform.machine().lower() not in ('amd64','x86_64')):raise ValueError('Automated setup supports macOS and Linux x64; install pinned editor/templates manually on Windows')
 root=directory.absolute()
 if root.exists() or root.is_symlink() or any(p.is_symlink() for p in root.parents):raise ValueError('Use a fresh, non-symlink install directory')
 system=(Path.home()/'Library/Application Support/Godot/export_templates' if host=='Darwin' else Path(os.environ.get('XDG_DATA_HOME',str(Path.home()/'.local/share')))/'godot/export_templates')/f'{VERSION}.stable'
 # Never silently replace an existing local engine template installation.
 if system.exists() or system.is_symlink():raise ValueError('Matching template directory already exists; reuse local editor/templates or review/remove it explicitly')
 root.mkdir(parents=True)
 for kind in (host,'templates'):
  name,checksum=FILES[kind]; archive=root/name;download_verified(name,checksum,archive)
  extract_checked(archive,root/('editor' if kind==host else 'template-unpack'))
 source=root/'template-unpack/templates'
 if not source.is_dir():raise ValueError('Missing templates directory')
 system.parent.mkdir(parents=True,exist_ok=True);shutil.copytree(source,system)
 binary=root/'editor/Godot.app/Contents/MacOS/Godot' if host=='Darwin' else root/'editor/Godot_v4.7.2-stable_linux.x86_64'
 binary.chmod(binary.stat().st_mode|0o111)
 result=subprocess.run([str(binary),'--version'],check=True,capture_output=True,text=True,timeout=30).stdout.strip()
 if not result.startswith(VERSION+'.stable'):raise ValueError('Downloaded editor reports unexpected version')
 (root/'installation.json').write_text(json.dumps({'version':result,'godot':str(binary),'templates':str(system)},indent=2)+'\n')
 if github:
  env=Path(os.environ['GITHUB_ENV'])
  if '\n' in str(binary):raise ValueError('Invalid engine path')
  with env.open('a') as f:f.write('GODOT_BIN='+str(binary)+'\n')
 print('Pinned editor ready:',binary);return binary
if __name__=='__main__':
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('--directory',type=Path,required=True);p.add_argument('--github',action='store_true');a=p.parse_args()
 try:install(a.directory,a.github)
 except (OSError,ValueError,KeyError,subprocess.SubprocessError,zipfile.BadZipFile) as e:raise SystemExit(f'godot-setup: {e}')
