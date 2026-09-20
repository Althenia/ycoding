## Measure the composer's REAL content minimum at every text scale (R5-03 finding).
##
## The layout reserves a height for the composer from a constant. If that constant is
## smaller than the rows the panel actually builds, Godot grows the control past its
## rect and the last line - the target the composer exists to name - is clipped off
## the window. This measures the real minimum so the constant can be set from evidence
## rather than guessed, and prints the rect the layout would give it for comparison.
##
## Kit-local; no repository source depends on it.
##
## Run:
##   godot --headless --path apps/office --script res://r5_03_measure_tmp.gd
extends SceneTree


func _initialize() -> void:
	print("R503M scale  panel_min_h  reserved_h  composer_y  composer_bottom  window_h")
	for scale in UiScale.STEPS:
		OfficeTheme.set_text_scale(scale)
		var panel := PromptPanel.new()
		panel._ready()
		root.add_child(panel)
		panel.set_target("/tmp/r5-03-alpha")
		var need := panel.get_combined_minimum_size().y
		var window := Vector2(1280, 720)
		var rects := OfficeShellLayout.overlays(window, scale)
		var rect: Rect2 = rects["composer"]
		print("R503M %.2f   %.1f        %.1f       %.1f       %.1f            %.1f" % [
			scale, need, rect.size.y, rect.position.y, rect.end.y, window.y,
		])
		panel.free()
	OfficeTheme.set_text_scale(1.0)
	quit(0)
