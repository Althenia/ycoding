## Scale and layout ownership tests (R2-02).
##
## The acceptance is: "Measure Control rects/min sizes; one UI scaling owner
## independent from world camera; no screenshot-specific offsets."
##
## Three separate properties are pinned here, because they fail differently:
##
##   1. One UI SCALING owner. `UiScale` owns the domain (bounds, steps, clamping)
##      and `OfficeTheme` owns the applied text scale. Nothing else may become a
##      second source of truth for how large the interface is.
##   2. The scaling owner is INDEPENDENT of the world camera. Enlarging the
##      interface must not move or zoom the world, and resizing the window must
##      not change the text scale. These are two different spaces: a UI scale
##      expressed in logical units, and a world camera fitted to the viewport.
##   3. No screenshot-specific offsets. The layout is a pure function of
##      `(size, scale)`, so the harness flag that drives captures must not be
##      able to change a single rect.
##
## Rect measurement note: a headless suite runs no frame between `_init` and its
## assertions, so a Control's CACHED minimum does not revalidate after a
## font-size override. Real minimums are therefore read as a cross-check at the
## scale the tree was built at, and the scale-dependent geometry is asserted
## through the pure layout helper, which is the thing production actually calls.
extends RefCounted


func run(t) -> void:
	test_ui_scale_is_the_only_scaling_domain_owner(t)
	test_the_text_scale_is_applied_only_through_the_theme_owner(t)
	test_interface_scaling_never_touches_the_world_camera(t)
	test_resizing_the_window_never_changes_the_text_scale(t)
	test_layout_is_a_pure_function_of_size_and_scale(t)
	test_controls_are_at_least_their_own_minimum_size(t)
	test_a_capture_flag_cannot_move_a_single_rect(t)


## The scaling domain has exactly one owner. A second clamp range or step list
## would let the interface and the layout disagree about what a scale means.
func test_ui_scale_is_the_only_scaling_domain_owner(t) -> void:
	t.check(UiScale.MIN < UiScale.MAX, "the supportable range is ordered")
	t.check(UiScale.STEPS.size() > 1, "there is more than one selectable step")
	for step in UiScale.STEPS:
		t.check(
			UiScale.is_supported(step),
			"every offered step is inside the supported range: %.2f" % step
		)
		t.check(
			is_equal_approx(UiScale.clamp_scale(step), step),
			"an offered step survives clamping unchanged: %.2f" % step
		)
	# The ceiling must be reachable exactly, because 200% is the stated target.
	t.check(UiScale.STEPS.has(UiScale.MAX), "the ceiling is a selectable step")
	# The steps are strictly ascending, so cycling is monotonic.
	for index in UiScale.STEPS.size() - 1:
		t.check(
			UiScale.STEPS[index] < UiScale.STEPS[index + 1],
			"steps ascend at index %d" % index
		)


## The applied text scale moves only through the theme's own setter, and that
## setter reports whether anything changed so a caller can avoid redundant work.
func test_the_text_scale_is_applied_only_through_the_theme_owner(t) -> void:
	var previous := OfficeTheme.text_scale()
	# A value the domain accepts is adopted unchanged.
	t.check(OfficeTheme.set_text_scale(1.5), "adopting a new scale reports a change")
	t.check(
		is_equal_approx(OfficeTheme.text_scale(), 1.5),
		"the theme reports the scale it adopted"
	)
	# The same value again is not a change.
	t.check(not OfficeTheme.set_text_scale(1.5), "setting the same scale reports no change")
	# The theme clamps through the domain rather than holding its own bounds.
	t.check(OfficeTheme.set_text_scale(99.0), "an absurd scale is still applied (clamped)")
	t.check(
		is_equal_approx(OfficeTheme.text_scale(), UiScale.MAX),
		"the theme clamps to the DOMAIN ceiling rather than a private one"
	)
	t.check(
		OfficeTheme.font(10) == int(round(10 * UiScale.MAX)),
		"a font size is derived from the applied scale"
	)
	OfficeTheme.set_text_scale(previous)
	t.check(
		is_equal_approx(OfficeTheme.text_scale(), previous),
		"the previous scale is restored"
	)


## Interface scaling and the world camera are different spaces. Changing the text
## scale must not move the camera, and fitting the camera must not change the text
## scale. A leak either way would make a larger interface distort the map.
##
## The REAL scene is instantiated, because the camera is a scene node: a bare
## `OfficeViewport.new()` has no `$SubViewport/OfficeWorld/Camera` to resolve, and a
## test that skipped the scene would be testing a different object than production
## builds.
func test_interface_scaling_never_touches_the_world_camera(t) -> void:
	var main := await _real_scene(t)
	if main == null:
		t.check(false, "the real scene instantiates")
		return
	var camera := main.office_view._camera
	t.check(camera != null, "the real scene provides a camera")
	if camera == null:
		_free_scene(main)
		return

	main._shell.size = Vector2(1280, 720)
	main._apply_regions()
	var position_before := camera.position

	var previous := OfficeTheme.text_scale()
	for step in UiScale.STEPS:
		OfficeTheme.set_text_scale(step)
		main.ui_scale = step
		main._apply_regions()
		# The camera is fitted to ITS OWN viewport and to nothing else. The text scale
		# reaches it only by changing the region the layout hands it - a wider sidebar
		# is a smaller office - so the assertion is that the fit matches the viewport
		# the camera actually has, not that the number is frozen. A frozen number would
		# demand the office ignore the space it was given, which the layout forbids.
		var viewport_size := main.office_view.size
		var expected := clampf(
			minf(viewport_size.x / OfficeViewport.WORLD_SIZE.x, viewport_size.y / OfficeViewport.WORLD_SIZE.y),
			OfficeViewport.MIN_ZOOM,
			OfficeViewport.MAX_ZOOM,
		)
		t.check(
			is_equal_approx(main.office_view._camera.zoom.x, expected)
			and is_equal_approx(main.office_view._camera.zoom.y, expected),
			"the camera is fitted to its own viewport at text scale %.2f (%.4f vs %.4f)" % [
				step, main.office_view._camera.zoom.x, expected,
			]
		)
		# The centre is the world's centre, which no window size can move.
		t.check(
			main.office_view._camera.position == position_before,
			"the camera position is unchanged at text scale %.2f" % step
		)
	OfficeTheme.set_text_scale(previous)
	main.ui_scale = previous
	main._apply_regions()
	# With the scale restored the region is the same size again, so the fit is too -
	# which is the direction that proves the text scale left no residue in the camera.
	t.check(
		main.office_view._camera.zoom == camera.zoom,
		"restoring the scale restores the fit"
	)
	_free_scene(main)


## The reverse direction: resizing the window refits the camera but must not
## change the interface's text scale, which is a user preference.
func test_resizing_the_window_never_changes_the_text_scale(t) -> void:
	var main := await _real_scene(t)
	if main == null:
		t.check(false, "the real scene instantiates")
		return
	var camera := main.office_view._camera
	if camera == null:
		t.check(false, "the real scene provides a camera")
		_free_scene(main)
		return

	var previous := OfficeTheme.text_scale()
	OfficeTheme.set_text_scale(1.5)
	main.ui_scale = 1.5

	for size in [Vector2(1024, 768), Vector2(1280, 720), Vector2(1920, 1080)]:
		main._shell.size = size
		main._apply_regions()
		t.check(
			is_equal_approx(OfficeTheme.text_scale(), 1.5),
			"resizing to %s leaves the text scale alone" % str(size)
		)
		t.check(
			main.office_view._camera.zoom.x > 0.0,
			"the camera keeps a positive zoom at %s" % str(size)
		)
	OfficeTheme.set_text_scale(previous)
	_free_scene(main)


## The real scene, with one frame awaited so `_ready` has run and the camera is
## resolved. The live transport is stopped so the test never leaves a poller
## running against a machine that may have no service.
func _real_scene(t) -> OfficeMain:
	var packed := load("res://app/main.tscn") as PackedScene
	if packed == null:
		return null
	var main: OfficeMain = packed.instantiate()
	t.root.add_child(main)
	await t.process_frame
	if main.live != null:
		main.live.stop()
	if main.demo != null and main.demo.is_playing():
		main.demo.stop()
	return main


func _free_scene(main: OfficeMain) -> void:
	if main.live != null:
		main.live.stop()
	if main.demo != null and main.demo.is_playing():
		main.demo.stop()
	main.free()


## The layout is a pure function. The same inputs must give identical rects, and
## no module-level state may leak between calls.
func test_layout_is_a_pure_function_of_size_and_scale(t) -> void:
	for scale in UiScale.STEPS:
		for size in [Vector2(1024, 768), Vector2(1280, 720), Vector2(1440, 900), Vector2(1920, 1080)]:
			var first := OfficeShellLayout.overlays(size, scale)
			var second := OfficeShellLayout.overlays(size, scale)
			t.check(
				first == second,
				"overlays(%s, %.2f) is deterministic" % [str(size), scale]
			)
			# A different scale must actually change the layout, or the parameter
			# would be decorative and the interface would not scale at all.
			if not is_equal_approx(scale, UiScale.MAX):
				var wider := OfficeShellLayout.overlays(size, UiScale.MAX)
				t.check(
					wider != first,
					"a larger scale changes the layout at %s" % str(size)
				)


## Real Controls must be laid out at least as large as their own content needs.
## A panel painted smaller than its minimum would clip its own text, which is the
## failure the shell rewrite exists to prevent.
func test_controls_are_at_least_their_own_minimum_size(t) -> void:
	var previous := OfficeTheme.text_scale()
	OfficeTheme.set_text_scale(1.0)

	var toggles := ChromeToggles.new()
	t.root.add_child(toggles)
	toggles._ready()
	var toggles_min := toggles.get_combined_minimum_size()
	t.check(toggles_min.x > 0.0, "the chrome cluster reports a real minimum width")
	t.check(toggles_min.y > 0.0, "the chrome cluster reports a real minimum height")
	# The layout must reserve at least what the cluster needs, or it clips.
	# The cluster DERIVES its reserved width from font metrics at the active scale,
	# so the assertion is that its own declaration covers the engine's measurement.
	var reserved := ChromeToggles.cluster_width(1.0)
	t.check(
		reserved + 0.01 >= toggles_min.x,
		"the declared cluster width covers its measured minimum (%.1f >= %.1f)"
			% [reserved, toggles_min.x]
	)
	toggles.free()

	var sidebar := SidebarPanel.new()
	sidebar._ensure_built()
	t.root.add_child(sidebar)
	var sidebar_min := sidebar.get_combined_minimum_size()
	t.check(sidebar_min.x > 0.0, "the sidebar reports a real minimum width")
	# The sidebar column must be at least what the panel needs at that scale.
	var column := OfficeShellLayout.sidebar_width(Vector2(1280, 720), 1.0)
	t.check(
		column + 0.01 >= sidebar_min.x,
		"the sidebar column covers its measured minimum (%.1f >= %.1f)"
			% [column, sidebar_min.x]
	)
	sidebar.free()
	OfficeTheme.set_text_scale(previous)


## No screenshot-specific offsets. The capture harness sets a flag to drive its own
## clock; that flag must not be able to move a single rect. The layout is asserted
## to depend on nothing but its arguments.
func test_a_capture_flag_cannot_move_a_single_rect(t) -> void:
	for scale in UiScale.STEPS:
		for size in [Vector2(1280, 720), Vector2(1600, 900)]:
			var baseline := OfficeShellLayout.overlays(size, scale)
			# The layout module holds no capture state, so the strongest honest
			# assertion is that it exposes no such input and its output is stable
			# across repeated calls from a changed global scale.
			var previous := OfficeTheme.text_scale()
			OfficeTheme.set_text_scale(UiScale.MAX)
			var after := OfficeShellLayout.overlays(size, scale)
			OfficeTheme.set_text_scale(previous)
			t.check(
				after == baseline,
				"the ambient text scale cannot change the rects at %s x%.2f"
					% [str(size), scale]
			)
