## Focus-visibility tests.
##
## TASK-023 requires focus to be visible. A focus style that is identical to the
## unfocused style satisfies "has a focus stylebox" while being invisible to the
## user, which is the defect this pins: focus must differ from the resting state
## by more than shading, and every keyboard-reachable control must carry it.
extends RefCounted


func run(t) -> void:
	test_focus_ring_differs_from_resting_button(t)
	test_focus_fill_keeps_the_surface_and_adds_the_ring(t)
	test_focus_ring_is_drawn_as_an_outline(t)
	test_primary_and_secondary_buttons_both_focus(t)
	test_button_exposes_the_overridden_focus_style(t)


func test_focus_ring_differs_from_resting_button(t) -> void:
	var rest := OfficeTheme.button_style(OfficeTheme.bg_panel_alt())
	var focus := OfficeTheme.focus_style()
	t.check(
		focus.border_color != rest.border_color,
		"the focus ring uses a different border colour from the resting button"
	)
	t.check(
		focus.border_width_left > rest.border_width_left,
		"the focus ring is wider than the resting button border"
	)
	t.check(
		focus.get_expand_margin(SIDE_LEFT) > 0.0,
		"the focus ring extends past the control edge so it is not hidden by it"
	)


func test_focus_fill_keeps_the_surface_and_adds_the_ring(t) -> void:
	var resting := OfficeTheme.panel_style(OfficeTheme.bg_input())
	var focused := OfficeTheme.focus_fill_style(OfficeTheme.bg_input())
	t.check(
		focused.bg_color == resting.bg_color,
		"the focused composer keeps its filled surface"
	)
	t.check(
		focused.border_color != resting.border_color,
		"the focused composer gains a distinct border"
	)
	t.check(
		focused.border_width_left > resting.border_width_left,
		"the focused composer border is visibly heavier"
	)


func test_focus_ring_is_drawn_as_an_outline(t) -> void:
	var focus := OfficeTheme.focus_style()
	t.check(not focus.draw_center, "the focus ring does not paint over the control")
	t.check(
		focus.border_width_left > 0 and focus.border_width_top > 0,
		"the focus ring has border width on every side"
	)


## Focus is not a primary-button affordance: both variants must expose it.
func test_primary_and_secondary_buttons_both_focus(t) -> void:
	for primary in [true, false]:
		var control := OfficeTheme.button("Send", primary)
		t.check(
			control.focus_mode == Control.FOCUS_ALL,
			"a %s button can take keyboard focus" % ("primary" if primary else "secondary")
		)
		t.check(
			control.has_theme_stylebox_override("focus"),
			"a %s button overrides the focus style" % ("primary" if primary else "secondary")
		)
		control.free()


## The override must be genuinely different from the theme's default focus box,
## otherwise "focus visible" is only nominally true.
func test_button_exposes_the_overridden_focus_style(t) -> void:
	var control := OfficeTheme.button("Send", false)
	var overridden := control.get_theme_stylebox("focus")
	t.check(overridden != null, "the button resolves a focus stylebox")
	if overridden != null:
		t.check(
			overridden.border_color == OfficeTheme.accent(),
			"the button's focus ring uses the accent colour"
		)
	control.free()
