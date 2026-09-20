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
