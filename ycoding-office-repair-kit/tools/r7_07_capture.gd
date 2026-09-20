## R7-07 native capture: the export, in the real client, from the surface's own control.
##
## Drives the REAL res://app/main.tscn scene. The acceptance is "CSV/JSON user action,
## formula-safe text, no secrets or auto public upload", and what this must show:
##
##   * the export control exists and NO file is written until it is pressed;
##   * the file it writes carries the rows the surface is showing;
##   * a formula-leading value is neutralised in the CSV but preserved in the JSON;
##   * a credential-shaped value is redacted from BOTH forms;
##   * the preview equals the written file exactly.
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
		print("R707 FAIL: main scene did not load")
		quit(1)
		return
	var scene: Variant = packed.instantiate()
	root.add_child(scene)
	await process_frame
	if scene.demo == null:
		_frames += 1
		if _frames > 240:
			print("R707 FAIL: scene never became ready")
			quit(1)
			return
		_go.call_deferred()
		return
	_run(scene)


func _check(condition: bool, message: String) -> void:
	_checks += 1
	if condition:
		print("R707 PASS  " + message)
		return
	_fails += 1
	print("R707 FAIL  " + message)


func _run(scene) -> void:
	scene._on_route_requested(OfficeRoute.STATISTICS)
	await process_frame
	await process_frame

	var export_path := "user://r7_07_capture.csv"
	DirAccess.remove_absolute(ProjectSettings.globalize_path(export_path))
	var builder := ExportBuilder.new()
	builder.add_rows([
		{"label": "=1+1", "value": "=SUM(A1:A9)", "count": 3, "spend": 1.25},
		{"label": "Delta", "value": "spend change", "count": -5, "spend": -2.5},
		{"label": "note", "value": "pass" + "word=scope-secret-value", "count": 1, "spend": 0.0},
	])
	# Composing does NOT write.
	_check(
		not FileAccess.file_exists(export_path),
		"composing the export writes no file"
	)
	var error := builder.write_csv(export_path)
	_check_equal(error, OK, "the requested write succeeds")
	var csv := FileAccess.get_file_as_string(export_path)
	var json := builder.text_json()
	print("R707 csv=\n%s" % csv)
	print("R707 json_head=%s" % json.substr(0, 180))

	# Formula safety: no cell in the CSV would execute, and the original text survives.
	_check(not _has_executable_cell(csv), "no CSV cell would be read as a formula")
	_check(
		csv.contains("'=1+1"),
		"a formula-leading TEXT cell carries the text guard (%s)" % csv.split("\n")[1]
	)
	# Data safety: a negative number is NOT guarded, so the column stays computable.
	_check(csv.contains(",-5,"), "a negative NUMBER is left bare")
	_check(not csv.contains("'-5"), "and is not escaped into text")
	# Redaction: the credential never reaches the file.
	_check(
		not csv.contains("scope-secret-value"),
		"a credential-shaped value is redacted from the CSV"
	)
	_check(
		not json.contains("scope-secret-value"),
		"and from the JSON, so the two forms agree"
	)
	# JSON is data, not a spreadsheet: the formula-leading value is preserved there.
	_check(
		json.contains("=1+1"),
		"the JSON preserves the value, because JSON is not a formula surface"
	)
	# The preview IS the file.
	_check_equal(builder.text(), csv, "the preview equals the written file exactly")
	_check(
		ExportBuilder.UPLOADS_NOTHING.contains("no network"),
		"and the export states it uploads nothing"
	)
	_check(
		not builder.has_method("upload") and not builder.has_method("publish"),
		"the export exposes no upload method"
	)

	# The surface offers the control, and pressing it is what exports.
	var shown := _panel_text(scene.statistics_panel)
	print("R707 panel_has_export=%s" % str(shown.contains("Export")))
	_check(shown.contains("Export"), "the statistics surface offers an export control")

	# Now export through the PRODUCT path. The surface must first be SHOWING figures, or the
	# export would carry nothing and prove nothing about the path that reads them.
	var page := StatisticsPage.new()
	page.adopt(SessionUsage.from_summary({
		"logical": 12, "physical": 15, "helpers": 2,
		"cost": 3.25,
		"tokens": {"input": 5000, "output": 900, "reasoning": 120, "cache": {"read": 3000, "write": 250}},
		"models": [
			{
				"model": {"providerID": "openrouter", "id": "deepseek-v4.1-flash", "variant": "max"},
				"requests": 8,
				"tokens": {"input": 4000, "output": 700, "reasoning": 100, "cache": {"read": 2500, "write": 200}},
				"cost": 2.75, "costProvenance": "recorded",
			},
			{
				"model": {"providerID": "openai", "id": "gpt-5.6-luna", "variant": "none"},
				"requests": 4,
				"tokens": {"input": 1000, "output": 200, "reasoning": 20, "cache": {"read": 500, "write": 50}},
				"cost": 0.5, "costProvenance": "current_catalog",
			},
		],
	}, ["ses_r707"]))
	scene.statistics_panel.adopt(page)
	await process_frame

	var surface_rows: Array = scene.statistics_panel.export_rows()
	print("R707 surface_rows=%d" % surface_rows.size())
	_check(surface_rows.size() > 0, "the surface has rows to export (%d)" % surface_rows.size())

	scene._on_export_requested()
	await process_frame
	print("R707 product_export=%s" % str(scene.store.last_error))
	_check(
		str(scene.store.last_error).contains("Exported"),
		"the product's export path reports what it wrote (%s)" % str(scene.store.last_error)
	)
	_check(
		not str(scene.store.last_error).contains("Exported 0 rows"),
		"and it exported the rows the surface was showing, not none (%s)" % str(scene.store.last_error)
	)
	# Read the file the PRODUCT wrote, not one composed here.
	var product_csv := FileAccess.get_file_as_string("user://statistics-export.csv")
	print("R707 product_csv=
%s" % product_csv)
	_check(
		product_csv.contains("openrouter"),
		"the written file carries a real model ref from the surface"
	)
	_check(
		product_csv.contains("deepseek"),
		"and the model row the surface was showing"
	)
	# The `count` column is the MODEL row's request count, not the session's physical attempts:
	# the export writes what each row holds. Asserting the row's own figure is what tests the
	# path rather than my expectation.
	_check(
		product_csv.contains(",8,"),
		"with the first model row's own request count (%s)" % product_csv.split("\n")[1]
	)
	_check(
		product_csv.contains("2.75") and product_csv.contains("0.50"),
		"and each row's own spend"
	)
	_check(
		not product_csv.contains("scope-secret-value") and not product_csv.contains("/Users/"),
		"and no credential or private path reached the product's file"
	)

	await _capture(scene, "%s/r7-07-export.png" % _out)
	DirAccess.remove_absolute(ProjectSettings.globalize_path(export_path))
	DirAccess.remove_absolute(ProjectSettings.globalize_path("user://statistics-export.csv"))
	print("R707 checks=%d fails=%d" % [_checks, _fails])
	print("R707 done")
	quit(1 if _fails > 0 else 0)


func _check_equal(actual: Variant, expected: Variant, message: String) -> void:
	_check(actual == expected, message)


## Whether any CSV cell would be read as a formula.
func _has_executable_cell(text: String) -> bool:
	for line in text.split("\n"):
		if line.strip_edges().is_empty():
			continue
		for field in line.split(","):
			var cell := field.strip_edges()
			if cell.is_empty() or cell.begins_with("'"):
				continue
			if cell.begins_with("=") or cell.begins_with("+") or cell.begins_with("@"):
				return true
			if cell.begins_with("-") and not (cell.is_valid_float() or cell.is_valid_int()):
				return true
	return false


func _panel_text(node) -> String:
	var out := ""
	if node is Label:
		out += " " + node.text
	elif node is Button:
		out += " " + node.text
	for child in node.get_children():
		out += " " + _panel_text(child)
	return out.strip_edges()


func _capture(scene, path: String) -> void:
	scene.capture_mode = true
	await process_frame
	await process_frame
	var image := root.get_viewport().get_texture().get_image()
	if image == null:
		print("R707 FAIL: no frame to capture")
		return
	if image.save_png(path) == OK:
		print("R707 captured %s" % path)
	else:
		print("R707 FAIL: could not write %s" % path)
