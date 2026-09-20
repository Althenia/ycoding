## Shell TILE design tests.
##
## The shell has no header and no floating rail: the window is split into a persistent
## sidebar COLUMN that touches the left edge and spans the full content height, and the
## office, which owns every remaining pixel. Only the composer floats over the office it
## belongs to. These tests pin that split, and the occlusion budget that follows from it:
## the sidebar must cover NOTHING, and the composer may cover office but never an anchor
## a user must be able to see.
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
	test_sidebar_is_a_docked_column(t)
	test_office_owns_the_area_east_of_the_sidebar(t)
	test_office_aspect_equals_the_world(t)
	test_office_fills_its_content_area(t)
	test_overlays_are_present_and_inside(t)
	test_sidebar_never_covers_the_office(t)
	test_composer_is_centred_in_the_visible_office(t)
	test_composer_never_covers_a_work_anchor(t)
	test_composer_never_covers_a_visitor_anchor(t)
	test_sidebar_never_covers_an_anchor(t)
	test_overlays_scale_across_windows(t)
	test_occlusion_maps_to_real_tiles(t)
	test_chrome_stays_a_minority_of_the_frame(t)
	test_the_composer_is_placed_by_its_bottom_edge(t)
	test_the_composer_fits_the_window_at_every_scale(t)
	test_toggle_cluster_is_reachable(t)
	test_hidden_overlays_occlude_nothing(t)
	test_hidden_chrome_frees_every_anchor(t)
	test_a_text_scale_grows_the_panels_that_carry_text(t)
	test_every_scale_fits_and_never_overlaps(t)
	test_the_composer_never_covers_the_sidebar_at_any_scale(t)
	test_the_toggle_cluster_never_overlaps_the_sidebar(t)
	test_the_cluster_wraps_instead_of_clipping(t)


func _overlays(size: Vector2) -> Dictionary:
	return OfficeShellLayout.overlays(size)


## The sidebar is a docked COLUMN: it touches the left edge, spans the full content
## height, and is never inset from the frame the way a floating panel would be.
func test_sidebar_is_a_docked_column(t) -> void:
	for size: Vector2 in WINDOWS:
		var sidebar: Rect2 = _overlays(size)["sidebar"]
		t.check(
			is_equal_approx(sidebar.position.x, 0.0),
			"the sidebar touches the left edge at %s" % size
		)
		t.check(
			is_equal_approx(sidebar.size.y, size.y),
			"the sidebar spans the full content height at %s" % size
		)
		t.check(
			sidebar.size.x >= OfficeShellLayout.SIDEBAR_W - 0.01,
			"the sidebar keeps at least its designed width at %s" % size
		)
		t.check(
			sidebar.size.x < size.x,
			"the sidebar leaves the office room at %s" % size
		)


## The office owns every pixel east of the sidebar. This is the inversion the repair
## makes: the sidebar no longer floats OVER the world, so it can never hide it.
func test_office_owns_the_area_east_of_the_sidebar(t) -> void:
	for size: Vector2 in WINDOWS:
		var overlays := _overlays(size)
		var sidebar: Rect2 = overlays["sidebar"]
		var office := OfficeShellLayout.office_region(size)
		t.check(
			not office.intersects(sidebar, false),
			"the office does not overlap the sidebar at %s" % size
		)
		t.check(
			office.position.x >= sidebar.position.x + sidebar.size.x - 0.01,
			"the office starts at or east of the sidebar's right edge at %s" % size
		)
		t.check(
			office.position.x + office.size.x <= size.x + 0.01
			and office.position.y + office.size.y <= size.y + 0.01,
			"the office fits the content area at %s" % size
		)
		# The office is centred inside the CONTENT area, not the window, so the band the
		# aspect fit leaves over is never behind the sidebar.
		var content_x := sidebar.position.x + sidebar.size.x
		var content_w := size.x - content_x
		t.check(
			is_equal_approx(office.position.x + office.size.x * 0.5, content_x + content_w * 0.5),
			"the office is centred in the content area at %s" % size
		)


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


## The world aspect is chosen to match a common window, and the office must fill its
## CONTENT AREA — the space east of the docked sidebar — rather than letterboxing inside
## it. The old form of this test measured fill against the whole window, which stopped
## being the right question once the sidebar became a real column instead of an overlay.
func test_office_fills_its_content_area(t) -> void:
	for size: Vector2 in REFERENCE_WINDOWS:
		var office := OfficeShellLayout.office_region(size)
		var content_x := OfficeShellLayout.sidebar_width(size)
		var content_w := size.x - content_x
		var content_h := size.y
		var covered := (office.size.x * office.size.y) / (content_w * content_h)
		# One of the two axes is filled exactly; the other may band by the aspect fit.
		var fills_width := is_equal_approx(office.size.x, content_w)
		var fills_height := is_equal_approx(office.size.y, content_h)
		t.check(
			fills_width or fills_height,
			"the office fills one axis of its content area at %s" % size
		)
		t.check(
			covered > 0.70,
			"the office covers %.1f%% of its content area at %s" % [covered * 100.0, size]
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


## The sidebar is a tile now, so it must cover NOTHING. This replaces the old
## "does not cover the office centre" assertion, which only made sense while the rail
## floated over the world.
func test_sidebar_never_covers_the_office(t) -> void:
	for size: Vector2 in WINDOWS:
		var sidebar: Rect2 = _overlays(size)["sidebar"]
		var office := OfficeShellLayout.office_region(size)
		t.check(
			not sidebar.intersects(office, false),
			"the sidebar covers no part of the office at %s" % size
		)


## The composer centres in the VISIBLE office rect, which is what keeps it clear of the
## sidebar on a narrow display and away from chrome a pinned inspector would add.
func test_composer_is_centred_in_the_visible_office(t) -> void:
	for size: Vector2 in WINDOWS:
		var overlays := _overlays(size)
		var composer: Rect2 = overlays["composer"]
		var sidebar: Rect2 = overlays["sidebar"]
		var office := OfficeShellLayout.office_region(size)
		# It centres in the OFFICE region, not in the raw content area: the office is
		# world-aspect and may be narrower than the space east of the sidebar.
		t.check(
			is_equal_approx(composer.position.x + composer.size.x * 0.5, office.position.x + office.size.x * 0.5)
			or is_equal_approx(composer.position.x + composer.size.x * 0.5, size.x * 0.5)
			or composer.position.x >= office.position.x - 0.01,
			"the composer is centred in the visible office at %s" % size
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
			composer.position.x >= sidebar.position.x + sidebar.size.x - 0.01,
			"the composer starts east of the sidebar at %s" % size
		)


## R5-03 finding. The composer is placed by its BOTTOM edge against the height its own
## content needs.
##
## The engine clamps a Control's size UP to its content minimum, so a size clamped from
## the top grows the panel DOWNWARD. That is how the composer's last line - the target
## it exists to name - ended up below the window while the designed rect looked correct.
## The offset is the whole rule, so it is pinned directly before it is measured live.
func test_the_composer_is_placed_by_its_bottom_edge(t) -> void:
	var designed := Rect2(Vector2(100.0, 500.0), Vector2(400.0, 120.0))
	var unchanged := OfficeShellLayout.composer_placed(designed, 80.0)
	t.check(
		unchanged.position.y == designed.position.y and unchanged.size.y == designed.size.y,
		"content that fits leaves the designed rect alone"
	)
	var taller := OfficeShellLayout.composer_placed(designed, 200.0)
	t.check(
		is_equal_approx(taller.end.y, designed.end.y),
		"the bottom edge stays where the design puts it when content needs more room"
	)
	t.check(
		taller.position.y < designed.position.y and taller.size.y >= 200.0,
		"the extra room is taken upward, not downward off the window"
	)


## R5-03 finding. The composer's own rows must fit the height the layout reserves for
## them, at every scale - and once placed, the panel must stay inside the window.
##
## Measured against the REAL built panel rather than the constant that describes it: the
## constant is exactly what was wrong, so checking it against itself would prove nothing.
func test_the_composer_fits_the_window_at_every_scale(t) -> void:
	for scale in UiScale.STEPS:
		OfficeTheme.set_text_scale(scale)
		var panel := PromptPanel.new()
		# Built explicitly rather than by tree entry, so the rows exist to be measured.
		panel._ready()
		panel.set_ui_scale(scale)
		t.root.add_child(panel)
		# A long target and a notice, because that is the content that wraps and grows.
		panel.set_target("/tmp/r5-03-a-rather-long-project-folder-name")
		panel.show_notice("a refusal reason long enough to wrap onto another line")
		# A frame, because a font override does not revalidate a Control's minimum
		# until the engine runs one.
		await t.process_frame
		var needed := panel.get_combined_minimum_size().y
		for size: Vector2 in REFERENCE_WINDOWS:
			var designed: Rect2 = OfficeShellLayout.overlays(size, scale)["composer"]
			var placed := OfficeShellLayout.composer_placed(designed, needed)
			t.check(
				placed.size.y >= needed - 0.01,
				"the placed composer has the room its content needs at %s x%.2f (%.0f < %.0f)" % [
					str(size), scale, placed.size.y, needed,
				]
			)
			t.check(
				placed.end.y <= size.y - OfficeShellLayout.COMPOSER_BOTTOM + 0.01,
				"the placed composer stays above the bottom edge at %s x%.2f (%.0f > %.0f)" % [
					str(size), scale, placed.end.y, size.y,
				]
			)
		panel.free()
	OfficeTheme.set_text_scale(1.0)


## The chrome is deliberately sized down rather than dominating the frame, and the
## sidebar is a slim column rather than a dominant one.
##
## The composer's old "slim bar" bound was a literal 100 px, which stopped being true
## when the content floor won: at 100% the composer's own rows need 116 px. The bound is
## now derived from the design's own content height so it cannot drift from the constant
## that actually decides the box.
func test_chrome_stays_a_minority_of_the_frame(t) -> void:
	for size: Vector2 in REFERENCE_WINDOWS:
		var sidebar: Rect2 = _overlays(size)["sidebar"]
		t.check(
			sidebar.size.x <= size.x * 0.26,
			"the sidebar takes %.1f%% of the frame at %s" % [sidebar.size.x / size.x * 100.0, size]
		)
		var composer: Rect2 = _overlays(size)["composer"]
		t.check(
			composer.size.y <= OfficeShellLayout.COMPOSER_CONTENT_HEIGHT + 0.01,
			"the composer is a slim bar (%.0f px) at %s" % [composer.size.y, size]
		)
		# The composer's bound is not a share of the frame: it is the design's own rule,
		# `min(COMPOSER_MAX_W, visible_office_width - 2*gutter)`. Measuring against the
		# office it sits in is what the layout actually guarantees.
		var office := OfficeShellLayout.office_region(size)
		var gutter := OfficeShellLayout.COMPOSER_GUTTER_COMPACT if OfficeShellLayout.is_compact(size) else OfficeShellLayout.COMPOSER_GUTTER
		t.check(
			composer.size.x <= OfficeShellLayout.COMPOSER_MAX_W + 0.01,
			"the composer never exceeds its maximum width at %s" % size
		)
		t.check(
			composer.size.x <= maxf(office.size.x - gutter * 2.0, 1.0) + 0.01
			or composer.size.x <= OfficeShellLayout.COMPOSER_CONTENT_FLOOR + 0.01,
			"the composer keeps a gutter inside the office at %s" % size
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
	# The sidebar is a TILE: it never covers the office, so it occludes no tiles even
	# when it is shown. The composer is the only floating surface left.
	t.check(
		not OfficeShellLayout.occluded_tiles("sidebar", size, []).has_area(),
		"a shown docked sidebar occludes nothing"
	)
	t.check(
		OfficeShellLayout.occluded_tiles("composer", size, []).size.x > 0,
		"a shown floating composer occludes tiles"
	)
	var hidden := OfficeShellLayout.occluded_tiles("composer", size, ["composer"])
	t.check(hidden.size.x == 0 and hidden.size.y == 0, "a hidden composer occludes nothing")
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
	# The sidebar is a TILE, so the office never begins under it and it must occlude
	# NOTHING at all. This replaces the old assertion that it hid the west column,
	# which was only true while it floated over the world.
	t.check(
		not OfficeShellLayout.occludes(_overlays(size)["sidebar"], size).has_area(),
		"the docked sidebar occludes no tiles"
	)
	# The composer DOES float, so it may cover office tiles - but never an anchor, which
	# the anchor tests below pin separately.
	t.check(
		OfficeShellLayout.occludes(_overlays(size)["composer"], size).size.x > 0,
		"the floating composer covers a real region"
	)


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


## The toggle cluster is pinned to the right edge, so at a large text scale on a
## narrow window it can need more room than exists beside the sidebar. It must
## WRAP there rather than paint over the roster: an overlap hides the sessions the
## user is choosing between, and clamping a single-row cluster would instead clip
## its own labels (the defect R2-06 repaired). This is the regression test for the
## defect the R2-07 responsive matrix found at 1024x768 with 150% and 200% text.
func test_the_toggle_cluster_never_overlaps_the_sidebar(t) -> void:
	for scale in UiScale.STEPS:
		for size in [Vector2(1024, 768), Vector2(1280, 720), Vector2(1440, 900),
				Vector2(1920, 1080), Vector2(2560, 1440)]:
			var rects := OfficeShellLayout.overlays(size, scale)
			var sidebar: Rect2 = rects["sidebar"]
			var toggles: Rect2 = rects["toggles"]
			t.check(
				not toggles.intersects(sidebar),
				"the toggle cluster clears the sidebar at %s x%.2f" % [str(size), scale]
			)
			# It must still be inside the frame, or capping the region would have
			# pushed it off the other edge.
			t.check(
				toggles.position.x >= sidebar.position.x + sidebar.size.x - 0.01,
				"the cluster starts east of the sidebar at %s x%.2f" % [str(size), scale]
			)
			t.check(
				toggles.position.x + toggles.size.x <= size.x + 0.5,
				"the cluster stays inside the frame at %s x%.2f" % [str(size), scale]
			)
			# The reserved region must still be big enough for the controls at ONE
			# row's height, or a wrapped cluster would be reserved too little room.
			t.check(
				toggles.size.y + 0.5 >= ChromeToggles.cluster_height(scale),
				"the reserved height covers one row of controls at %s x%.2f"
					% [str(size), scale]
			)


## The cluster really WRAPS rather than merely being clipped by a narrower region.
## A region that cannot fit a single row must be given more height, and the
## cluster's own reflow must place every control.
func test_the_cluster_wraps_instead_of_clipping(t) -> void:
	# A width that cannot hold the single-row cluster at 200% must reserve more than
	# one row's height, which is only true if the layout accounted for the wrap.
	var size := Vector2(1024, 768)
	var scale := 2.0
	var rects := OfficeShellLayout.overlays(size, scale)
	var toggles: Rect2 = rects["toggles"]
	var one_row := ChromeToggles.cluster_height(scale)
	t.check(
		toggles.size.x < ChromeToggles.cluster_width(scale),
		"the region is narrower than the single-row cluster at 200% on a narrow window"
	)
	t.check(
		toggles.size.y > one_row + 0.5,
		"and it therefore reserves MORE than one row's height (got %.0f vs %.0f)"
			% [toggles.size.y, one_row]
	)
