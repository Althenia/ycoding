#!/usr/bin/env python3
"""Fail-closed publication gate. Structural evidence validation is not human review."""
import argparse,json,re,subprocess
from pathlib import Path
from office_release import version
REQUIRED={'real_provider','settings_parity','native_visual','multi_project','player_input','statistics_quota','no_production_demo','macos_install','linux_install','windows_install'}
def validate(data:dict,v:str)->None:
 version(v)
 if data.get('version')!=v:raise ValueError('Readiness version differs from release')
 if not re.fullmatch('[a-f0-9]{40}',data.get('tested_commit','')):raise ValueError('Missing real tested source commit')
 checks=data.get('checks',{})
 for name in REQUIRED:
  row=checks.get(name,{})
  if row.get('result')!='pass' or row.get('synthetic') is not False or not row.get('evidence') or not row.get('reviewed_by') or not row.get('reviewed_at'):raise ValueError('Publication blocked: '+name+' requires real reviewed evidence')
 if '-' not in v.split('+',1)[0] and data.get('signing')!='verified':raise ValueError('Stable publication requires verified signing; use a clearly labelled prerelease for unsigned evaluation')
 if data.get('user_approved') is not True:raise ValueError('User release approval is required')
def main():
 p=argparse.ArgumentParser();p.add_argument('--version',required=True);p.add_argument('--file',type=Path,default=Path('docs/office-release-readiness.json'));a=p.parse_args()
 data=json.loads(a.file.read_text());validate(data,a.version)
 subprocess.run(['git','merge-base','--is-ancestor',data['tested_commit'],'HEAD'],check=True)
 changed=subprocess.check_output(['git','diff','--name-only',data['tested_commit'],'HEAD'],text=True).splitlines()
 allowed={str(a.file),f'docs/releases/v{a.version}.md'}
 if any(path not in allowed for path in changed):raise ValueError('Source changed since tested commit; rerun candidate acceptance')
 print('Publication readiness record structurally valid; actual evidence must also be reviewed in office-release environment.')
if __name__=='__main__':
 try:main()
 except (OSError,ValueError,subprocess.SubprocessError) as e:raise SystemExit(str(e))
