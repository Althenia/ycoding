## Chrome-toggle tests.
##
## Hiding the floating panels is a usability feature, and its one hard requirement
## is that it can always be undone: the control that hides the panels must never
## be hideable itself, and its own state must be readable without colour.
##
## The cluster carries five controls in one row, so this suite also pins the
## requirement a render exposed: every control must be distinguishable from the
## others. A label that names only the shared verb ("Hide") leaves two enabled
## buttons reading identically, so each label names the surface it controls and
## carries a text state marker drawn from the same filled/hollow pair the roster
## already uses.
extends RefCounted


func run(t) -> void:
	test_starts_visible(t)
	test_toggles_flip_state(t)
	test_emits_the_new_state(t)
	test_every_entry_is_offered(t)
	test_labels_state_the_action_not_the_colour(t)
	test_set_hidden_restores_an_arrangement(t)
	test_never_offers_to_hide_itself(t)
	# The cluster's legibility: distinguishability, state, reachability, accuracy.
	test_every_control_names_its_own_surface(t)
	test_no_two_enabled_controls_share_a_label(t)
	test_the_state_is_marked_as_text_not_only_colour(t)
	test_every_control_is_enabled_and_acts(t)
	test_the_hide_show_round_trip_restores_every_panel(t)
	test_the_scale_label_shows_the_applied_scale(t)
	test_the_theme_label_names_the_active_mode(t)
	test_the_cluster_fits_the_frame_at_every_size_and_scale(t)


## The ordered control names, so a test never hardcodes the set.
func _control_names() -> Array[String]:
	var names: Array[String] = []
	for entry in ChromeToggles.ENTRIES:
		names.append(str(entry["name"]))
	for entry in ChromeToggles.ACTIONS:
		names.append(str(entry["name"]))
	return names


## The surface each control names, as declared by the cluster itself.
func _surface_of(name: String) -> String:
	for entry in ChromeToggles.ENTRIES:
		if str(entry["name"]) == name:
			return str(entry["label"])
	for entry in ChromeToggles.ACTIONS:
		if str(entry["name"]) == name:
			return str(entry["label"])
	return ""


func _button(toggles: ChromeToggles, name: String) -> Button:
	return toggles._buttons.get(name) as Button


func _label(toggles: ChromeToggles, name: String) -> String:
	var button := _button(toggles, name)
	return "" if button == null else button.text


## What a label carries beyond the surface name: the state token.
func _state_token(label: String, surface: String) -> String:
	return label.trim_prefix(surface).strip_edges()


## The cluster's own minimum size at a text scale, built from the controls the
## scale produces.
##
## Read from the engine only as a CROSS-CHECK at 100%, where its cache is fresh: a
## headless suite runs no frame between `_init` and its assertions, so a control's
## cached minimum does not revalidate after a font-size override and would report a
## scale-independent number. That is why the cluster declares its own size from font
## metrics, which do scale, instead of asking a control.
func _engine_minimum(scale: float, tree: SceneTree) -> Vector2:
	var previous := OfficeTheme.text_scale()
	OfficeTheme.set_text_scale(scale)
	var toggles := ChromeToggles.new()
	tree.root.add_child(toggles)
	toggles._ready()
	var measured := toggles.get_combined_minimum_size()
	toggles.free()
	OfficeTheme.set_text_scale(previous)
	return measured


## --- the original invariants -------------------------------------------------

func test_starts_visible(t) -> void:
	var toggles := ChromeToggles.new()
	toggles._ready()
	for entry in ChromeToggles.ENTRIES:
		t.check(
			not toggles.is_hidden(str(entry["name"])),
			"%s starts visible" % entry["name"]
		)
	t.check(toggles.hidden_names().is_empty(), "nothing is hidden at first")
	toggles.free()


func test_toggles_flip_state(t) -> void:
	var toggles := ChromeToggles.new()
	toggles._ready()
	toggles._on_pressed("sidebar")
	t.check(toggles.is_hidden("sidebar"), "pressing hides the sidebar")
	toggles._on_pressed("sidebar")
	t.check(not toggles.is_hidden("sidebar"), "pressing again shows it")
	toggles._on_pressed("composer")
	t.check(toggles.is_hidden("composer"), "the composer is independent of the sidebar")
	t.check(not toggles.is_hidden("sidebar"), "hiding one does not hide the other")
	toggles.free()


## The composition root needs the new state, so the signal must carry it rather
## than making the listener re-read the control.
func test_emits_the_new_state(t) -> void:
	var toggles := ChromeToggles.new()
	toggles._ready()
	var seen: Array = []
	toggles.toggled.connect(func(name: String, hidden: bool): seen.append([name, hidden]))
	toggles._on_pressed("composer")
	t.check(seen.size() == 1, "one toggle emits once")
	if seen.size() == 1:
		t.check(seen[0][0] == "composer", "the signal names the overlay")
		t.check(seen[0][1] == true, "the signal carries the new hidden state")
	toggles._on_pressed("composer")
	if seen.size() == 2:
		t.check(seen[1][1] == false, "the second toggle reports visible again")
	toggles.free()


## Every hideable overlay must be reachable from the cluster, or a panel could be
## hidden with no control to restore it.
func test_every_entry_is_offered(t) -> void:
	var offered: Array[String] = []
	for entry in ChromeToggles.ENTRIES:
		offered.append(str(entry["name"]))
	for name: String in OfficeShellLayout.HIDEABLE:
		t.check(offered.has(name), "the cluster offers a control for %s" % name)
	t.check(
		not offered.has("toggles"),
		"the cluster does not offer to hide itself"
	)


## State must be readable as text, not only as a tint or a pressed flag.
func test_labels_state_the_action_not_the_colour(t) -> void:
	var toggles := ChromeToggles.new()
	toggles._ready()
	var button := toggles._buttons["sidebar"] as Button
	t.check(button != null, "the sidebar has a button")
	if button == null:
		toggles.free()
		return
	var surface := _surface_of("sidebar")
	var shown_label := button.text
	toggles._on_pressed("sidebar")
	var hidden_label := button.text
	t.check(shown_label != hidden_label, "the label changes with the state")
	t.check(not shown_label.is_empty(), "the label is never blank")
	t.check(not hidden_label.is_empty(), "the hidden label is never blank")
	t.check(
		shown_label.begins_with(surface) and hidden_label.begins_with(surface),
		"both states still name the surface they control"
	)
	toggles.free()


func test_set_hidden_restores_an_arrangement(t) -> void:
	var toggles := ChromeToggles.new()
	toggles._ready()
	toggles.set_hidden("sidebar", true)
	toggles.set_hidden("composer", true)
	t.check(toggles.hidden_names().size() == 2, "both can be hidden at once")
	toggles.set_hidden("sidebar", false)
	t.check(toggles.hidden_names() == ["composer"], "one can be shown again alone")
	toggles.free()


func test_never_offers_to_hide_itself(t) -> void:
	var toggles := ChromeToggles.new()
	toggles._ready()
	t.check(not toggles._buttons.has("toggles"), "there is no control for the cluster")
	t.check(
		not OfficeShellLayout.HIDEABLE.has("toggles"),
		"the cluster is not a hideable overlay"
	)
	toggles.free()


## --- the cluster's legibility ------------------------------------------------

## AC1. Every control names the surface it controls, so a user can tell them apart
## without reading a tooltip.
func test_every_control_names_its_own_surface(t) -> void:
	var toggles := ChromeToggles.new()
	toggles._ready()
	for name in _control_names():
		var surface := _surface_of(name)
		var label := _label(toggles, name)
		t.check(not surface.is_empty(), "%s declares the surface it controls" % name)
		t.check(not label.is_empty(), "%s is labelled" % name)
		t.check(
			label.begins_with(surface),
			"%s names its surface (%s, wanted prefix %s)" % [name, label, surface]
		)
	toggles.free()


## AC1. Two enabled controls reading the same text are indistinguishable, and a
## cluster with five controls cannot be labelled by the shared verb alone.
func test_no_two_enabled_controls_share_a_label(t) -> void:
	var toggles := ChromeToggles.new()
	toggles._ready()
	var seen := {}
	for name in _control_names():
		var button := _button(toggles, name)
		t.check(button != null, "%s has a control" % name)
		if button == null or button.disabled:
			continue
		var label := button.text
		t.check(
			not seen.has(label),
			"no two enabled controls read %s (also %s)" % [label, str(seen.get(label, ""))]
		)
		seen[label] = name
	toggles.free()


## AC4. Hidden and visible must be legible as text, not carried by the palette
## alone. The marker pair is the roster's own filled/hollow pair.
func test_the_state_is_marked_as_text_not_only_colour(t) -> void:
	var toggles := ChromeToggles.new()
	toggles._ready()
	for entry in ChromeToggles.ENTRIES:
		var name := str(entry["name"])
		var surface := str(entry["label"])
		var shown := _label(toggles, name)
		t.check(
			_state_token(shown, surface).find(SidebarPanel.MARK_SELECTED) != -1,
			"%s is marked present while visible (%s)" % [name, shown]
		)
		toggles.set_hidden(name, true)
		var hidden := _label(toggles, name)
		t.check(
			_state_token(hidden, surface).find(SidebarPanel.MARK_UNSELECTED) != -1,
			"%s is marked absent while hidden (%s)" % [name, hidden]
		)
		t.check(
			_state_token(shown, surface) != _state_token(hidden, surface),
			"%s's state token changes with its state" % name
		)
		toggles.set_hidden(name, false)
	toggles.free()


## AC3. A control that cannot act would have to be disabled and say why; none of
## these is disabled, so each must report the press it receives.
func test_every_control_is_enabled_and_acts(t) -> void:
	var toggles := ChromeToggles.new()
	toggles._ready()
	var toggled: Array = []
	var requested: Array = []
	toggles.toggled.connect(func(name: String, hidden: bool): toggled.append([name, hidden]))
	toggles.action_requested.connect(func(name: String): requested.append(name))
	for entry in ChromeToggles.ENTRIES:
		var name := str(entry["name"])
		var button := _button(toggles, name)
		t.check(button != null and not button.disabled, "%s can act" % name)
		if button == null:
			continue
		button.pressed.emit()
		t.check(
			toggled.size() > 0 and toggled[-1][0] == name,
			"pressing %s reports that overlay" % name
		)
		t.check(toggled[-1][1] == true, "and reports it hidden")
	for entry in ChromeToggles.ACTIONS:
		var name := str(entry["name"])
		var button := _button(toggles, name)
		t.check(button != null and not button.disabled, "%s can act" % name)
		if button == null:
			continue
		button.pressed.emit()
		t.check(
			requested.size() > 0 and requested[-1] == name,
			"pressing %s requests the %s setting" % [name, name]
		)
		t.check(
			not toggles.is_hidden(name),
			"%s is a setting, not a hideable panel" % name
		)
	toggles.free()


## AC4. Hiding every panel and showing them again restores each one, and the label
## returns with it: the way back is always present.
func test_the_hide_show_round_trip_restores_every_panel(t) -> void:
	var toggles := ChromeToggles.new()
	toggles._ready()
	var initial := {}
	for entry in ChromeToggles.ENTRIES:
		initial[str(entry["name"])] = _label(toggles, str(entry["name"]))
	for entry in ChromeToggles.ENTRIES:
		toggles._on_pressed(str(entry["name"]))
	t.check(
		toggles.hidden_names().size() == ChromeToggles.ENTRIES.size(),
		"every panel can be hidden at once"
	)
	t.check(
		not toggles.is_hidden("toggles") and not OfficeShellLayout.HIDEABLE.has("toggles"),
		"the cluster itself is never hidden"
	)
	for entry in ChromeToggles.ENTRIES:
		var name := str(entry["name"])
		var hidden_label := _label(toggles, name)
		t.check(hidden_label != str(initial[name]), "%s's label follows the state" % name)
		toggles._on_pressed(name)
	t.check(toggles.hidden_names().is_empty(), "every panel is shown again")
	for entry in ChromeToggles.ENTRIES:
		var name := str(entry["name"])
		t.check(
			_label(toggles, name) == str(initial[name]),
			"%s's label is restored" % name
		)
	toggles.free()


## AC5. The scale control shows the scale that is applied, including when a request
## outside the supported range is clamped rather than honoured.
func test_the_scale_label_shows_the_applied_scale(t) -> void:
	var toggles := ChromeToggles.new()
	toggles._ready()
	for scale in UiScale.STEPS:
		toggles.set_ui_scale(scale)
		var label := _label(toggles, "scale")
		var applied := UiScale.clamp_scale(scale)
		t.check(
			label.find("%d%%" % int(round(applied * 100.0))) != -1,
			"the label reads the applied scale at %s (%s)" % [str(scale), label]
		)
	toggles.set_ui_scale(4.0)
	t.check(
		_label(toggles, "scale").find("200%") != -1,
		"an over-scale label reads the clamped scale (%s)" % _label(toggles, "scale")
	)
	toggles.set_ui_scale(0.0)
	t.check(
		_label(toggles, "scale").find("100%") != -1,
		"an under-scale label reads the clamped scale (%s)" % _label(toggles, "scale")
	)
	toggles.free()


## AC1/AC5. The theme control names the surface and the mode actually in use, so a
## press is legible as a setting rather than as an unlabelled button.
func test_the_theme_label_names_the_active_mode(t) -> void:
	var previous := OfficeTheme.mode()
	var toggles := ChromeToggles.new()
	toggles._ready()
	for mode in OfficePalette.modes():
		OfficeTheme.set_mode(mode)
		toggles.restyle()
		var label := _label(toggles, "theme")
		t.check(
			label.begins_with(_surface_of("theme")),
			"the theme control names its surface (%s)" % label
		)
		t.check(
			label.to_lower().find(mode) != -1,
			"the theme control names the mode in use (%s, mode %s)" % [label, mode]
		)
	OfficeTheme.set_mode(previous)
	toggles.restyle()
	toggles.free()


## Print each control's own engine minimum against the text width this module
## charges for it, so the padding constant is calibrated from evidence rather than
## guessed. Informational: the assertions above and below carry the gate.
func _calibrate(t, engine_minimum: Vector2) -> void:
	var toggles := ChromeToggles.new()
	t.root.add_child(toggles)
	toggles._ready()
	var font := ThemeDB.fallback_font
	var size := ChromeToggles.label_font(1.0)
	var text_total := 0.0
	for name in _control_names():
		var button := _button(toggles, name)
		var text_width := font.get_string_size(
			button.text, HORIZONTAL_ALIGNMENT_LEFT, -1, size
		).x
		text_total += text_width
		print(
			"chrome_toggles calib %s text=%s width=%.0f over=%+.0f" % [
				name, str(button.get_combined_minimum_size()), text_width,
				button.get_combined_minimum_size().x - text_width
			]
		)
	print(
		"chrome_toggles calib total text=%.0f engine=%.0f declared=%.0f row_over=%.0f" % [
			text_total, engine_minimum.x, ChromeToggles.cluster_width(1.0),
			engine_minimum.x - text_total
		]
	)
	toggles.free()
## its own labels, and at least as large as the controls the engine reports at 100%.
func test_the_cluster_fits_the_frame_at_every_size_and_scale(t) -> void:
	var sizes := OfficeShellLayout.supported_sizes()
	var narrowest: Vector2 = sizes[0]
	for size: Vector2 in sizes:
		narrowest = size if size.x < narrowest.x else narrowest
	var engine_minimum := _engine_minimum(1.0, t)
	t.check(
		engine_minimum.x > 0.0 and engine_minimum.y > 0.0,
		"the built cluster reports a real minimum at 100%"
	)
	_calibrate(t, engine_minimum)
	for scale in UiScale.STEPS:
		var width := ChromeToggles.cluster_width(scale)
		var height := ChromeToggles.cluster_height(scale)
		print(
			"chrome_toggles: declared %.0fx%.0f at scale %.2f; shell reserves %.0fx%.0f" % [
				width, height, scale,
				OfficeShellLayout.TOGGLES_W, OfficeShellLayout.TOGGLES_H
			]
		)
		t.check(width > 0.0 and height > 0.0, "the cluster declares its size at %.2f" % scale)
		t.check(
			height >= engine_minimum.y,
			"the declared height %.0f covers the built controls at %.2f" % [height, scale]
		)
		t.check(
			width + OfficeShellLayout.TOGGLES_MARGIN <= narrowest.x,
			"the cluster fits the narrowest frame at %.2f (%.0f + %.0f <= %.0f)" % [
				scale, width, OfficeShellLayout.TOGGLES_MARGIN, narrowest.x
			]
		)
		for size: Vector2 in sizes:
			t.check(
				width + OfficeShellLayout.TOGGLES_MARGIN <= size.x
				and height + OfficeShellLayout.TOGGLES_MARGIN <= size.y,
				"the cluster is not clipped at %s x%.2f" % [str(size), scale]
			)
	# At 100% the two must agree on the row that is actually rendered: the declared
	# width is the room the five controls need.
	t.check(
		ChromeToggles.cluster_width(1.0) >= engine_minimum.x,
		"the declared width %.0f covers the built cluster %.0f at 100%%" % [
			ChromeToggles.cluster_width(1.0), engine_minimum.x
		]
	)
	# The declared size grows with the text scale, or a 200% cluster would clip.
	t.check(
		ChromeToggles.cluster_width(2.0) > ChromeToggles.cluster_width(1.0),
		"the declared width grows with the text scale"
	)
	t.check(
		ChromeToggles.cluster_height(2.0) > ChromeToggles.cluster_height(1.0),
		"the declared height grows with the text scale"
	)
