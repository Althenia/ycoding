## R3-01 native capture: the Settings surface, driven through the real scene.
##
## Boots the REAL `res://app/main.tscn`, opts into synthetic playback through the
## production action, routes to Settings through the production path, and writes a
## PNG of the rendered frame. It records the panel's ACTUAL logical rects and the
## mode/route so a reader can bind the image to the state it shows.
##
## It fabricates nothing about the runtime: the office is explicitly synthetic
## (`DEMO`), and the settings page itself renders the navigation model and the
## editing boundary. No provider data is involved.
##
## Kit-local: no repository source depends on this file.
##
##   "$GODOT_BIN" --path apps/office --resolution 1280x720 \
##     --script res://tools/r301_capture.gd -- --out=<abs dir> [--page=<id>] [--scale=<f>]
extends SceneTree

const DemoCapture := preload("res://tools/demo_capture.gd")

var _out := ""
var _page := ""
var _search := ""
var _scale := 0.0
var _fixture := false
var _stage := 0
var _scene: Node


func _init() -> void:
	for argument in OS.get_cmdline_user_args():
		if argument.begins_with("--out="):
			_out = argument.substr("--out=".length())
		elif argument.begins_with("--page="):
			_page = argument.substr("--page=".length())
		elif argument.begins_with("--search="):
			_search = argument.substr("--search=".length())
		elif argument.begins_with("--scale="):
			_scale = float(argument.substr("--scale=".length()))
		elif argument == "--fixture":
			# Bind a REVIEW carrying labelled synthetic values, so the read/provenance/editor
			# path is visible without a live service. Only ever used by this harness, and the
			# capture is labelled as fixture-backed.
			_fixture = true


func _initialize() -> void:
	var packed := load("res://app/main.tscn")
	if packed == null:
		print("R301 FAIL: main scene did not load")
		quit(1)
		return
	_scene = packed.instantiate()
	root.add_child(_scene)


## Bind a review whose reader answers from a labelled fixture.
##
## The DASHED part is important: this is a fixture, not a service, so the review's state
## is driven directly rather than by HTTP. It exists so the value/provenance/editor rows
## can be seen before a splitter is captured, and the printout names it as fixture-backed.
func _bind_fixture(scene: Node) -> void:
	var transport := FixtureTransport.new()
	var api := ConfigApi.new()
	api.configure(transport)
	api.fetch_read(200)
	var review := ConfigReview.new()
	review.configure(api)
	review.read_now()
	scene.config_review = review
	scene.settings_panel.bind_review(review)
	print("R301 fixture_backed=true (values come from the capture harness, not a service)")


## A transport double that answers the read from a canned `{location, data}` body.
class FixtureTransport extends HttpTransport:
	var _settled: Array[Dictionary] = []

	func request(method: int, path: String, body: Dictionary = {}) -> int:
		var payload := {
			"location": {"directory": "/fixture/office", "workspaceID": null, "project": null},
			"data": {
				"values": {
					"shell": "/bin/zsh",
					"autoupdate": "notify",
					"share": "manual",
					"username": "[redacted]",
					"instruction_max_bytes": 65536,
				},
				"sources": [
					{
						"path": "/fixture/global/ycoding.jsonc", "scope": "global",
						"keys": ["shell", "autoupdate", "share", "instruction_max_bytes"],
						"revision": "fixture0000000000000000000000000000000000000000000000000000000000",
					},
					{"path": "", "scope": "virtual", "keys": ["username"], "revision": "v"},
				],
			},
		}
		_settled.append({
			"request_id": 1, "kind": KIND_RESPONSE, "status": 200,
			"body": payload, "event": {}, "error": "",
		})
		return 1

	func poll(budget_ms: int = 4) -> Array[Dictionary]:
		budget_ms = budget_ms
		var entries: Array[Dictionary] = []
		entries.assign(_settled)
		_settled.clear()
		return entries


func _process(_delta: float) -> bool:
	if not DemoCapture.started(_scene):
		var reason := DemoCapture.failure(_scene)
		if not reason.is_empty():
			print("R301 FAIL: synthetic playback did not start: %s" % reason)
			quit(1)
			return true
		return false
	if _stage == 0:
		# Let playback produce a populated office, so the capture shows the shell over
		# a real synthetic state rather than an empty frame.
		_scene.demo.advance(20000)
		_scene._tick_ambient()
		_stage = 1
		return false
	if _stage == 1:
		if _scale > 0.0:
			_scene._cycle_scale(_scale)
		if _fixture:
			_bind_fixture(_scene)
		# Through the product's own route path, so what is captured is what a user sees.
		_scene._on_route_requested(OfficeRoute.SETTINGS)
		if not _page.is_empty():
			_scene.settings_panel.show_page_id(_page)
		if not _search.is_empty():
			# Through the panel's own search entry point, which is what the box calls.
			_scene.settings_panel.search(_search)
		_stage = 2
		return false
	if _stage == 2:
		# One frame to present the routed state.
		_stage = 3
		return false
	var panel: SettingsPanel = _scene.settings_panel
	print("R301 route=%s visible=%s page=%s scope=%s" % [
		_scene.router.route(), str(panel.visible), panel.page(), panel.scope(),
	])
	var review: ConfigReview = _scene.config_review
	if review != null:
		print("R301 config_state=%s values=%d sources=%d location=%s" % [
			review.state(), review._api.read_values().size() if review._api != null else 0,
			review._api.sources().size() if review._api != null else 0,
			review.resolved_directory(),
		])
	var surface := panel.review_surface()
	if surface != null:
		print("R301 review_visible=%s editing=%s apply_available=%s" % [
			str(surface.visible), str(surface.is_editing()), str(surface.apply_available()),
		])
	print("R301 window=%s" % str(_scene.get_viewport().get_visible_rect().size))
	print("R301 settings_rect=%s" % str(Rect2(panel.position, panel.size)))
	print("R301 sidebar_rect=%s" % str(Rect2(_scene.sidebar.position, _scene.sidebar.size)))
	print("R301 sidebar_placed=%s scale=%.2f min=%s" % [
		str(OfficeShellLayout.sidebar_width(
			_scene.get_viewport().get_visible_rect().size, _scene.ui_scale
		)),
		_scene.ui_scale, str(_scene.sidebar.get_combined_minimum_size()),
	])
	print("R301 office_visible=%s composer_visible=%s statistics_visible=%s" % [
		str(_scene.office_view.visible), str(_scene.prompt_panel.visible),
		str(_scene.statistics_panel.visible),
	])
	print("R301 nav_rows=%d offered_scopes=%s query='%s'" % [
		panel.page_rows().size(), str(panel.available_scopes()), panel.query(),
	])
	if not _out.is_empty():
		var suffix := "%s%s" % [
			_page if not _page.is_empty() else "default",
			"-search-%s" % _search if not _search.is_empty() else "",
		]
		var path := "%s/r3-01-%s%s.png" % [
			_out, suffix, "-%.2f" % _scale if _scale > 0.0 else "",
		]
		var image := root.get_texture().get_image()
		if image == null:
			print("R301 FAIL: no frame to capture")
			quit(1)
			return true
		var error := image.save_png(path)
		if error != OK:
			print("R301 FAIL: could not write %s (error %d)" % [path, error])
			quit(1)
			return true
		print("R301 captured %s (%dx%d)" % [path, image.get_width(), image.get_height()])
	quit(0)
	return true
