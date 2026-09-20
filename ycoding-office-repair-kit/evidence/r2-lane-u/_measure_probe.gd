## Lane U measurement probe. Read-only: builds real controls out of the tree and
## prints their engine-reported combined minimum sizes.
extends SceneTree


func _init() -> void:
	print("=== lane U measure probe ===")
	_button_clip()
	_sidebar_minimums()
	_composer_minimums()
	_toggles_widths()
	quit(0)


func _button_clip() -> void:
	var button := Button.new()
	button.flat = true
	button.text = "YCoding Office  \u2304"
	print("button plain        %s" % [button.get_combined_minimum_size()])
	button.clip_text = true
	print("button clip_text    %s" % [button.get_combined_minimum_size()])
	var label := Label.new()
	label.text = "YCoding Office  \u2304"
	print("label plain         %s" % [label.get_combined_minimum_size()])
	label.clip_text = true
	print("label clip_text     %s" % [label.get_combined_minimum_size()])


func _sidebar_minimums() -> void:
	var sidebar := SidebarPanel.new()
	root.add_child(sidebar)
	sidebar._ready()
	print("sidebar combined    %s" % [sidebar.get_combined_minimum_size()])
	_walk(sidebar, 0)
	sidebar.free()


func _walk(node: Node, depth: int) -> void:
	if depth > 3:
		return
	var control := node as Control
	if control != null and control.get_combined_minimum_size().x > 60.0:
		print(
			"  %s%s %s min=%s"
			% ["  ".repeat(depth), node.get_class(), node.name, control.get_combined_minimum_size()]
		)
	for child in node.get_children():
		_walk(child, depth + 1)


func _composer_minimums() -> void:
	for scale in UiScale.STEPS:
		var panel := PromptPanel.new()
		root.add_child(panel)
		panel._ready()
		panel.set_ui_scale(scale)
		OfficeTheme.rescale(panel)
		print(
			"composer scale %.2f   %s" % [scale, panel.get_combined_minimum_size()]
		)
		panel.free()


func _toggles_widths() -> void:
	for scale in UiScale.STEPS:
		print(
			"toggles scale %.2f    declared=%s height=%s"
			% [scale, ChromeToggles.cluster_width(scale), ChromeToggles.cluster_height(scale)]
		)
	var toggles := ChromeToggles.new()
	root.add_child(toggles)
	toggles._ready()
	print("toggles built 1.0   %s" % [toggles.get_combined_minimum_size()])
	toggles.free()
