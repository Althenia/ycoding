## Shell overlay design tests.
##
## The shell has no header: the office is full-bleed and the sidebar and composer
## float over it. These pin the arrangement and, importantly, the occlusion
## budget — floating chrome is allowed to cover the office, but not the things a
## user must be able to see.
extends RefCounted

## The world is 41x23 tiles.
const WORLD_ASPECT := 41.0 / 23.0
## Different panels of the office, so the design cannot only work at one size.
const WINDOWS: Array[Vector2] = [
	Vector2(1280, 720), Vector2(1600, 900), Vector2(1920, 1080),
	Vector2(1366, 768), Vector2(1024, 768), Vector2(2560, 1440), Vector2(1440, 700),
]
const REFERENCE_WINDOWS: Array[Vector2] = [Vector2(1280, 720), Vector2(1600, 900), Vector2(1920, 1080)]


func run(t) -> void:
	test_office_is_full_bleed(t)
	test_office_aspect_equals_the_world(t)
	test_office_fills_a_16_by_9_window(t)
	test_overlays_are_present_and_inside(t)
	test_sidebar_does_not_cover_the_office_centre(t)
	test_composer_is_centred_and_clear_of_the_sidebar(t)
	test_composer_never_covers_a_work_anchor(t)
	test_composer_never_covers_a_visitor_anchor(t)
	test_sidebar_never_covers_an_anchor(t)
	test_overlays_scale_across_windows(t)
	test_occlusion_maps_to_real_tiles(t)
	test_a_text_scale_grows_the_panels_that_carry_text(t)
	test_every_scale_fits_and_never_overlaps(t)
	test_the_composer_never_covers_the_sidebar_at_any_scale(t)


func _overlays(size: Vector2) -> Dictionary:
	return OfficeShellLayout.overlays(size)


## "Full bleed" means the office reaches whichever window edges its aspect allows
## and is centred in the window, with no reserved band for a header.
func test_office_is_full_bleed(t) -> void:
	for size: Vector2 in WINDOWS:
		var office := OfficeShellLayout.office_region(size)
		t.check(
			is_equal_approx(office.position.x + office.size.x * 0.5, size.x * 0.5),
			"the office is horizontally centred at %s" % size
		)
		t.check(
			is_equal_approx(office.position.y + office.size.y * 0.5, size.y * 0.5),
			"the office is vertically centred at %s" % size
		)
		t.check(
			office.size.x <= size.x + 0.01 and office.size.y <= size.y + 0.01,
			"the office fits the window at %s" % size
		)
		# It must actually touch two opposite edges, or it is not full bleed.
		var touches_h := is_equal_approx(office.size.x, size.x)
		var touches_v := is_equal_approx(office.size.y, size.y)
		t.check(touches_h or touches_v, "the office reaches the window edges at %s" % size)


## The region is shaped to the world's aspect, so the viewport never letterboxes
## inside it.
func test_office_aspect_equals_the_world(t) -> void:
	var target := OfficeShellLayout.office_aspect_target()
	t.check(
		absf(target - WORLD_ASPECT) < 0.001,
		"the layout targets the world aspect %.3f" % WORLD_ASPECT
	)
	for size: Vector2 in WINDOWS:
		var aspect := OfficeShellLayout.office_aspect(size)
		t.check(
			absf(aspect - target) < 0.01,
			"office aspect %.3f matches the world %.3f at %s" % [aspect, target, size]
		)


## The world aspect is chosen to match the common window, so the office fills
## nearly all of a 16:9 window rather than letterboxing. This is the requirement
## that drove the world from 40x21 to 41x23.
func test_office_fills_a_16_by_9_window(t) -> void:
	var size := Vector2(1600, 900)
	t.check(
		absf(size.x / size.y - 16.0 / 9.0) < 0.01,
		"the test window really is 16:9"
	)
	var office := OfficeShellLayout.office_region(size)
	var fill := (office.size.x * office.size.y) / (size.x * size.y)
	t.check(fill > 0.99, "the office fills %.1f%% of a 16:9 window" % (fill * 100.0))
	for reference: Vector2 in REFERENCE_WINDOWS:
		var rect := OfficeShellLayout.office_region(reference)
		var covered := (rect.size.x * rect.size.y) / (reference.x * reference.y)
		t.check(
			covered > 0.99,
			"the office fills %.1f%% of %s" % [covered * 100.0, reference]
		)


func test_overlays_are_present_and_inside(t) -> void:
	for size: Vector2 in WINDOWS:
		var overlays := _overlays(size)
		for name in OfficeShellLayout.OVERLAYS:
			t.check(overlays.has(name), "overlay %s exists at %s" % [name, size])
			var rect: Rect2 = overlays[name]
			t.check(
				rect.size.x > 0.0 and rect.size.y > 0.0,
				"overlay %s has area at %s" % [name, size]
			)
			t.check(
				rect.position.x >= -0.01 and rect.position.y >= -0.01
				and rect.position.x + rect.size.x <= size.x + 0.01
				and rect.position.y + rect.size.y <= size.y + 0.01,
				"overlay %s stays inside %s" % [name, size]
			)


## The sidebar covers the west edge, but the middle of the office — where the
## action is — must stay visible.
func test_sidebar_does_not_cover_the_office_centre(t) -> void:
	for size: Vector2 in WINDOWS:
		var sidebar: Rect2 = _overlays(size)["sidebar"]
		var centre := size * 0.5
		t.check(
			not sidebar.has_point(centre),
			"the sidebar leaves the window centre visible at %s" % size
		)
		t.check(
			is_equal_approx(sidebar.position.x, OfficeShellLayout.SIDEBAR_MARGIN),
			"the sidebar is flush to the left margin at %s" % size
		)


## The composer centres in the content area east of the sidebar, which is what
## keeps them from colliding on a narrow display.
func test_composer_is_centred_and_clear_of_the_sidebar(t) -> void:
	for size: Vector2 in WINDOWS:
		var overlays := _overlays(size)
		var composer: Rect2 = overlays["composer"]
		var sidebar: Rect2 = overlays["sidebar"]
		# The content area starts where the sidebar actually ends, not where its
		# designed width would put it: the sidebar takes a floor when the text scale
		# needs more room than the design allows.
		var content_x: float = sidebar.position.x + sidebar.size.x + OfficeShellLayout.GAP
		var content_w: float = size.x - content_x - OfficeShellLayout.SIDEBAR_MARGIN
		t.check(
			is_equal_approx(
				composer.position.x + composer.size.x * 0.5,
				content_x + content_w * 0.5
			),
			"the composer is centred in the content area at %s" % size
		)
		t.check(
			not composer.intersects(sidebar, false),
			"the composer does not touch the sidebar at %s" % size
		)
		t.check(
			composer.size.x >= OfficeShellLayout.COMPOSER_MIN_W - 0.01
			and composer.size.x <= OfficeShellLayout.COMPOSER_MAX_W + 0.01,
			"the composer width %.0f is within bounds at %s" % [composer.size.x, size]
		)
		t.check(
			composer.position.y + composer.size.y <= size.y - OfficeShellLayout.COMPOSER_BOTTOM + 0.01,
			"the composer sits above the bottom margin at %s" % size
		)
		t.check(
			composer.position.x >= content_x - 0.01
			and composer.position.x + composer.size.x <= size.x - OfficeShellLayout.SIDEBAR_MARGIN + 0.01,
			"the composer stays inside the content area at %s" % size
		)


## The chrome is deliberately sized down from a dominant column to a floating
## panel, and the composer from a slab to a slim bar.
func test_chrome_stays_a_minority_of_the_frame(t) -> void:
	for size: Vector2 in REFERENCE_WINDOWS:
		var sidebar: Rect2 = _overlays(size)["sidebar"]
		t.check(
			sidebar.size.x <= size.x * 0.26,
			"the sidebar takes %.1f%% of the frame at %s" % [sidebar.size.x / size.x * 100.0, size]
		)
		var composer: Rect2 = _overlays(size)["composer"]
		t.check(
			composer.size.y <= 100.0,
			"the composer is a slim bar (%.0f px) at %s" % [composer.size.y, size]
		)
		t.check(
			composer.size.x <= size.x * 0.45,
			"the composer takes %.1f%% of the frame width at %s" % [composer.size.x / size.x * 100.0, size]
		)


## The toggle cluster must be reachable and must not sit under another overlay,
## or a panel could be hidden with no way to bring it back.
func test_toggle_cluster_is_reachable(t) -> void:
	for size: Vector2 in WINDOWS:
		var overlays := _overlays(size)
		var toggles: Rect2 = overlays["toggles"]
		t.check(
			toggles.size.x > 0.0 and toggles.size.y > 0.0,
			"the toggle cluster has area at %s" % size
		)
		t.check(
			toggles.position.x >= 0.0 and toggles.position.y >= 0.0
			and toggles.position.x + toggles.size.x <= size.x + 0.01
			and toggles.position.y + toggles.size.y <= size.y + 0.01,
			"the toggle cluster stays inside the window at %s" % size
		)
		for other: String in OfficeShellLayout.HIDEABLE:
			t.check(
				not toggles.intersects(overlays[other], false),
				"the toggle cluster is not covered by %s at %s" % [other, size]
			)
		t.check(
			not OfficeShellLayout.HIDEABLE.has("toggles"),
			"the toggle cluster itself is never hideable"
		)


## Hiding a panel must actually stop it occluding the world, which is the point
## of the feature.
func test_hidden_overlays_occlude_nothing(t) -> void:
	var size := Vector2(1600, 900)
	var shown := OfficeShellLayout.occluded_tiles("sidebar", size, [])
	t.check(shown.size.x > 0, "a shown sidebar occludes tiles")
	var hidden := OfficeShellLayout.occluded_tiles("sidebar", size, ["sidebar"])
	t.check(hidden.size.x == 0 and hidden.size.y == 0, "a hidden sidebar occludes nothing")
	var both := OfficeShellLayout.occluded_tiles("composer", size, ["sidebar", "composer"])
	t.check(both.size.x == 0, "a hidden composer occludes nothing")
	t.check(
		OfficeShellLayout.occluded_tiles("nope", size, []).size.x == 0,
		"an unknown overlay occludes nothing"
	)


## With the panels hidden, nothing floating covers an anchor. That is the
## guarantee the hide feature buys.
func test_hidden_chrome_frees_every_anchor(t) -> void:
	for size: Vector2 in WINDOWS:
		for desk_id in OfficeWorld.ANCHORS:
			var table: Dictionary = OfficeWorld.ANCHORS[desk_id]
			for which in table:
				var cell: Vector2i = table[which]
				var hidden_by := ""
				for name: String in OfficeShellLayout.HIDEABLE:
					var rect := OfficeShellLayout.occluded_tiles(
						name, size, OfficeShellLayout.HIDEABLE
					)
					if rect.size.x > 0 and rect.has_point(cell):
						hidden_by = name
				t.check(
					hidden_by.is_empty(),
					"anchor %s/%s is visible with the chrome hidden at %s" % [desk_id, which, size]
				)


## A floating composer must not hide the desk a user is watching. Every work
## anchor is an actor's seat, so covering one hides a working agent.
func test_composer_never_covers_a_work_anchor(t) -> void:
	for size: Vector2 in WINDOWS:
		var hidden := OfficeShellLayout.occludes(_overlays(size)["composer"], size)
		for desk_id in OfficeWorld.ANCHORS:
			var work: Vector2i = (OfficeWorld.ANCHORS[desk_id] as Dictionary)["work"]
			t.check(
				not hidden.has_point(work),
				"the composer does not hide work anchor %s at %s" % [desk_id, size]
			)


## Visitor anchors are where conversations happen, so they must stay visible too.
func test_composer_never_covers_a_visitor_anchor(t) -> void:
	for size: Vector2 in WINDOWS:
		var hidden := OfficeShellLayout.occludes(_overlays(size)["composer"], size)
		for desk_id in OfficeWorld.ANCHORS:
			var visitor: Vector2i = (OfficeWorld.ANCHORS[desk_id] as Dictionary)["visitor"]
			t.check(
				not hidden.has_point(visitor),
				"the composer does not hide visitor anchor %s at %s" % [desk_id, size]
			)


## The sidebar is always open, so it must never hide an anchor either. This is
## why the plan keeps a west lobby band with nothing anchored in it.
func test_sidebar_never_covers_an_anchor(t) -> void:
	for size: Vector2 in WINDOWS:
		var hidden := OfficeShellLayout.occludes(_overlays(size)["sidebar"], size)
		for desk_id in OfficeWorld.ANCHORS:
			var table: Dictionary = OfficeWorld.ANCHORS[desk_id]
			for which in table:
				var cell: Vector2i = table[which]
				t.check(
					not hidden.has_point(cell),
					"the sidebar does not hide anchor %s/%s at %s" % [desk_id, which, size]
				)


## The arrangement must be proportional rather than tuned for one resolution.
func test_overlays_scale_across_windows(t) -> void:
	var previous := Vector2.ZERO
	for size: Vector2 in REFERENCE_WINDOWS:
		var office := OfficeShellLayout.office_region(size)
		t.check(office.size.x > previous.x, "the office grows with the window width")
		t.check(office.size.y > previous.y, "the office grows with the window height")
		previous = office.size


## The occlusion mapping must be exact, or the anchor tests above would be
## measuring the wrong thing. A region covering the whole window hides the whole
## world; a region outside it hides nothing.
func test_occlusion_maps_to_real_tiles(t) -> void:
	var size := Vector2(1600, 900)
	var everything := OfficeShellLayout.occludes(Rect2(Vector2.ZERO, size), size)
	t.check(
		everything.size.x >= OfficeWorld.MAP_WIDTH and everything.size.y >= OfficeWorld.MAP_HEIGHT,
		"a full-window overlay hides the whole map"
	)
	var outside := OfficeShellLayout.occludes(Rect2(Vector2(-400, -400), Vector2(10, 10)), size)
	t.check(
		outside.size.x == 0 or outside.size.y == 0,
		"an overlay outside the office hides no tiles"
	)
	# The sidebar must hide tiles on the west side, which is where it is drawn.
	var sidebar_hidden := OfficeShellLayout.occludes(_overlays(size)["sidebar"], size)
	t.check(sidebar_hidden.position.x <= 1, "the sidebar hides the west edge of the map")
	t.check(sidebar_hidden.size.x > 0, "the sidebar hides a non-empty column")


## A text scale grows the metrics that come from text, so a panel never becomes
## narrower than its own contents and clips them. The gutters stay fixed, because a
## gutter is spacing rather than content.
func test_a_text_scale_grows_the_panels_that_carry_text(t) -> void:
	var shell := Vector2(1600, 900)
	var base := OfficeShellLayout.overlays(shell, 1.0)
	var doubled := OfficeShellLayout.overlays(shell, 2.0)
	t.check(
		doubled["sidebar"].size.x > base["sidebar"].size.x,
		"the sidebar grows with the text scale"
	)
	t.check(
		doubled["sidebar"].size.x >= OfficeShellLayout.SIDEBAR_CONTENT_FLOOR * 2.0 - 0.5,
		"and is at least as wide as its contents need at 200%"
	)
	t.check(
		is_equal_approx(doubled["sidebar"].position.x, base["sidebar"].position.x),
		"the gutter does not grow with the text"
	)
	t.check(
		doubled["composer"].size.y > base["composer"].size.y,
		"the composer grows taller with the text"
	)
	t.check(
		doubled["composer"].size.x >= OfficeShellLayout.COMPOSER_CONTENT_FLOOR * 2.0 - 0.5
		or doubled["composer"].size.x >= shell.x
		- (OfficeShellLayout.SIDEBAR_MARGIN + doubled["sidebar"].size.x + OfficeShellLayout.GAP)
		- OfficeShellLayout.SIDEBAR_MARGIN - 0.5,
		"the composer is never narrower than its controls need"
	)


## At every supported scale, on every supported window, the overlays fit inside the
## window and the composer clears the sidebar. A panel that overflows or overlaps
## hides runtime state, which enlarging the interface must never cause.
func test_every_scale_fits_and_never_overlaps(t) -> void:
	for scale in UiScale.STEPS:
		for size in [Vector2(1280, 720), Vector2(1600, 900), Vector2(1920, 1080)]:
			var rects := OfficeShellLayout.overlays(size, scale)
			var sidebar: Rect2 = rects["sidebar"]
			var composer: Rect2 = rects["composer"]
			t.check(
				sidebar.position.x + sidebar.size.x <= size.x + 0.5,
				"the sidebar fits at %s x%.2f" % [str(size), scale]
			)
			t.check(
				composer.position.x + composer.size.x <= size.x + 0.5,
				"the composer fits at %s x%.2f" % [str(size), scale]
			)
			t.check(
				composer.position.x >= sidebar.position.x + sidebar.size.x - 0.5,
				"the composer clears the sidebar at %s x%.2f" % [str(size), scale]
			)


## The sidebar and the composer must never overlap: the composer would cover the
## rail it is meant to sit beside, hiding the roster at the scale where the user
## most needs to read it.
func test_the_composer_never_covers_the_sidebar_at_any_scale(t) -> void:
	for scale in UiScale.STEPS:
		for size in [Vector2(1280, 720), Vector2(1600, 900), Vector2(1024, 768)]:
			var logical: Vector2 = size / scale
			var rects := OfficeShellLayout.overlays(logical, scale)
			var sidebar: Rect2 = rects["sidebar"]
			var composer: Rect2 = rects["composer"]
			t.check(
				composer.position.x >= sidebar.position.x + sidebar.size.x - 0.5,
				"the composer clears the sidebar at %s x%.2f" % [str(size), scale]
			)
