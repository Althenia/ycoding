## R5-02 native capture: the recent and pinned project rows in the real rail.
##
## Drives the REAL `res://app/main.tscn` scene, enters DEMO so the rail is fully
## built, then seeds a ledger with a pinned project and a recent one, one with live
## work and one quiet, and captures the rail.
##
## The state is printed alongside the capture, so the image and the counts it shows
## are bound together in the log rather than left for a reader to infer.
##
## Kit-local; no repository source depends on it.
##
## Run:
##   godot --path apps/office --resolution 1280x720 \
##     --script res://r5_02_capture_tmp.gd -- <outdir>
extends SceneTree

const DemoCapture := preload("res://tools/demo_capture.gd")

const SETTLE_FRAMES := 4

var _outdir := ""
var _scene: Node = null
var _waited := 0
var _settle := 0
var _done := false


func _initialize() -> void:
	var args := OS.get_cmdline_user_args()
	_outdir = str(args[0]) if args.size() > 0 else "/tmp/r5-02"
	DirAccess.make_dir_recursive_absolute(_outdir)
	_scene = (load("res://app/main.tscn") as PackedScene).instantiate()
	root.add_child(_scene)
	print("R502 start outdir=", _outdir)


func _process(_delta: float) -> bool:
	if _done:
		return true
	if _scene == null:
		return true
	if not DemoCapture.started(_scene):
		_waited += 1
		var failure := DemoCapture.failure(_scene)
		if not failure.is_empty():
			print("R502 blocked: ", failure)
			quit(2)
			return true
		if _waited > 900:
			print("R502 blocked: demo never started")
			quit(2)
			return true
		return false

	_waited += 1
	if _waited < 5:
		return false
	if _settle > 0:
		_settle -= 1
		if _settle == 0:
			_capture()
		return false
	if _done:
		return true
	_seed_and_capture()
	return false


## Seed two projects - one pinned with live work, one quiet - and let the rail redraw.
func _seed_and_capture() -> void:
	var ledger: ProjectLedger = _scene.project_ledger
	var store: OfficeStore = _scene.store
	var base := "/tmp/ycoding-r502-capture"
	DirAccess.make_dir_recursive_absolute(base + "/pinned-work")
	DirAccess.make_dir_recursive_absolute(base + "/quiet-folder")
	# Pinned first, with a session running in it.
	var pinned: Dictionary = ledger.add(base + "/pinned-work", "ses_cap_a", "Pinned project")
	ledger.pin(str(pinned["local_entry_id"]), 1)
	ledger.add(base + "/quiet-folder", "ses_cap_b", "Quiet project")
	ledger.touch(str(ledger.entries()[1]["local_entry_id"]))

	# A running session in the pinned folder, so its count is non-zero.
	store.apply({
		"type": Wire.SESSION_CREATED, "sessionID": "ses_cap_a",
		"data": {
			"agent": "lead", "title": "Lead",
			"location": {"directory": base + "/pinned-work"},
		},
	})
	store.apply({"type": Wire.STEP_STARTED, "sessionID": "ses_cap_a", "data": {}})
	print("R502 ledger entries=", ledger.entries().size())
	for entry in ledger.entries():
		var summary: Dictionary = ledger.summary_for(str(entry["canonical_directory"]), store)
		print("R502 row '%s' pinned=%s sessions=%d running=%d attention=%d" % [
			str(entry["display_name"]),
			str(int(entry["pin_order"]) > 0),
			int(summary["sessions"]), int(summary["running"]), int(summary["attention"]),
		])
	_scene._refresh_ui()
	_settle = SETTLE_FRAMES


func _capture() -> void:
	_done = true
	var texture := root.get_texture()
	if texture == null:
		print("R502 no texture to capture")
		quit(1)
		return
	var image := texture.get_image()
	if image == null:
		print("R502 no image to capture")
		quit(1)
		return
	var path := "%s/r5-02-projects.png" % _outdir
	image.save_png(path)
	# Report the rail's OWN rows, so the printed state comes from the UI rather than
	# from the ledger the test just wrote.
	var rows: Array = _scene.sidebar._projects_box.get_children()
	print("R502 rail rows=", rows.size())
	for row in rows:
		print("R502 rail text='%s' tooltip='%s'" % [
			(row as Button).text, (row as Button).tooltip_text,
		])
	print("R502 captured ", path)
	if _scene.live != null:
		_scene.live.stop()
	print("R502 done")
	quit(0)
