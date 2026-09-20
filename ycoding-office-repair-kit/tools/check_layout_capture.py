#!/usr/bin/env python3
"""Check actual default-shell logical rectangles exported by running Godot Controls."""
import argparse,json,math
from pathlib import Path

def check(data):
 errors=[]
 if data.get('source')!='native_control_capture':return ['Capture must come from actual native Control geometry, not expected rectangles']
 if not data.get('revision') or not data.get('captured_at'):errors.append('Missing source/time provenance')
 rects=data.get('rects',{})
 for name in ('window','sidebar','office','composer'):
  r=rects.get(name)
  if not isinstance(r,list) or len(r)!=4 or any(not isinstance(x,(int,float)) or not math.isfinite(x) for x in r) or r[2]<=0 or r[3]<=0:errors.append('Invalid '+name+' rectangle')
 if errors:return errors
 w,s,o,c=[rects[x] for x in ('window','sidebar','office','composer')]
 if abs(s[0]-w[0])>2 or abs(s[1]-w[1])>2 or abs(s[3]-w[3])>2:errors.append('Sidebar is not aligned/full-height')
 if abs(o[0]-(s[0]+s[2]))>2 or abs(o[1]-w[1])>2 or abs(o[3]-w[3])>2:errors.append('Office does not fill the remaining content region')
 if abs(o[0]+o[2]-w[0]-w[2])>2:errors.append('Office right edge does not match content window')
 if abs((c[0]+c[2]/2)-(o[0]+o[2]/2))>2:errors.append('Composer is not centered in visible office')
 if c[0]<o[0]+14 or c[0]+c[2]>o[0]+o[2]-14:errors.append('Composer does not preserve side gutters')
 if c[1]<o[1] or c[1]+c[3]>o[1]+o[3]-14:errors.append('Composer outside bottom safe area')
 if c[3]>0.4*o[3]:errors.append('Composer covers too much office in default shell')
 if data.get('clipped_controls',[]):errors.append('Clipped controls reported')
 return errors
if __name__=='__main__':
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('capture',type=Path);a=p.parse_args()
 try:e=check(json.loads(a.capture.read_text())); print('\n'.join(e) if e else 'Default shell geometry PASS; visual/input review still required.');raise SystemExit(bool(e))
 except (OSError,ValueError) as e:raise SystemExit(str(e))
