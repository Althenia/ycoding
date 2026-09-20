import contextlib,io,json,os,sys,tempfile,unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parent))
import settings_coverage as settings
import check_layout_capture as layout
import merge_delivery as merge
import verify_pack
import local_audit
ROOT=Path(__file__).resolve().parent.parent
class PackTests(unittest.TestCase):
 def test_schema_nested_record(self):
  s={'type':'object','properties':{'providers':{'type':'object','additionalProperties':{'properties':{'name':{'type':'string'}}}}}}
  self.assertEqual(settings.schema_paths(s),{'providers.*.name'})
 def test_schema_ref_array(self):
  s={'properties':{'items':{'type':'array','items':{'$ref':'#/$defs/Item'}}},'$defs':{'Item':{'properties':{'id':{'type':'string'}}}}}
  self.assertEqual(settings.schema_paths(s),{'items[].id'})
 def test_schema_external_ref(self):
  with self.assertRaises(ValueError):settings.schema_paths({'$ref':'https://example.invalid/schema'})
 def test_settings_missing(self):
  r=settings.check({'properties':{'new':{'type':'boolean'}}},{'settings':[]},'runtime');self.assertFalse(r['pass'])
 def test_coverage_not_implementation(self):
  cat={'settings':[{'domain':'runtime','path':'foo','status':'pending_local_verification'}]};schema={'properties':{'foo':{'type':'boolean'}}}
  self.assertTrue(settings.check(schema,cat,'runtime')['pass']);self.assertFalse(settings.check(schema,cat,'runtime',True)['pass'])
 def test_settings_patterns(self):self.assertTrue(settings.covers('providers.*.body.*','providers.*.body.*'))
 def test_layout_rejects_expected_geometry(self):self.assertTrue(layout.check({'source':'synthetic'}))
 def test_layout_default(self):
  # Only tests checker behavior; not a live capture/evidence record.
  d={'source':'native_control_capture','revision':'test-fixture','captured_at':'test','rects':{'window':[0,0,1280,720],'sidebar':[0,0,264,720],'office':[264,0,1016,720],'composer':[352,584,840,112]}}
  self.assertEqual(layout.check(d),[])
 def test_layout_wrong_sidebar(self):
  d={'source':'native_control_capture','revision':'test','captured_at':'test','rects':{'window':[0,0,1280,720],'sidebar':[10,0,700,720],'office':[264,0,1016,720],'composer':[352,584,840,112]}}
  self.assertTrue(layout.check(d))
 def test_replace_unique(self):self.assertEqual(merge.replace_once('abc','b','x'),'axc')
 def test_replace_refuses_ambiguity(self):
  with self.assertRaises(ValueError):merge.replace_once('bbb','b','x')
 def test_blob(self):self.assertEqual(merge.blob(b''),'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391')
 def test_merger_refuses_drift(self):
  with tempfile.TemporaryDirectory() as t:
   r=Path(t);(r/'apps/office').mkdir(parents=True);(r/'apps/office/project.godot').write_text('test');(r/'.github/workflows').mkdir(parents=True);(r/'.github/workflows/release.yml').write_text('changed')
   with self.assertRaises(ValueError):merge.plans(ROOT,r)
   self.assertEqual((r/'.github/workflows/release.yml').read_text(),'changed')
 def test_audit_rejects_output_inside_repo(self):
  with tempfile.TemporaryDirectory() as t:
   r=Path(t);(r/'apps/office').mkdir(parents=True);(r/'apps/office/project.godot').write_text('test')
   with self.assertRaises(ValueError):local_audit.audit(r,r/'audit')
 def test_pack_integrity(self):self.assertEqual(verify_pack.verify(ROOT),[])

class MergeHappyPathTests(unittest.TestCase):
 def source(self):
  # Minimal synthetic workflow containing the exact inspected edit markers.
  # This verifies transformation mechanics, not a real GitHub workflow run.
  return '''name: release
env:
  YCODING_CHANNEL: latest
jobs:
  office:
    steps:
      - name: Resolve
        run: version="${{ inputs.version }}"
      - name: Build the desktop client
        run: apps/office/tools/build-release.sh --version "$RELEASE_VERSION" --target "${{ matrix.target }}" --outdir dist/office/release
      - name: Upload prepared release assets
        run: echo candidate
  release:
    name: publish release
    needs: package
    steps:
      - name: Checkout
        with:
          persist-credentials: false
      - name: Create GitHub release
        run: |
          gh release create "v$version" release/* "docs/releases/v$version.md" --verify-tag --title "YCoding $version" --notes-file release-notes.md
'''
 def test_workflow_transformation(self):
  text=merge.transform_release(self.source())
  self.assertIn('office_readiness.py',text);self.assertIn('environment: office-release',text)
  self.assertIn('fetch-depth: 0',text);self.assertIn('office_tasks.py build',text)
  self.assertIn('--prerelease --latest=false',text);self.assertNotIn('version="${{ inputs.version }}"',text)
 def test_merger_preview_then_apply(self):
  with tempfile.TemporaryDirectory() as t:
   base=Path(t);kit=base/'kit';repo=base/'repo';(repo/'apps/office').mkdir(parents=True);(repo/'apps/office/project.godot').write_text('test fixture')
   docs={'.github/workflows/release.yml':self.source(),'.github/workflows/pages.yml':'old-pages','apps/office/tools/verify-integration.sh':'old-check'}
   hashes=[]
   for rel,text in docs.items():
    p=repo/rel;p.parent.mkdir(parents=True,exist_ok=True);p.write_text(text);hashes.append({'path':rel,'git_blob_sha1':merge.blob(p.read_bytes())})
    if not rel.endswith('release.yml'):
     d=kit/'integration/replacements'/rel;d.parent.mkdir(parents=True,exist_ok=True);d.write_text('new content')
   (kit/'integration/BASELINE.json').write_text(json.dumps({'existing_files':hashes}))
   (kit/'integration/additions/script').mkdir(parents=True);(kit/'integration/additions/script/new.py').write_text('# utility')
   with contextlib.redirect_stdout(io.StringIO()):
    merge.apply(kit,repo,False)
    self.assertEqual((repo/'.github/workflows/pages.yml').read_text(),'old-pages')
    backup=merge.apply(kit,repo,True)
   self.assertIn('office_readiness.py',(repo/'.github/workflows/release.yml').read_text())
   self.assertEqual((repo/'script/new.py').read_text(),'# utility')
   import shutil;shutil.rmtree(backup)

if __name__=='__main__':unittest.main()
