## Text scale and palette tests (TASK-043).
##
## The acceptance is that light/dark panels and a 200% text scale work "without
## hiding runtime state". That is the property these pin: a mode or a scale must
## change how something looks, never whether it is present, and a scale outside
## what the shell can lay out must be clamped rather than honoured into a clipped
## panel.
extends RefCounted


func run(t) -> void:
	test_both_palette_modes_define_every_role(t)
	test_the_two_modes_actually_differ(t)
	test_a_light_surface_is_lighter_than_its_text(t)
	test_an_unknown_role_still_renders(t)
	test_an_unknown_mode_falls_back_rather_than_vanishing(t)
	test_a_toggle_cycles_between_the_modes(t)
	test_200_percent_is_reachable_exactly(t)
	test_a_scale_above_the_ceiling_is_clamped_not_honoured(t)
	test_a_corrupt_scale_still_yields_a_usable_interface(t)
	test_the_scale_cycles_rather_than_sticking(t)
	test_every_scale_step_is_inside_the_supported_range(t)


## --- palette ----------------------------------------------------------------

## A mode missing a role would leave some surface undefined, so both are complete.
func test_both_palette_modes_define_every_role(t) -> void:
	var roles := OfficePalette.roles()
	t.check(roles.size() > 0, "the palette declares roles")
	for mode in OfficePalette.modes():
		var table := OfficePalette.table(mode)
		for role in roles:
			t.check(
				table.has(role),
				"mode %s defines %s" % [mode, role]
			)


## A "light mode" that renders the same colours is not a mode.
func test_the_two_modes_actually_differ(t) -> void:
	var dark := OfficePalette.table(OfficePalette.MODE_DARK)
	var light := OfficePalette.table(OfficePalette.MODE_LIGHT)
	var differing := 0
	for role in OfficePalette.roles():
		if str(dark[role]) != str(light[role]):
			differing += 1
	t.check(
		differing == OfficePalette.roles().size(),
		"every role differs between the modes (%d of %d)" % [
			differing, OfficePalette.roles().size()
		]
	)


## The property that makes a mode readable: text contrasts with the surface it sits
## on. This is what an authored light mode has to satisfy and a mechanical
## inversion does not.
func test_a_light_surface_is_lighter_than_its_text(t) -> void:
	for mode in OfficePalette.modes():
		var surface := OfficePalette.color_of("bg_panel", mode)
		var text := OfficePalette.color_of("text", mode)
		var surface_luma := surface.get_luminance()
		var text_luma := text.get_luminance()
		var ratio := (
			(maxf(surface_luma, text_luma) + 0.05) / (minf(surface_luma, text_luma) + 0.05)
		)
		t.check(
			ratio >= 3.0,
			"in %s the text contrasts with its panel (ratio %.2f)" % [mode, ratio]
		)


## An unknown role must render legibly rather than transparently.
func test_an_unknown_role_still_renders(t) -> void:
	for mode in OfficePalette.modes():
		var colour := OfficePalette.color_of("a_role_that_does_not_exist", mode)
		t.check_equal(colour.a, 1.0, "an unknown role is opaque in %s" % mode)


func test_an_unknown_mode_falls_back_rather_than_vanishing(t) -> void:
	var colour := OfficePalette.color_of("text", "a_mode_that_does_not_exist")
	t.check_equal(colour.a, 1.0, "an unknown mode still yields an opaque colour")
	t.check(not OfficePalette.is_mode("a_mode_that_does_not_exist"), "and is not claimed")


func test_a_toggle_cycles_between_the_modes(t) -> void:
	t.check_equal(
		OfficePalette.next_mode(OfficePalette.MODE_DARK),
		OfficePalette.MODE_LIGHT,
		"dark toggles to light"
	)
	t.check_equal(
		OfficePalette.next_mode(OfficePalette.MODE_LIGHT),
		OfficePalette.MODE_DARK,
		"light toggles back to dark"
	)
	for mode in OfficePalette.modes():
		t.check(
			OfficePalette.is_mode(OfficePalette.next_mode(mode)),
			"the mode after %s is a real mode" % mode
		)


## --- scale ------------------------------------------------------------------

## 200% is the stated target, so it must be an exact step rather than a rounding of
## one.
func test_200_percent_is_reachable_exactly(t) -> void:
	t.check_equal(UiScale.MAX, 2.0, "the ceiling is 200%")
	t.check(UiScale.STEPS.has(2.0), "200% is a selectable step")
	t.check_equal(UiScale.clamp_scale(2.0), 2.0, "200% is honoured exactly")
	t.check(UiScale.is_supported(2.0), "200% is supported")


## Past the ceiling the shell's own minimum widths exceed a normal window, so a
## panel would be clipped — which hides runtime state instead of enlarging it. Such
## a scale is clamped, not honoured.
func test_a_scale_above_the_ceiling_is_clamped_not_honoured(t) -> void:
	t.check_equal(UiScale.clamp_scale(4.0), UiScale.MAX, "an over-scale is clamped to the ceiling")
	t.check(not UiScale.is_supported(4.0), "and is reported as unsupported")
	t.check_equal(UiScale.clamp_scale(0.2), UiScale.MIN, "an under-scale is clamped to the floor")
	t.check(not UiScale.is_supported(0.2), "and is reported as unsupported")


## A corrupt stored preference must still produce a usable interface rather than a
## zero or infinite scale that lays out nothing.
func test_a_corrupt_scale_still_yields_a_usable_interface(t) -> void:
	t.check_equal(UiScale.clamp_scale(NAN), UiScale.MIN, "NaN falls back to the default")
	t.check_equal(UiScale.clamp_scale(INF), UiScale.MIN, "infinity falls back to the default")
	t.check_equal(UiScale.clamp_scale(-INF), UiScale.MIN, "-infinity falls back to the default")
	for bad in [NAN, INF, 0.0, 99.0]:
		var safe := UiScale.clamp_scale(bad)
		t.check(
			safe >= UiScale.MIN and safe <= UiScale.MAX,
			"a corrupt scale of %s still lands in range" % str(bad)
		)


## The control cycles rather than sticking, so it is never a dead button at an end.
func test_the_scale_cycles_rather_than_sticking(t) -> void:
	var scale := UiScale.MIN
	var seen := {}
	for _step in UiScale.STEPS.size():
		seen[scale] = true
		scale = UiScale.next_scale(scale)
	t.check_equal(
		seen.size(),
		UiScale.STEPS.size(),
		"cycling visits every step before repeating"
	)
	t.check_equal(scale, UiScale.MIN, "and returns to the start")
	t.check_equal(
		UiScale.next_scale(UiScale.MAX),
		UiScale.MIN,
		"the ceiling wraps to the floor"
	)


func test_every_scale_step_is_inside_the_supported_range(t) -> void:
	t.check(UiScale.STEPS.size() >= 2, "there is more than one step to choose")
	for step in UiScale.STEPS:
		t.check(UiScale.is_supported(step), "step %s is supported" % str(step))
		t.check_equal(UiScale.clamp_scale(step), step, "step %s is not altered" % str(step))
	t.check_equal(
		UiScale.step_index(UiScale.MAX),
		UiScale.STEPS.size() - 1,
		"the ceiling sits on the last step"
	)
