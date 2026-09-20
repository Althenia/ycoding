"""Utility tests only. Synthetic archives and records are not native release evidence."""
import hashlib,io,json,os,stat,sys,tarfile,tempfile,unittest,zipfile
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import office_release as release
import office_readiness as readiness
import setup_office_godot as setup

def tar(path,names):
 with tarfile.open(path,'w:gz') as archive:
  for name in names:
   entry=tarfile.TarInfo(name);entry.size=7;entry.mode=0o755;archive.addfile(entry,io.BytesIO(b'payload'))
def zip_payload(path,names):
 with zipfile.ZipFile(path,'w') as archive:
  for name in names:archive.writestr(name,b'payload')
def release_record(v='1.2.3'):
 tag='v'+v;repo='Althenia/ycoding'
 return {'tag_name':tag,'draft':False,'prerelease':False,'published_at':'2026-09-16T00:00:00Z','assets':[{'name':name,'state':'uploaded','size':20,'browser_download_url':f'https://github.com/{repo}/releases/download/{tag}/{name}'} for name in list(release.assets(v))+[f'ycoding-{v}-checksums.txt']]}
class DeliveryTests(unittest.TestCase):
 def test_version_valid(self):
  for v in ['0.0.0','1.2.3','1.2.3-rc.1','1.2.3+build.9']:self.assertEqual(release.version(v),v)
 def test_version_invalid(self):
  for v in ['v1.2.3','01.2.3','1.2','1.2.3-01','1.2.3;echo bad','../bad']:
   with self.assertRaises(ValueError):release.version(v)
 def test_seven_assets(self):self.assertEqual(len(release.assets('1.2.3')),7)
 def test_checksum_parse(self):self.assertEqual(release.parse_checksums('a'*64+'  file.zip\n'),{'file.zip':'a'*64})
 def test_duplicate_checksum(self):
  with self.assertRaises(ValueError):release.parse_checksums(('a'*64+'  file.zip\n')*2)
 def test_unsafe_checksum_name(self):
  with self.assertRaises(ValueError):release.parse_checksums('a'*64+'  ../file.zip')
 def test_tar_layout(self):
  with tempfile.TemporaryDirectory() as t:
   p=Path(t)/'payload.tar.gz';tar(p,['ycoding','ycoding-computer-helper']);release.verify_container(p,('ycoding','ycoding-computer-helper'))
 def test_tar_extra(self):
  with tempfile.TemporaryDirectory() as t:
   p=Path(t)/'payload.tar.gz';tar(p,['ycoding','extra'])
   with self.assertRaises(ValueError):release.verify_container(p,('ycoding',))
 def test_tar_symlink_rejected(self):
  with tempfile.TemporaryDirectory() as t:
   p=Path(t)/'payload.tar.gz'
   with tarfile.open(p,'w:gz') as z:
    e=tarfile.TarInfo('ycoding');e.type=tarfile.SYMTYPE;e.linkname='/tmp/elsewhere';z.addfile(e)
   with self.assertRaises(ValueError):release.verify_container(p,('ycoding',))
 def test_zip_layout(self):
  with tempfile.TemporaryDirectory() as t:
   p=Path(t)/'payload.zip';zip_payload(p,['ycoding-office.exe','ycoding-office.pck']);release.verify_container(p,('ycoding-office.exe','ycoding-office.pck'))
 def test_zip_traversal(self):
  with tempfile.TemporaryDirectory() as t:
   p=Path(t)/'payload.zip';zip_payload(p,['../evil'])
   with self.assertRaises(ValueError):release.verify_container(p,('ycoding.exe',))
 def test_dmg_truncated(self):
  with tempfile.TemporaryDirectory() as t:
   p=Path(t)/'app.dmg';p.write_bytes(b'no')
   with self.assertRaises(ValueError):release.verify_container(p,())
 def test_complete_directory(self):
  # DMG trailer fixture tests integrity detection only, not actual mount/signature.
  with tempfile.TemporaryDirectory() as t:
   root=Path(t); lines=[]
   for name,entries in release.assets('1.2.3').items():
    p=root/name
    if name.endswith('.tar.gz'):tar(p,entries)
    elif name.endswith('.zip'):zip_payload(p,entries)
    else:p.write_bytes(b'fixture'+b'koly'+bytes(508))
    lines.append(release.digest(p)+'  '+name)
   (root/'ycoding-1.2.3-checksums.txt').write_text('\n'.join(lines))
   self.assertEqual(len(release.verify_directory(root,'1.2.3')['assets']),7)
 def test_select_complete(self):self.assertEqual(release.select_release([release_record()],'Althenia/ycoding')['version'],'1.2.3')
 def test_select_missing(self):
  r=release_record();r['assets'].pop();self.assertIsNone(release.select_release([r],'Althenia/ycoding'))
 def test_select_prerelease(self):
  r=release_record('2.0.0-rc.1');self.assertIsNone(release.select_release([r],'Althenia/ycoding'))
 def test_select_highest_stable(self):self.assertEqual(release.select_release([release_record('1.9.0'),release_record('1.10.0')],'Althenia/ycoding')['version'],'1.10.0')
 def test_select_bad_url(self):
  r=release_record();r['assets'][0]['browser_download_url']='https://malicious.invalid/file';self.assertIsNone(release.select_release([r],'Althenia/ycoding'))
 def test_empty_download_page(self):
  html=release.office_html(None,'Althenia/ycoding');self.assertIn('not yet available',html);self.assertNotIn('releases/download',html)
 def test_site_preserves_docs(self):
  with tempfile.TemporaryDirectory() as t:
   p=Path(t);(p/'index.html').write_text('<main>original docs</main>');(p/'keep.txt').write_text('keep')
   release.build_website(p,'Althenia/ycoding',[release_record()]);self.assertEqual((p/'keep.txt').read_text(),'keep');self.assertIn('original docs',(p/'index.html').read_text());self.assertTrue((p/'office/install-office.ps1').is_file())

 def test_windows_installer_contract(self):
  """R9-06. The PowerShell installer cannot be EXECUTED off Windows and no CI leg
  runs it, so its acceptance clauses are pinned against the real script text.
  Each assertion names a clause of the acceptance: PowerShell checksum/allowlist/
  versioned per-user directory and optional shortcut; never require global bypass."""
  root=Path(__file__).resolve().parents[2]
  ps1=(root/'script/install-office.ps1').read_text()
  # Versioned PER-USER directory, not a machine-wide install.
  self.assertIn('$env:LOCALAPPDATA', ps1)
  self.assertIn('YCoding\\versions\\$Version', ps1)
  self.assertIn("requires Windows x64", ps1)
  # CHECKSUM verification before anything is written, over TLS.
  self.assertIn('Get-FileHash', ps1)
  self.assertIn('SHA256', ps1)
  self.assertIn('Checksum mismatch', ps1)
  self.assertIn('Tls12', ps1)
  # ALLOWLIST: each archive's member set is fixed and an unexpected entry is refused.
  self.assertIn('Unexpected archive entry count', ps1)
  self.assertIn('Unsafe or duplicate archive entry', ps1)
  self.assertIn("'ycoding-office.exe'", ps1)
  self.assertIn("'ycoding-office.pck'", ps1)
  # OPTIONAL shortcut: off by default, guarded, and removed if the install fails.
  self.assertIn('[switch]$DesktopShortcut', ps1)
  self.assertIn('$ShortcutCreated', ps1)
  self.assertIn('Remove-Item -LiteralPath $Shortcut -Force', ps1)
  # NEVER requires disabling OS protections, and says so.
  for forbidden in ['Set-ExecutionPolicy','-ExecutionPolicy Bypass','Unblock-File','MpPreference','Add-MpPreference','DisableRealtimeMonitoring']:
   self.assertNotIn(forbidden, ps1, forbidden+' must never appear in the installer')
  self.assertIn('do not disable OS protections', ps1)
  # Preview by default: it writes nothing without an explicit -Yes.
  self.assertIn('if (-not $Yes)', ps1)
  self.assertIn('-Yes to write files', ps1)
  # It never overwrites an already installed version, and never edits PATH.
  self.assertIn('never overwrites an installed version', ps1)
  self.assertNotIn('setx PATH', ps1)
  self.assertNotIn('[Environment]::SetEnvironmentVariable', ps1)
 def test_windows_installer_is_published_with_the_site(self):
  """The installer must actually REACH users. It is distributed on the Pages site
  rather than as a release asset, and pages.yml is what runs that builder (and this
  suite), so both halves are asserted here."""
  root=Path(__file__).resolve().parents[2]
  pages=(root/'.github/workflows/pages.yml').read_text()
  self.assertIn('office_release.py website', pages, 'the site builder must run in CI')
  self.assertIn('office_tests', pages, 'this suite must run in CI, or it guards nothing')
  # And the builder really writes the installer into the published tree.
  # `build_website` only EXTENDS an existing Pages artifact, so the test must
  # provide one first rather than expecting it to be created from nothing.
  with tempfile.TemporaryDirectory() as t:
   p=Path(t);(p/'index.html').write_text('<main>docs</main>')
   release.build_website(p,'Althenia/ycoding',[release_record()])
   self.assertTrue((p/'office'/'install-office.ps1').is_file(),
                   'the published site must carry the installer')
   html=(p/'office'/'index.html').read_text()
   self.assertIn('install-office.ps1', html, 'and the page must link it')
   self.assertIn('-DesktopShortcut', html, 'with the documented invocation')
 def test_setup_pins(self):
  for name,s in setup.FILES.values():self.assertEqual(len(s),128);self.assertTrue(all(c in '0123456789abcdef' for c in s))
 def test_setup_zip_safety(self):
  with tempfile.TemporaryDirectory() as t:
   p=Path(t)/'a.zip';zip_payload(p,['../outside'])
   with self.assertRaises(ValueError):setup.extract_checked(p,Path(t)/'extract')
 def test_readiness_refuses_empty(self):
  with self.assertRaises(ValueError):readiness.validate({},'1.2.3')
 def test_readiness_stable_requires_signature(self):
  data={'version':'1.2.3','tested_commit':'a'*40,'user_approved':True,'signing':'unsigned','checks':{k:{'result':'pass','synthetic':False,'evidence':['synthetic-test-only'],'reviewed_by':'unit-test','reviewed_at':'test'} for k in readiness.REQUIRED}}
  with self.assertRaises(ValueError):readiness.validate(data,'1.2.3')
 def test_readiness_requires_every_flow(self):
  data={'version':'1.2.3','tested_commit':'a'*40,'user_approved':True,'signing':'verified','checks':{}}
  with self.assertRaises(ValueError):readiness.validate(data,'1.2.3')
if __name__=='__main__':unittest.main()
