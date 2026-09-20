#!/usr/bin/env python3
"""Guarded local delivery integration. Preview is default; never stages or publishes."""
from __future__ import annotations
import argparse,hashlib,json,os,shutil,tempfile
from pathlib import Path

def blob(data:bytes)->str:return hashlib.sha1(f'blob {len(data)}\0'.encode()+data).hexdigest()
def replace_once(text,old,new):
 if text.count(old)!=1:raise ValueError('Expected unique workflow marker missing or changed; merge manually')
 return text.replace(old,new,1)
def transform_release(text:str)->str:
 text=replace_once(text,'  YCODING_CHANNEL: latest','  YCODING_CHANNEL: latest\n  REQUESTED_VERSION: ${{ inputs.version }}\n  SOURCE_REF_NAME: ${{ github.ref_name }}')
 text=text.replace('"${{ inputs.version }}"','"$REQUESTED_VERSION"').replace('"${{ github.ref_name }}"','"$SOURCE_REF_NAME"')
 text=replace_once(text,'      - name: Build the desktop client','''      - name: Verify Office before export
        run: python3 script/office_tasks.py verify

      - name: Build the desktop client''')
 text=replace_once(text,'apps/office/tools/build-release.sh --version "$RELEASE_VERSION" --target "${{ matrix.target }}" --outdir dist/office/release','python3 script/office_tasks.py build --version "$RELEASE_VERSION" --target "${{ matrix.target }}" --outdir dist/office/release')
 text=replace_once(text,'      - name: Upload prepared release assets','''      - name: Verify complete release artifact contract
        run: python3 script/office_release.py verify --directory release --version "$RELEASE_VERSION"

      - name: Upload prepared release assets''')
 text=replace_once(text,'      - name: Create GitHub release','      - name: Verify reviewed candidate before publication\n        run: python3 script/office_readiness.py --version \"$RELEASE_VERSION\"\n\n      - name: Create GitHub release')
 text=replace_once(text,'    name: publish release\n    needs: package','    name: publish release\n    environment: office-release\n    needs: package')
 old='          gh release create "v$version" release/* "docs/releases/v$version.md" --verify-tag --title "YCoding $version" --notes-file release-notes.md'
 new='''          # A prerelease must never replace the stable channel.
          flags=()
          base_version="${version%%+*}"
          if [[ "$base_version" == *-* ]]; then flags+=(--prerelease --latest=false); fi
          gh release create "v$version" release/* "docs/releases/v$version.md" --verify-tag --title "YCoding $version" --notes-file release-notes.md "${flags[@]}"'''
 text=replace_once(text,old,new)
 # Publication checks tested-source ancestry, so this checkout needs history.
 marker="\n  release:\n"
 if marker in text:
  before,tail=text.split(marker,1)
  tail=replace_once(tail,'          persist-credentials: false','          persist-credentials: false\n          fetch-depth: 0')
  text=before+marker+tail
 return text

def plans(kit:Path,repo:Path)->list[tuple[Path,bytes]]:
 if not (repo/'apps/office/project.godot').is_file():raise ValueError('Not the existing YCoding checkout')
 baseline=json.loads((kit/'integration/BASELINE.json').read_text())
 existing=baseline.get('existing_files',baseline.get('files',[])); expected={x['path']:x['git_blob_sha1'] for x in existing}
 results=[]
 for rel in ('.github/workflows/release.yml','.github/workflows/pages.yml','apps/office/tools/verify-integration.sh'):
  p=repo/rel
  if p.is_symlink() or any(x.is_symlink() for x in p.parents):raise ValueError('Refusing symlink path '+rel)
  data=p.read_bytes()
  if blob(data)!=expected[rel]:raise ValueError('Baseline drift for '+rel+'; review and merge manually, no force mode')
  replacement=transform_release(data.decode()).encode() if rel.endswith('release.yml') else (kit/'integration/replacements'/rel).read_bytes()
  results.append((p,replacement))
 for p in sorted((kit/'integration/additions').rglob('*')):
  if not p.is_file():continue
  rel=p.relative_to(kit/'integration/additions'); dest=repo/rel
  if dest.exists() or dest.is_symlink() or any(a.is_symlink() for a in dest.parents):raise ValueError('Addition destination already exists/unsafe: '+str(rel))
  results.append((dest,p.read_bytes()))
 return results

def apply(kit:Path,repo:Path,write:bool=False)->Path|None:
 repo=repo.resolve(); operations=plans(kit,repo)
 for p,_ in operations:print(('replace ' if p.exists() else 'add     ')+str(p.relative_to(repo)))
 if not write:print('Preview only. No target file changed.');return None
 backup=Path(tempfile.mkdtemp(prefix='ycoding-delivery-backup-')); originals={}; modes={}; changed=[]
 # Capture original bytes before any write. No content is printed.
 expected={x['path']:x['git_blob_sha1'] for x in json.loads((kit/'integration/BASELINE.json').read_text())['existing_files']}
 for p,_ in operations:
  rel=str(p.relative_to(repo))
  if rel in expected and blob(p.read_bytes())!=expected[rel]:raise ValueError('Concurrent edit since preview; stop')
  originals[p]=p.read_bytes() if p.exists() else None;modes[p]=p.stat().st_mode&0o777 if p.exists() else 0o644
  if originals[p] is not None:
   b=backup/p.relative_to(repo);b.parent.mkdir(parents=True,exist_ok=True);b.write_bytes(originals[p])
 try:
  for p,data in operations:
   # Optimistic concurrency check immediately before each write.
   if (p.read_bytes() if p.exists() else None)!=originals[p]:raise ValueError('Concurrent edit; stop and inspect backup')
   p.parent.mkdir(parents=True,exist_ok=True)
   fd,tmp=tempfile.mkstemp(prefix='.office-integration-',dir=p.parent)
   with os.fdopen(fd,'wb') as f:f.write(data)
   os.chmod(tmp,modes[p]);os.replace(tmp,p);changed.append(p)
 except Exception:
  for p in reversed(changed):
   data=dict(operations)[p]
   if p.read_bytes()!=data:continue # Never overwrite a new concurrent edit during rollback.
   if originals[p] is None:p.unlink()
   else:p.write_bytes(originals[p]);p.chmod(modes[p])
  raise
 print('Applied local delivery changes. Backup: '+str(backup)+'. Review diff; no Git action or publication performed.')
 return backup
if __name__=='__main__':
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('--repo',type=Path,required=True);p.add_argument('--apply',action='store_true');p.add_argument('--kit',type=Path,default=Path(__file__).resolve().parent.parent);a=p.parse_args()
 try:apply(a.kit,a.repo,a.apply)
 except (OSError,ValueError,KeyError) as e:raise SystemExit(str(e))
