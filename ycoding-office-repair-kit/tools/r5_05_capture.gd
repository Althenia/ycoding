## R5-05 native capture: a project's draft, route and camera come back when you return.
##
## Drives the REAL `res://app/main.tscn` scene, so the panels, layout and composer are the
## production ones. The store is pointed at a throwaway preference file, because a driver
## must never write over the state a person is using.
##
## The sequence is the acceptance's own flow, minus the second service:
##   open A -> type a draft -> leave A for B -> B starts CLEAN -> return to A -> A's draft
##   and surface are back.
##
## Every step prints what the composer and the rail actually show, read back from the
## panels rather than from the values the driver wrote, so the state and the capture are
## bound together in the log.
##
## Kit-local; no repository source depends on it.
##
## Run:
##   godot --path apps/office --resolution 1280x720 \
##     --script res://r5_05_capture_tmp.gd -- <outdir>
extends SceneTree

const DemoCapture := preload("res://tools/demo_capture.gd")

const SETTLE_FRAMES := 4
const PREF_PATH := "user://r505_capture_state.cfg"
const ALPHA_DIR := "/tmp/r5-05-alpha"
const BETA_DIR := "/tmp/r5-05-beta"

var _outdir := ""
var _scene: Node = null
var _waited := 0
var _settle := 0
var _step := 0
var _done := false


func _initialize() -> void:
	var args := OS.get_cmdline_user_args()
	_outdir = str(args[0]) if args.size() > 0 else "/tmp/r5-05"
	DirAccess.make_dir_recursive_absolute(_outdir)
	# Start from nothing, so what the run restores was written by this run.
	DirAccess.remove_absolute(ProjectSettings.globalize_path(PREF_PATH))
	DirAccess.remove_absolute(ProjectSettings.globalize_path(PREF_PATH + ".tmp"))
	_scene = (load("res://app/main.tscn") as PackedScene).instantiate()
	root.add_child(_scene)
	print("R505 start outdir=", _outdir)


func _process(_delta: float) -> bool:
	if _done or _scene == null:
		return true
	if not DemoCapture.started(_scene):
		_waited += 1
		var failure := DemoCapture.failure(_scene)
		if not failure.is_empty():
			print("R505 blocked: ", failure)
			quit(2)
			return true
		if _waited > 900:
			print("R505 blocked: demo never started")
			quit(2)
			return true
		return false
	_waited += 1
	if _waited < 5:
		return false
	if _settle > 0:
		_settle -= 1
		return false
	_advance()
	return false


func _advance() -> void:
	if _step >= _steps().size():
		_finish()
		return
	var step: Dictionary = _steps()[_step]
	_step += 1
	callv(str(step["call"]), step.get("args", []))
	_settle = SETTLE_FRAMES


func _steps() -> Array:
	return [
		{"call": "_install"},
		{"call": "_open_alpha"},
		{"call": "_leave_alpha"},
		{"call": "_return_to_alpha"},
		{"call": "_capture", "args": ["r5-05-restored-route.png"]},
		{"call": "_show_the_draft"},
		{"call": "_capture", "args": ["r5-05-restored-draft.png"]},
	]


func _install() -> void:
	DirAccess.make_dir_recursive_absolute(ALPHA_DIR)
	DirAccess.make_dir_recursive_absolute(BETA_DIR)
	# The throwaway preference, so the run cannot touch the state a user is using.
	_scene.view_state = OfficeViewState.new()
	_scene.view_state.file_path = PREF_PATH
	print("R505 installed; preference=", PREF_PATH)


## Open the first project and give it something to remember: a half-written draft and a
## surface that is not the default.
func _open_alpha() -> void:
	_scene.select_folder(ALPHA_DIR)
	_scene.prompt_panel.set_draft("alpha half-written thought")
	_scene.router.go(OfficeRoute.STATISTICS)
	_report("after opening ALPHA")


## Leave for the second project. It has no saved state, so it must start CLEAN rather than
## inherit the draft that was typed in the first.
func _leave_alpha() -> void:
	_scene.select_folder(BETA_DIR)
	_report("after switching to BETA")


## Return. The draft and the surface belong to the project they were made in.
func _return_to_alpha() -> void:
	_scene.select_folder(ALPHA_DIR)
	_report("after returning to ALPHA")


## What the panels actually show, so the capture and the state agree.
func _report(label: String) -> void:
	print("R505 %s: draft='%s' route='%s' target='%s'" % [
		label, _scene.prompt_panel.current_text(), _scene.router.route(),
		_scene.prompt_panel.target_text(),
	])


## The restored route is Statistics, which is a reading surface and hides the composer, so
## the restored DRAFT cannot be seen there. The route is moved to the office to show it -
## the draft itself is untouched by this, and the log reports it before and after.
func _show_the_draft() -> void:
	_scene.router.go(OfficeRoute.OFFICE)
	_report("with the office surface shown")


func _capture(capture_path: String = "") -> void:
	var texture := root.get_texture()
	if texture == null:
		print("R505 no texture to capture")
		quit(1)
		return
	var image := texture.get_image()
	if image == null:
		print("R505 no image to capture")
		quit(1)
		return
	var path := "%s/%s" % [_outdir, capture_path if not capture_path.is_empty() else "r5-05-capture.png"]
	image.save_png(path)
	print("R505 captured ", path)


func _finish() -> void:
	_done = true
	# The preference the run wrote, so the file's own contents are evidence too: it declares
	# its schema version and names no credential.
	var saved := FileAccess.get_file_as_string(PREF_PATH)
	print("R505 preference bytes=%d declares_version=%s names_no_credential=%s" % [
		saved.length(), str(saved.contains("version")),
		str(not saved.to_lower().contains("password")),
	])
	print("R505 done")
	if _scene.live != null:
		_scene.live.stop()
	# Leave nothing behind: the preference and the temporary must both be gone.
	DirAccess.remove_absolute(ProjectSettings.globalize_path(PREF_PATH))
	DirAccess.remove_absolute(ProjectSettings.globalize_path(PREF_PATH + ".tmp"))
	DirAccess.remove_absolute(ProjectSettings.globalize_path(ALPHA_DIR))
	DirAccess.remove_absolute(ProjectSettings.globalize_path(BETA_DIR))
	quit(0)
