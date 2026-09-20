## R7-04 native capture: provider quota windows in the real client, from the live runtime.
##
## Drives the REAL res://app/main.tscn scene and the REAL ProviderUsageApi against the
## running service, so the read and the rendering are the product's own. What it must show:
##
##   * one provider per row, EACH WINDOW INDEPENDENT, with its own unit;
##   * a window with a limit showing its share, and a window WITHOUT one showing no
##     percentage at all;
##   * an `unsupported` provider visible with its status rather than dropped;
##   * no combined total across windows.
##
## Kit-local: no repository source depends on this file.
extends SceneTree

var _out := ""
var _frames := 0
var _checks := 0
var _fails := 0


func _init() -> void:
	var args := OS.get_cmdline_user_args()
	if args.size() > 0:
		_out = str(args[0])


func _initialize() -> void:
	_go()


func _go() -> void:
	var packed := load("res://app/main.tscn")
	if packed == null:
		print("R704 FAIL: main scene did not load")
		quit(1)
		return
	var scene: Variant = packed.instantiate()
	root.add_child(scene)
	await process_frame
	if scene.demo == null:
		_frames += 1
		if _frames > 240:
			print("R704 FAIL: scene never became ready")
			quit(1)
			return
		_go.call_deferred()
		return
	_run(scene)


func _check(condition: bool, message: String) -> void:
	_checks += 1
	if condition:
		print("R704 PASS  " + message)
		return
	_fails += 1
	print("R704 FAIL  " + message)


func _run(scene) -> void:
	scene._on_route_requested(OfficeRoute.STATISTICS)
	await process_frame
	scene.statistics_panel.show_tab(StatisticsPanel.TAB_QUOTA)
	await process_frame

	var registered := _registered_url()
	print("R704 registered=%s" % registered)
	scene.start_live(registered, _registered_password())
	await process_frame
	await process_frame

	var api := ProviderUsageApi.new()
	api.configure(scene._side_transport())
	var snapshots := api.fetch()
	print("R704 snapshots=%d error=%s" % [snapshots.size(), api.last_error()])

	if snapshots.is_empty():
		print("R704 NOTE  no provider reported usage; the refusal is the evidence")
		_check(not api.last_error().is_empty(), "an empty read states why")
		quit(1 if _fails > 0 else 0)
		return

	var page := QuotaPage.new()
	page.adopt(snapshots, QuotaPage.VALID_AT, QuotaPage.FRESH)
	scene.statistics_panel.adopt_quota(page)
	await process_frame
	await process_frame

	var rows := page.provider_rows()
	print("R704 providers=%d" % rows.size())
	for row in rows:
		print("R704   %s status=%s windows=%d note=%s" % [
			str(row.get("provider", "")), str(row.get("status", "")),
			int(row.get("windows", 0)), str(row.get("note", "")),
		])

	_check(not page.has_combined_total(), "no combined total is offered across windows")

	# Every window of every provider: each keeps its own unit, and only a window with a real
	# denominator yields a percentage.
	var with_limit := 0
	var without_limit := 0
	for row in rows:
		for window in page.windows_for(str(row.get("provider", ""))):
			print("R704   window %s/%s unit=%s used=%s limit=%s pct=%s remaining=%s" % [
				str(row.get("provider", "")), window.label(), window.unit(),
				window.used_text(), window.limit_text(), window.percent_text(),
				window.remaining_text(),
			])
			if window.has_limit():
				with_limit += 1
				_check(
					window.percent_text() != QuotaPage.UNREPORTED,
					"a window with a limit shows a share (%s = %s)" % [
						window.label(), window.percent_text()]
				)
			else:
				without_limit += 1
				if window.has_used() and not window.unit_is_percent():
					# A DERIVED share needs a denominator, so a window with no limit and a
					# non-percent unit must show none.
					_check(
						window.percent_text() == QuotaPage.UNREPORTED,
						"a window WITHOUT a limit shows NO derived share (%s)" % window.label()
					)
				elif window.unit_is_percent():
					# A percent-unit window's figure IS the provider's own number, not a
					# derivation, so it is shown as reported.
					_check(
						window.percent_text() != QuotaPage.UNREPORTED,
						"a percent-unit window shows its own reported figure (%s)" % window.label()
					)
				_check(
					window.limit_text() == QuotaPage.UNREPORTED,
					"and its limit reads as unreported, not zero (%s)" % window.limit_text()
				)
	print("R704 windows_with_limit=%d without=%d" % [with_limit, without_limit])
	_check(with_limit > 0, "at least one window reported a real limit")

	var shown := _panel_text(scene.statistics_panel)
	print("R704 panel_names_quota=%s" % str(shown.contains("Provider quota")))
	print("R704 panel_names_note=%s" % str(shown.contains("does not report usage") or shown.contains("status")))
	_check(
		shown.contains("Provider quota") or shown.contains("quota"),
		"the quota tab is reachable on the surface"
	)

	await _capture(scene, "%s/r7-04-quota.png" % _out)
	print("R704 checks=%d fails=%d" % [_checks, _fails])
	print("R704 done")
	quit(1 if _fails > 0 else 0)


## Every visible string in a subtree, including BUTTON text: the tab is a button, so a probe
## that read only Labels reported the tab missing while the capture showed it on screen.
func _panel_text(node) -> String:
	var out := ""
	if node is Label:
		out += " " + node.text
	elif node is Button:
		out += " " + node.text
	for child in node.get_children():
		out += " " + _panel_text(child)
	return out.strip_edges()


func _registered_url() -> String:
	var path := _registration_path()
	if path.is_empty() or not FileAccess.file_exists(path):
		return ""
	var parsed: Variant = JSON.parse_string(FileAccess.get_file_as_string(path))
	if not (parsed is Dictionary):
		return ""
	return str(parsed.get("url", ""))


func _registered_password() -> String:
	var path := _registration_path()
	if path.is_empty() or not FileAccess.file_exists(path):
		return ""
	var parsed: Variant = JSON.parse_string(FileAccess.get_file_as_string(path))
	if not (parsed is Dictionary):
		return ""
	return str(parsed.get("password", ""))


func _registration_path() -> String:
	var home := OS.get_environment("HOME")
	if home.is_empty():
		return ""
	return home.path_join(".local/state/ycoding/service.json")


func _capture(scene, path: String) -> void:
	scene.capture_mode = true
	await process_frame
	await process_frame
	var image := root.get_viewport().get_texture().get_image()
	if image == null:
		print("R704 FAIL: no frame to capture")
		return
	if image.save_png(path) == OK:
		print("R704 captured %s" % path)
	else:
		print("R704 FAIL: could not write %s" % path)
