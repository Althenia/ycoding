## Layout design tests.
##
## The floor plan is a deliberate module, so these pin its structure rather than
## just its symptoms: the world proportions, the room/corridor bands, the divider
## alignment, the closed shell, and the doorway. A layout edit that breaks the
## module fails here with a specific reason instead of showing up as a visual
## glitch later.
extends RefCounted

const ROOM_ROWS := 9


func run(t) -> void:
	test_world_aspect_matches_the_window(t)
	test_zones_tile_the_floor_exactly(t)
	test_rooms_share_one_corridor(t)
	test_shell_is_closed(t)
	test_doorway_is_the_only_opening(t)
	test_door_art_spans_one_wall_module(t)
	test_corridor_is_clear_of_furniture(t)
	test_every_room_is_reachable(t)
	test_desk_order_matches_real_anchors(t)
	test_every_assignable_desk_is_placed_in_the_plan(t)
	test_floor_columns_exist_in_the_atlas_and_tileset(t)


## Every floor column a zone indexes must exist in BOTH the atlas texture and the
## TileSet. A tile the TileSet does not declare draws the empty default, which is
## a dark square: that is how the checker floor rendered dark while the atlas
## itself was correct.
func test_floor_columns_exist_in_the_atlas_and_tileset(t) -> void:
	var path := "res://office/art/tiles_floor.png"
	t.check(ResourceLoader.exists(path), "floor atlas exists")
	var atlas: Texture2D = load(path)
	var columns := int(atlas.get_width() / OfficeWorld.TILE)
	t.check(columns > 0, "floor atlas has columns")
	for zone in OfficeWorld.ZONES:
		var base: int = zone["floor"]
		t.check(OfficeWorld.FLOOR_TONES.has(base), "zone %s declares its tone count" % zone["id"])
		var tones: int = OfficeWorld.FLOOR_TONES.get(base, 2)
		t.check(tones >= 1, "zone %s has at least one tone" % zone["id"])
		t.check(
			base + tones <= columns,
			"zone %s columns %d-%d fit the %d-column atlas"
			% [zone["id"], base, base + tones - 1, columns]
		)
	var tile_set: TileSet = load("res://office/maps/hq/hq_tileset.tres")
	t.check(tile_set != null, "the tileset loads")
	if tile_set == null:
		return
	var source := tile_set.get_source(0) as TileSetAtlasSource
	t.check(source != null, "the tileset has an atlas source")
	if source == null:
		return
	for zone in OfficeWorld.ZONES:
		var base: int = zone["floor"]
		var tones: int = OfficeWorld.FLOOR_TONES.get(base, 2)
		for offset in tones:
			var column := base + offset
			t.check(
				source.has_tile(Vector2i(column, 0)),
				"column %d is declared in the tileset (zone %s)" % [column, zone["id"]]
			)


## The assignment preference order must only name anchors that exist, or an agent
## silently falls through to the visitor seat.
func test_desk_order_matches_real_anchors(t) -> void:
	for desk in OfficeWorld.DESK_ORDER:
		t.check(
			OfficeWorld.ANCHORS.has(desk),
			"desk order entry %s is a real anchor" % desk
		)
	t.check(
		OfficeWorld.ANCHORS.has("desk_ceo"),
		"the CEO desk is a real anchor"
	)


## The world aspect is chosen to match the window. Every common desktop window is
## 16:9, so a 16:9-ish world fills the frame instead of letterboxing, which is
## what drove the shape from 40x21 to 41x23.
func test_world_aspect_matches_the_window(t) -> void:
	var aspect := float(OfficeWorld.MAP_WIDTH) / float(OfficeWorld.MAP_HEIGHT)
	t.check(
		absf(aspect - 16.0 / 9.0) < 0.03,
		"world aspect %.3f is close to the 16:9 window %.3f" % [aspect, 16.0 / 9.0]
	)
	t.check(OfficeWorld.MAP_WIDTH > OfficeWorld.MAP_HEIGHT, "the plan is landscape")


## Zones must cover the floor area exactly: no gap between rooms and no two rooms
## claiming the same tile.
func test_zones_tile_the_floor_exactly(t) -> void:
	var covered := {}
	for zone in OfficeWorld.ZONES:
		var rect: Rect2i = zone["rect"]
		t.check(rect.size.x > 0 and rect.size.y > 0, "zone %s has area" % zone["id"])
		for y in range(rect.position.y, rect.position.y + rect.size.y):
			for x in range(rect.position.x, rect.position.x + rect.size.x):
				var cell := Vector2i(x, y)
				t.check(not covered.has(cell), "zone %s does not overlap another zone" % zone["id"])
				covered[cell] = zone["id"]


## Five working areas plus a two-part reception, split by one corridor.
func test_rooms_share_one_corridor(t) -> void:
	var rooms := []
	var corridors := []
	for zone in OfficeWorld.ZONES:
		var rect: Rect2i = zone["rect"]
		if str(zone["id"]) == "corridor":
			corridors.append(rect)
			continue
		rooms.append(zone)
	t.check(rooms.size() == 6, "the plan has five areas and a two-part reception")
	t.check(corridors.size() == 1, "the plan has one corridor")
	var corridor: Rect2i = corridors[0]
	t.check(
		corridor.position.y == OfficeWorld.CORRIDOR_TOP
		and corridor.size.y == OfficeWorld.CORRIDOR_BOTTOM - OfficeWorld.CORRIDOR_TOP + 1,
		"the corridor occupies the declared rows"
	)
	for zone in rooms:
		var rect: Rect2i = zone["rect"]
		t.check(rect.size.y == ROOM_ROWS, "zone %s is %d rows" % [zone["id"], ROOM_ROWS])
		# Every zone opens onto the corridor: none is landlocked.
		var touches := (
			rect.position.y + rect.size.y == OfficeWorld.CORRIDOR_TOP
			or rect.position.y == OfficeWorld.CORRIDOR_BOTTOM + 1
		)
		t.check(touches, "zone %s opens onto the corridor" % zone["id"])


## Reception is the west band the sidebar floats over. Nothing anchored may live
## there, or an always-open panel would hide a working agent.
func test_lobby_band_holds_no_anchors(t) -> void:
	var lobby_right := 0
	for zone in OfficeWorld.ZONES:
		if not str(zone["id"]).begins_with("reception"):
			continue
		var rect: Rect2i = zone["rect"]
		lobby_right = maxi(lobby_right, rect.position.x + rect.size.x - 1)
	t.check(lobby_right > 0, "the plan has a reception band")
	for desk_id in OfficeWorld.ANCHORS:
		var table: Dictionary = OfficeWorld.ANCHORS[desk_id]
		for which in table:
			var cell: Vector2i = table[which]
			t.check(
				cell.x > lobby_right,
				"anchor %s/%s sits east of the reception band" % [desk_id, which]
			)


## The shell must be solid all the way round, or an actor can walk off the floor.
func test_shell_is_closed(t) -> void:
	var world := OfficeWorld.new()
	world.setup(null)
	var nav := world.navigation
	for x in OfficeWorld.MAP_WIDTH:
		t.check(nav.is_blocked(Vector2i(x, OfficeWorld.SOUTH_WALL)), "south wall %d is solid" % x)
	for y in OfficeWorld.MAP_HEIGHT:
		t.check(nav.is_blocked(Vector2i(0, y)), "west wall %d is solid" % y)
		t.check(
			nav.is_blocked(Vector2i(OfficeWorld.EAST_WALL, y)),
			"east wall %d is solid" % y
		)
	world.free()


## The doorway is the only way through the wall band.
func test_doorway_is_the_only_opening(t) -> void:
	var world := OfficeWorld.new()
	world.setup(null)
	var nav := world.navigation
	var door: Array = OfficeWorld.DOOR_COLS
	for x in OfficeWorld.MAP_WIDTH:
		# Rows 0-1 are the wall band; the door columns are the only gaps in it, and
		# the floor rows below must be open so the door leads somewhere.
		if door.has(x):
			t.check(not nav.is_blocked(Vector2i(x, 0)), "doorway column %d is open at row 0" % x)
			t.check(not nav.is_blocked(Vector2i(x, 1)), "doorway column %d is open at row 1" % x)
			t.check(
				not nav.is_blocked(Vector2i(x, OfficeWorld.WALL_BAND)),
				"doorway column %d opens onto the floor" % x
			)
			continue
		t.check(nav.is_blocked(Vector2i(x, 0)), "wall band %d is solid at row 0" % x)
		t.check(nav.is_blocked(Vector2i(x, 1)), "wall band %d is solid at row 1" % x)
	world.free()


## The wall art is laid out in 4-tile pieces and the doorway replaces exactly one
## of them, so the door sprite must be one module wide or the wall shows a gap.
func test_door_art_spans_one_wall_module(t) -> void:
	var path := "res://office/art/door_frame.png"
	t.check(ResourceLoader.exists(path), "door art exists")
	var texture: Texture2D = load(path)
	t.check(
		texture.get_width() == OfficeWorld.TILE * 4,
		"door art is one 4-tile wall module wide (%d px)" % (OfficeWorld.TILE * 4)
	)
	t.check(texture.get_height() > 0, "door art has height")


## The corridor is circulation: furniture there would block the only route
## between the room columns.
func test_corridor_is_clear_of_furniture(t) -> void:
	for item in OfficeWorld.FURNITURE:
		var cell: Vector2i = item["cell"]
		var footprint: Vector2i = OfficeWorld.PROP_FOOTPRINT.get(str(item["prop"]), Vector2i(1, 1))
		var intrudes := (
			cell.y <= OfficeWorld.CORRIDOR_BOTTOM
			and cell.y + footprint.y > OfficeWorld.CORRIDOR_TOP
		)
		t.check(not intrudes, "furniture %s stays out of the corridor" % item["id"])


## Each room must contain floor connected to the entrance. The check looks for
## any reachable cell rather than the geometric centre, because a room centre can
## legitimately be occupied by a table.
func test_every_room_is_reachable(t) -> void:
	var world := OfficeWorld.new()
	world.setup(null)
	var nav := world.navigation
	var entrance := nav.anchor_position("desk_prod_0", "work")
	var half := OfficeWorld.TILE * 0.5
	for zone in OfficeWorld.ZONES:
		if str(zone["id"]) == "corridor":
			continue
		var rect: Rect2i = zone["rect"]
		var connected := false
		for y in range(rect.position.y, rect.position.y + rect.size.y):
			for x in range(rect.position.x, rect.position.x + rect.size.x):
				var cell := Vector2i(x, y)
				if nav.is_blocked(cell):
					continue
				var point := Vector2(cell) * OfficeWorld.TILE + Vector2(half, half)
				if not nav.route(point, entrance).is_empty():
					connected = true
					break
			if connected:
				break
		t.check(connected, "room %s has floor connected to the entrance" % zone["id"])
	world.free()


## Every desk an actor can be assigned must exist in the plan. A desk name the
## plan does not place resolves to the navigation default cell instead of failing,
## so a wrong name silently parks an actor in a corner of the floor.
func test_every_assignable_desk_is_placed_in_the_plan(t) -> void:
	var placed := {}
	for item in OfficeWorld.FURNITURE:
		placed[str(item["id"])] = true
	t.check(
		placed.has(OfficeWorld.ROOT_DESK),
		"the root desk is a desk the plan actually places"
	)
	for desk in OfficeWorld.DESK_ORDER:
		t.check(placed.has(desk), "the desk %s is placed in the plan" % desk)

	# The default cell is what a missing desk falls back to, so the root desk must
	# resolve somewhere distinguishably different from it.
	var world := OfficeWorld.new()
	world.setup(null)
	var nav := world.navigation
	var root := nav.anchor_position(OfficeWorld.ROOT_DESK, "work")
	var missing := nav.anchor_position("a_desk_that_does_not_exist", "work")
	t.check(
		root != missing,
		"the root desk resolves to a real anchor, not the missing-desk default"
	)
	world.free()
