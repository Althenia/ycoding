import pathlib, subprocess, json, copy
KIT=pathlib.Path("ycoding-office-repair-kit")
LEDGER=KIT/"tracking/tui-action-ledger.json"
REG=pathlib.Path("packages/tui/src/config/keybind.ts")
P_LED=LEDGER.read_text(); P_REG=REG.read_text()

def run():
    r=subprocess.run(["python3","tools/action_parity.py","--root","."],
                     cwd=KIT, capture_output=True, text=True)
    return r.returncode, (r.stdout+r.stderr).strip().splitlines()

# 1. A new TUI action the ledger does not classify.
t=P_REG.replace('  help_show: keybind("none", "Open help dialog"),',
                '  help_show: keybind("none", "Open help dialog"),\n  probe_new_action: keybind("ctrl+y", "A brand new action"),',1)
REG.write_text(t); code,out=run(); REG.write_text(P_REG)
print("a new TUI action is unclassified            exit=%d  %s" % (code, out[0][:74] if out else ""))

# 2. A silent removal: the ledger still claims an action the registry dropped.
t=P_REG.replace('  help_show: keybind("none", "Open help dialog"),','',1)
REG.write_text(t); code,out=run(); REG.write_text(P_REG)
print("a silent removal is caught                  exit=%d  %s" % (code, out[0][:74] if out else ""))

# 3. An implemented row that cites a path which does not exist.
d=json.loads(P_LED); d["actions"]=[a for a in d["actions"]]
for a in d["actions"]:
    if a["name"]=="sidebar_toggle":
        a["basis"]="apps/office/ui/shell/does_not_exist.gd"; break
LEDGER.write_text(json.dumps(d,indent=1)); code,out=run(); LEDGER.write_text(P_LED)
print("an implemented row citing a missing file    exit=%d  %s" % (code, out[0][:74] if out else ""))

# 4. An implemented row with no office path at all.
d=json.loads(P_LED)
for a in d["actions"]:
    if a["name"]=="status_view": a["basis"]="the office shows status somewhere"; break
LEDGER.write_text(json.dumps(d,indent=1)); code,out=run(); LEDGER.write_text(P_LED)
print("an implemented row with no office path      exit=%d  %s" % (code, out[0][:74] if out else ""))

# 5. An unknown classification.
d=json.loads(P_LED)
for a in d["actions"]:
    if a["name"]=="command_list": a["classification"]="probably_fine"; break
LEDGER.write_text(json.dumps(d,indent=1)); code,out=run(); LEDGER.write_text(P_LED)
print("an unknown classification is refused        exit=%d  %s" % (code, out[0][:74] if out else ""))

# 6. A drifted default.
d=json.loads(P_LED)
for a in d["actions"]:
    if a["name"]=="help_show": a["default"]="ctrl+h"; break
LEDGER.write_text(json.dumps(d,indent=1)); code,out=run(); LEDGER.write_text(P_LED)
print("a drifted default is caught                 exit=%d  %s" % (code, out[0][:74] if out else ""))

print("restored:", LEDGER.read_text()==P_LED, REG.read_text()==P_REG)
