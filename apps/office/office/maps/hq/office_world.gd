## The office world.
##
## Renders a bright, zoned office with real depth: walls are tall boxes that cast
## a shadow band onto the floor, furniture is drawn as 3/4 boxes with lit tops and
## darker fronts, and everything solid is Y-sorted by its base line so actors pass
## correctly in front of and behind props.
class_name OfficeWorld
extends Node2D

const TILE := 32

## --- Layout design ---------------------------------------------------------
##
## One deliberate module: a 41x23 tile world (1312x736 px, aspect 1.783).
##
## The aspect is chosen to match the window. Every common desktop window is 16:9
## (1.778), so a 41x23 world fills 99.7% of it: the office really is full bleed
## in both dimensions. A 40x21 world was 1.905 and letterboxed about 30px at
## 1600x900.
##
##   rows  0-1   north wall band   (wall art and its mounted decoration)
##   rows  2-10  north rooms       (9 rows)
##   rows 11-12  central corridor  (2 rows; the only way between columns)
##   rows 13-21  south rooms       (9 rows)
##   row  22     south wall
##
##   col  0       west wall
##   cols 1-12    reception         (circulation; no anchors live here)
##   col  26      the only divider  (solid through both bands, open at the corridor)
##   cols 13-25   product (north) / engineering (south), west of the divider
##   cols 27-39   ops (north) / CEO (south), east of the divider
##   col  40      east wall
##
## Reception carries no anchors. It is the circulation band the doorway opens into, and
## the sidebar is a docked column rather than an overlay, so no anchor is hidden there -
## nothing routed to lives in a circulation area. Every anchor sits at row 16 or above,
## which keeps it clear of the floating composer that shares the office.
## test_shell_layout.gd proves both, and test_layout.gd proves the plan still hangs
## together.
##
## The doorway pierces the north wall band at cols 9-10. OfficeNavigation
## discovers the entrance as the first passable cell in the wall band rather than
## hardcoding it, so the two cannot disagree.
const MAP_WIDTH := 41
const MAP_HEIGHT := 23

## Room and corridor extents, in rows.
const WALL_BAND := 2
const CORRIDOR_TOP := 11
const CORRIDOR_BOTTOM := 12
const SOUTH_WALL := MAP_HEIGHT - 1
const EAST_WALL := MAP_WIDTH - 1

## Divider columns. Each divider is solid through both room bands and open at
## the corridor, so the corridor is the only route between columns.
const DIVIDERS := [26]

## The doorway pierces the north wall band at these columns.
const DOOR_COLS := [9, 10]

## Floor atlas columns from tools/generate_art.py.
##
## The atlas is 13 columns: 0-1 wood, 2-3 carpet A, 4-5 carpet B, 6-7 tile, a
## single 8 for concrete, 9-10 grey checker, a single 11 for cool plank and a
## single 12 for the light lounge floor.
##
## Tones vary per material, which is why the checkerboard below cannot simply add
## one to every base: indexing past a material's last tone would draw nothing at
## all. FLOOR_TONES is what keeps that honest, and test_layout.gd proves every
## indexed column exists.
const FLOOR_WOOD := 0
const FLOOR_CARPET_A := 2
const FLOOR_CARPET_B := 4
const FLOOR_TILE := 6
const FLOOR_CONCRETE := 8
const FLOOR_CHECKER := 9
const FLOOR_PLANK := 11
## The reference's light patterned lounge floor.
const FLOOR_LOUNGE := 12

## Tones per material, matching the atlas exactly.
const FLOOR_TONES := {
	FLOOR_WOOD: 2,
	FLOOR_CARPET_A: 2,
	FLOOR_CARPET_B: 2,
	FLOOR_TILE: 2,
	FLOOR_CONCRETE: 1,
	FLOOR_CHECKER: 2,
	FLOOR_PLANK: 1,
	FLOOR_LOUNGE: 1,
}

## The name shown over each zone.
##
## The reference labels its clusters with a floating tag, which is how a viewer
## learns the plan without a legend. Reception and the corridor are omitted: they
## are circulation, and labelling a walkway adds noise rather than meaning.
const ZONE_LABELS := {
	"product": "Product team",
	"ops": "Ops team",
	"engineering": "Engineering",
	"ceo": "CEO office",
}

## Room zones: id -> {rect (tiles), floor column}. The rects tile the floor
## exactly except along the divider column, where the CEO office wall stands;
## test_layout.gd enforces both.
const ZONES := [
	{"id": "reception_n", "rect": Rect2i(1, 2, 12, 9), "floor": FLOOR_TILE},
	{"id": "reception_s", "rect": Rect2i(1, 13, 12, 9), "floor": FLOOR_TILE},
	{"id": "corridor", "rect": Rect2i(1, 11, 39, 2), "floor": FLOOR_CONCRETE},
	{"id": "product", "rect": Rect2i(13, 2, 13, 9), "floor": FLOOR_CHECKER},
	{"id": "ops", "rect": Rect2i(27, 2, 13, 9), "floor": FLOOR_LOUNGE},
	{"id": "engineering", "rect": Rect2i(13, 13, 13, 9), "floor": FLOOR_CHECKER},
	{"id": "ceo", "rect": Rect2i(27, 13, 13, 9), "floor": FLOOR_CARPET_A},
]

## Furniture: grid cell, footprint, prop sprite. `solid` blocks navigation.
##
## Every cluster here exists because something sends an actor to it. Reception is
## circulation, the desks take working agents, the play room takes idle ones, the
## focus chair takes an agent consolidating context, the huddle table takes a
## question, and the CEO office receives reports.
const FURNITURE := [
	# --- Reception: cols 1-12, both bands. This is circulation: it is the band the
	# doorway opens into, so nothing anchored lives here and losing those columns
	# costs nothing real. ---
	{"id": "rec_rug_n", "cell": Vector2i(3, 4), "prop": "rug_warm", "solid": false},
	{"id": "rec_sofa_a", "cell": Vector2i(2, 3), "prop": "sofa", "solid": true},
	{"id": "rec_sofa_b", "cell": Vector2i(6, 3), "prop": "sofa", "solid": true},
	{"id": "rec_counter", "cell": Vector2i(2, 7), "prop": "counter", "solid": true},
	{"id": "rec_cooler", "cell": Vector2i(9, 3), "prop": "water_cooler", "solid": true},
	{"id": "rec_plant_a", "cell": Vector2i(1, 2), "prop": "plant", "solid": true},
	{"id": "rec_plant_b", "cell": Vector2i(11, 2), "prop": "plant", "solid": true},
	{"id": "rec_cabinet", "cell": Vector2i(11, 7), "prop": "filing_cabinet", "solid": true},
	{"id": "rec_fridge", "cell": Vector2i(11, 4), "prop": "fridge", "solid": true},
	{"id": "rec_vending", "cell": Vector2i(9, 7), "prop": "vending", "solid": true},
	{"id": "rec_rug_s", "cell": Vector2i(3, 15), "prop": "rug_blue", "solid": false},
	{"id": "rec_sofa_s", "cell": Vector2i(2, 15), "prop": "sofa", "solid": true},
	{"id": "rec_armchair", "cell": Vector2i(7, 15), "prop": "armchair", "solid": true},
	{"id": "rec_side", "cell": Vector2i(4, 18), "prop": "side_table", "solid": true},
	{"id": "rec_plant_c", "cell": Vector2i(1, 20), "prop": "plant", "solid": true},
	{"id": "rec_plant_d", "cell": Vector2i(11, 20), "prop": "plant", "solid": true},
	{"id": "rec_arcade", "cell": Vector2i(9, 17), "prop": "arcade", "solid": true},
	{"id": "rec_lockers", "cell": Vector2i(1, 17), "prop": "lockers", "solid": true},
	{"id": "rec_shelf", "cell": Vector2i(9, 17), "prop": "bookshelf", "solid": true},
	# --- Product team: cols 13-25, rows 2-5. Four desks; anchors sit on each desk base row. ---
	{"id": "desk_prod_0", "cell": Vector2i(13, 2), "prop": "desk", "solid": true},
	{"id": "chair_prod_0", "cell": Vector2i(14, 4), "prop": "chair", "solid": false},
	{"id": "desk_prod_1", "cell": Vector2i(16, 2), "prop": "desk", "solid": true},
	{"id": "chair_prod_1", "cell": Vector2i(17, 4), "prop": "chair", "solid": false},
	{"id": "desk_prod_2", "cell": Vector2i(19, 2), "prop": "desk", "solid": true},
	{"id": "chair_prod_2", "cell": Vector2i(20, 4), "prop": "chair", "solid": false},
	{"id": "desk_prod_3", "cell": Vector2i(22, 2), "prop": "desk", "solid": true},
	{"id": "chair_prod_3", "cell": Vector2i(23, 4), "prop": "chair", "solid": false},
	{"id": "plant_prod_0", "cell": Vector2i(13, 5), "prop": "plant", "solid": true},
	{"id": "plant_prod_1", "cell": Vector2i(16, 5), "prop": "plant", "solid": true},
	{"id": "plant_prod_2", "cell": Vector2i(19, 5), "prop": "plant", "solid": true},
	{"id": "plant_prod_3", "cell": Vector2i(22, 5), "prop": "plant", "solid": true},
	# --- Play room: cols 13-25, rows 6-10. Where idle agents go: ping-pong, sofas, a screen. ---
	{"id": "play_rug", "cell": Vector2i(13, 7), "prop": "rug_pink", "solid": false},
	{"id": "play_pingpong", "cell": Vector2i(13, 6), "prop": "pingpong", "solid": true},
	{"id": "play_sofa_a", "cell": Vector2i(18, 6), "prop": "sofa", "solid": true},
	{"id": "play_sofa_b", "cell": Vector2i(22, 6), "prop": "sofa", "solid": true},
	{"id": "play_tv", "cell": Vector2i(19, 10), "prop": "tv_stand", "solid": true},
	{"id": "play_plant", "cell": Vector2i(25, 6), "prop": "plant", "solid": true},
	{"id": "play_pouf_a", "cell": Vector2i(21, 6), "prop": "pouf", "solid": true},
	{"id": "play_pouf_b", "cell": Vector2i(25, 9), "prop": "pouf", "solid": true},
	{"id": "hud_round_table", "cell": Vector2i(30, 7), "prop": "round_table", "solid": true},
	# --- Focus: col 24-25, rows 7-8. Where an agent consolidating context retires to. ---
	{"id": "focus_rug", "cell": Vector2i(25, 8), "prop": "rug_warm", "solid": false},
	{"id": "focus_chair", "cell": Vector2i(25, 8), "prop": "reading_chair", "solid": false},
	{"id": "focus_side", "cell": Vector2i(24, 8), "prop": "side_table", "solid": true},
	{"id": "focus_lamp", "cell": Vector2i(25, 7), "prop": "lamp", "solid": true},
	# --- Ops team: cols 27-38, rows 2-10. Four desks plus the huddle board. ---
	{"id": "desk_ops_0", "cell": Vector2i(27, 2), "prop": "desk", "solid": true},
	{"id": "chair_ops_0", "cell": Vector2i(28, 4), "prop": "chair", "solid": false},
	{"id": "desk_ops_1", "cell": Vector2i(30, 2), "prop": "desk", "solid": true},
	{"id": "chair_ops_1", "cell": Vector2i(31, 4), "prop": "chair", "solid": false},
	{"id": "desk_ops_2", "cell": Vector2i(33, 2), "prop": "desk", "solid": true},
	{"id": "chair_ops_2", "cell": Vector2i(34, 4), "prop": "chair", "solid": false},
	{"id": "desk_ops_3", "cell": Vector2i(36, 2), "prop": "desk", "solid": true},
	{"id": "chair_ops_3", "cell": Vector2i(37, 4), "prop": "chair", "solid": false},
	{"id": "hud_whiteboard", "cell": Vector2i(28, 9), "prop": "whiteboard", "solid": true},
	{"id": "hud_rug", "cell": Vector2i(33, 7), "prop": "rug_checker", "solid": false},
	{"id": "hud_table", "cell": Vector2i(34, 7), "prop": "table", "solid": true},
	{"id": "hud_cabinet", "cell": Vector2i(38, 6), "prop": "filing_cabinet", "solid": true},
	{"id": "hud_plant", "cell": Vector2i(27, 6), "prop": "plant", "solid": true},
	# --- Engineering: cols 13-25, rows 13-17. Four desks plus storage. ---
	{"id": "desk_eng_0", "cell": Vector2i(13, 13), "prop": "desk", "solid": true},
	{"id": "chair_eng_0", "cell": Vector2i(14, 15), "prop": "chair", "solid": false},
	{"id": "desk_eng_1", "cell": Vector2i(16, 13), "prop": "desk", "solid": true},
	{"id": "chair_eng_1", "cell": Vector2i(17, 15), "prop": "chair", "solid": false},
	{"id": "desk_eng_2", "cell": Vector2i(19, 13), "prop": "desk", "solid": true},
	{"id": "chair_eng_2", "cell": Vector2i(20, 15), "prop": "chair", "solid": false},
	{"id": "desk_eng_3", "cell": Vector2i(22, 13), "prop": "desk", "solid": true},
	{"id": "chair_eng_3", "cell": Vector2i(23, 15), "prop": "chair", "solid": false},
	{"id": "eng_cabinet", "cell": Vector2i(25, 13), "prop": "filing_cabinet", "solid": true},
	{"id": "eng_plant", "cell": Vector2i(13, 16), "prop": "plant", "solid": true},
	{"id": "eng_plant_b", "cell": Vector2i(25, 20), "prop": "plant", "solid": true},
	{"id": "eng_racks", "cell": Vector2i(24, 17), "prop": "rack", "solid": true},
	# --- CEO office: cols 27-38, rows 13-19, walled at col 26. Subagents report back here. ---
	{"id": "desk_ceo", "cell": Vector2i(33, 13), "prop": "desk", "solid": false},
	{"id": "ceo_chair", "cell": Vector2i(34, 16), "prop": "chair", "solid": false},
	{"id": "ceo_aquarium", "cell": Vector2i(37, 13), "prop": "aquarium", "solid": true},
	{"id": "ceo_sofa", "cell": Vector2i(27, 18), "prop": "sofa", "solid": true},
	{"id": "ceo_side", "cell": Vector2i(30, 18), "prop": "side_table", "solid": true},
	{"id": "ceo_plant", "cell": Vector2i(38, 20), "prop": "plant", "solid": true},
	{"id": "ceo_rug", "cell": Vector2i(33, 17), "prop": "rug_warm", "solid": false},
]

## Mounted wall decoration, drawn on the north wall band above the wall art.
##
## Each entry is a tile column and a PROP_TEXTURES key, so decoration shares
## one registry and one naming scheme with floor props. Decoration never blocks
## navigation.
## Mounted wall decoration, drawn on the north wall band above the wall art.
##
## The reference runs glazing along its walls, so windows dominate here and the
## signage is dropped. Each entry is a tile column and a PROP_TEXTURES key, so
## decoration shares one registry with floor props.
const WALL_DECOR := [
	{"id": "decor_window_a", "x": 2, "prop": "window"},
	{"id": "decor_clock", "x": 6, "prop": "wall_clock"},
	{"id": "decor_window_b", "x": 8, "prop": "window"},
	{"id": "decor_screen", "x": 16, "prop": "wall_screen"},
	{"id": "decor_wall_tv", "x": 14, "prop": "wall_tv"},
	{"id": "decor_pinboard", "x": 20, "prop": "wall_pinboard"},
	{"id": "decor_window_c", "x": 24, "prop": "window"},
	{"id": "decor_poster", "x": 28, "prop": "wall_poster"},
	{"id": "decor_sign", "x": 34, "prop": "wall_sign"},
	{"id": "decor_art", "x": 26, "prop": "wall_frame_art"},
	{"id": "decor_window_d", "x": 31, "prop": "window"},
	{"id": "decor_window_e", "x": 36, "prop": "window"},
]

## Work/visitor anchors per prop.
##
## A work anchor sits at its desk's base row, so the seated actor's base line is
## at or below the desk base and Y-sorting draws them in front of it.
##
## Every anchor also sits east of the sidebar and above the composer, so no
## floating panel can hide a working agent at any supported window size.
const ANCHORS := {
	"desk_prod_0": {"work": Vector2i(14, 4), "visitor": Vector2i(14, 5)},
	"desk_prod_1": {"work": Vector2i(17, 4), "visitor": Vector2i(17, 5)},
	"desk_prod_2": {"work": Vector2i(20, 4), "visitor": Vector2i(20, 5)},
	"desk_prod_3": {"work": Vector2i(23, 4), "visitor": Vector2i(23, 5)},
	"desk_ops_0": {"work": Vector2i(28, 4), "visitor": Vector2i(28, 5)},
	"desk_ops_1": {"work": Vector2i(31, 4), "visitor": Vector2i(31, 5)},
	"desk_ops_2": {"work": Vector2i(34, 4), "visitor": Vector2i(34, 5)},
	"desk_ops_3": {"work": Vector2i(37, 4), "visitor": Vector2i(37, 5)},
	"desk_eng_0": {"work": Vector2i(14, 15), "visitor": Vector2i(14, 16)},
	"desk_eng_1": {"work": Vector2i(17, 15), "visitor": Vector2i(17, 16)},
	"desk_eng_2": {"work": Vector2i(20, 15), "visitor": Vector2i(20, 16)},
	"desk_eng_3": {"work": Vector2i(23, 15), "visitor": Vector2i(23, 16)},
	"desk_ceo": {"work": Vector2i(34, 15), "visitor": Vector2i(34, 16)},
	"play_pingpong": {"work": Vector2i(14, 8), "visitor": Vector2i(14, 9)},
	"play_sofa_a": {"work": Vector2i(19, 8), "visitor": Vector2i(19, 9)},
	"play_sofa_b": {"work": Vector2i(23, 8), "visitor": Vector2i(23, 9)},
	"play_tv": {"work": Vector2i(19, 11), "visitor": Vector2i(20, 11)},
	# The huddle props are the world's own meeting places, so they carry the MEETING
	# kind the acceptance names. It sits at the same cell as `work` on purpose: an
	# actor holding the anchor for a meeting stands exactly where it would to work,
	# and the kind distinguishes WHY the spot is claimed, not a second standing spot.
	"hud_table": {"work": Vector2i(34, 9), "visitor": Vector2i(35, 9), "meeting": Vector2i(34, 9)},
	"hud_whiteboard": {"work": Vector2i(29, 10), "visitor": Vector2i(30, 10), "meeting": Vector2i(29, 10)},
	"focus_side": {"work": Vector2i(24, 10), "visitor": Vector2i(25, 10)},
}



const PROP_TEXTURES := {
	"desk": "res://office/art/prop_desk.png",
	"chair": "res://office/art/prop_chair.png",
	"plant": "res://office/art/prop_plant.png",
	"sofa": "res://office/art/prop_sofa.png",
	"table": "res://office/art/prop_table.png",
	"whiteboard": "res://office/art/prop_whiteboard.png",
	"rug_blue": "res://office/art/prop_rug_blue.png",
	"rug_warm": "res://office/art/prop_rug_warm.png",
	"rug_pink": "res://office/art/prop_rug_pink.png",
	"window": "res://office/art/prop_window.png",
	"bookshelf": "res://office/art/prop_bookshelf.png",
	"pingpong": "res://office/art/prop_pingpong.png",
	"lamp": "res://office/art/prop_lamp.png",
	"aquarium": "res://office/art/prop_aquarium.png",
	"filing_cabinet": "res://office/art/prop_filing_cabinet.png",
	"water_cooler": "res://office/art/prop_water_cooler.png",
	"fridge": "res://office/art/prop_fridge.png",
	"tv_stand": "res://office/art/prop_tv_stand.png",
	"reading_chair": "res://office/art/prop_reading_chair.png",
	"rug_checker": "res://office/art/prop_rug_checker.png",
	"wall_poster": "res://office/art/wall_poster.png",
	"wall_clock": "res://office/art/wall_clock.png",
	"wall_sign": "res://office/art/wall_sign.png",
	"wall_screen": "res://office/art/wall_screen.png",
	"wall_pinboard": "res://office/art/wall_pinboard.png",
	"wall_frame_art": "res://office/art/wall_frame_art.png",
	"rack": "res://office/art/prop_rack.png",
	"vending": "res://office/art/prop_vending.png",
	"armchair": "res://office/art/prop_armchair.png",
	"counter": "res://office/art/prop_counter.png",
	"arcade": "res://office/art/prop_arcade.png",
	"lockers": "res://office/art/prop_lockers.png",
	"wall_tv": "res://office/art/prop_wall_tv.png",
	"pouf": "res://office/art/prop_pouf.png",
	"round_table": "res://office/art/prop_round_table.png",
	"side_table": "res://office/art/prop_side_table.png",
}

## Prop footprint in tiles, used for routing blockers and anchor placement.
const PROP_FOOTPRINT := {
	"desk": Vector2i(3, 2),
	"chair": Vector2i(1, 1),
	"plant": Vector2i(1, 1),
	"sofa": Vector2i(3, 2),
	"table": Vector2i(2, 2),
	"whiteboard": Vector2i(3, 1),
	"rug_blue": Vector2i(3, 2),
	"rug_warm": Vector2i(3, 2),
	"rug_pink": Vector2i(3, 2),
	"window": Vector2i(2, 1),
	"bookshelf": Vector2i(2, 2),
	"pingpong": Vector2i(3, 2),
	"lamp": Vector2i(1, 1),
	"aquarium": Vector2i(2, 1),
	"filing_cabinet": Vector2i(1, 2),
	"water_cooler": Vector2i(1, 1),
	"fridge": Vector2i(1, 2),
	"tv_stand": Vector2i(3, 1),
	"reading_chair": Vector2i(1, 1),
	"rug_checker": Vector2i(3, 2),
	"rack": Vector2i(1, 3),
	"vending": Vector2i(1, 2),
	"armchair": Vector2i(1, 2),
	"counter": Vector2i(3, 2),
	"arcade": Vector2i(1, 2),
	"lockers": Vector2i(2, 2),
	"pouf": Vector2i(1, 1),
	"round_table": Vector2i(1, 1),
	"side_table": Vector2i(1, 1),
}

var navigation: OfficeNavigation
var actors: Dictionary = {}
## The presentation preference shared with the composition root. Assigned before
## an actor spawns so a new arrival never animates once and then stops.
var motion: Motion = Motion.new()
var notices: Dictionary = {}
var _selected: String = ""
var _assignments: Dictionary = {}
var _floor: TileMapLayer
var _props: Node2D
var _overlay: OfficeOverlay
var _walls: Node2D


func setup(_viewport: OfficeViewport) -> void:
	navigation = OfficeNavigation.new()
	navigation.build(MAP_WIDTH, MAP_HEIGHT, _blockers(), ANCHORS)
	_build_tiles()
	_build_props()
	_build_walls()
	# Bubbles and glyphs live on their own node added last, so they always draw
	# above the Y-sorted furniture and actors.
	# Bubbles, glyphs and the selection highlight are signals, not scenery: they
	# must sit above the floor, the walls and the Y-sorted furniture. Setting the
	# layer explicitly is required because the wall and prop layers raise their
	# own z_index, which overrides sibling draw order.
	_overlay = OfficeOverlay.new()
	_overlay.name = "Overlay"
	_overlay.world = self
	_overlay.z_index = 3
	add_child(_overlay)
	queue_redraw()


## Routable blockers: the building shell, both divider columns, and each solid
## prop's real footprint.
##
## The layout owns this plan; OfficeNavigation only rasterizes it, so there is
## one authority for where solid geometry is.
func _blockers() -> Array:
	var list: Array = []
	for item in FURNITURE:
		if not bool(item.get("solid", false)):
			continue
		var footprint: Vector2i = PROP_FOOTPRINT.get(str(item["prop"]), Vector2i(1, 1))
		list.append({"id": item["id"], "cell": item["cell"], "size": footprint, "blocking": true})
	# The shell. Rows 0-1 are the north wall band and are interrupted only by the
	# doorway, which is what makes the doorway penetrable from outside.
	for y in range(WALL_BAND + 1):
		for x in MAP_WIDTH:
			if DOOR_COLS.has(x):
				continue
			list.append({"id": "shell_%d_%d" % [x, y], "cell": Vector2i(x, y), "size": Vector2i(1, 1), "blocking": true})
	for y in range(WALL_BAND, MAP_HEIGHT):
		list.append({"id": "shell_w%d" % y, "cell": Vector2i(0, y), "size": Vector2i(1, 1), "blocking": true})
		list.append({"id": "shell_e%d" % y, "cell": Vector2i(EAST_WALL, y), "size": Vector2i(1, 1), "blocking": true})
	for x in MAP_WIDTH:
		list.append({"id": "shell_s%d" % x, "cell": Vector2i(x, SOUTH_WALL), "size": Vector2i(1, 1), "blocking": true})
	# Dividers: solid through both room bands, open across the corridor.
	for x in DIVIDERS:
		list.append({"id": "divider_n_%d" % x, "cell": Vector2i(x, WALL_BAND), "size": Vector2i(1, CORRIDOR_TOP - WALL_BAND), "blocking": true})
		list.append({"id": "divider_s_%d" % x, "cell": Vector2i(x, CORRIDOR_BOTTOM + 1), "size": Vector2i(1, SOUTH_WALL - CORRIDOR_BOTTOM - 1), "blocking": true})
	return list


## Floors are drawn per zone with the material that zone uses, so the plan reads
## as furnished rooms rather than one flat plane. Rows 0-1 are the wall band: the
## north wall art covers them and casts its shadow onto the floor below.
func _build_tiles() -> void:
	_floor = TileMapLayer.new()
	_floor.name = "Floor"
	_floor.tile_set = load("res://office/maps/hq/hq_tileset.tres")
	add_child(_floor)
	move_child(_floor, 0)
	# The shell band sits underneath the north wall art.
	for x in MAP_WIDTH:
		for y in range(WALL_BAND):
			_floor.set_cell(Vector2i(x, y), 0, Vector2i(FLOOR_CONCRETE, 0))
	for y in range(WALL_BAND, MAP_HEIGHT):
		for x in MAP_WIDTH:
			_floor.set_cell(Vector2i(x, y), 0, Vector2i(FLOOR_CONCRETE, 0))
	for zone in ZONES:
		var rect: Rect2i = zone["rect"]
		var base: int = zone["floor"]
		var tones: int = FLOOR_TONES.get(base, 2)
		for y in range(maxi(rect.position.y, WALL_BAND), rect.position.y + rect.size.y):
			for x in range(rect.position.x, rect.position.x + rect.size.x):
				# Alternate the material's own tones for a woven surface.
				var column := base + ((x + y) % tones)
				_floor.set_cell(Vector2i(x, y), 0, Vector2i(column, 0))


## Props are individual sprites so each one depth-sorts by its base line.
func _build_props() -> void:
	_props = Node2D.new()
	_props.name = "Props"
	_props.y_sort_enabled = true
	# Above the wall band so furniture and actors draw over the wall's shadow.
	_props.z_index = 2
	add_child(_props)
	for item in FURNITURE:
		var path := str(PROP_TEXTURES.get(str(item["prop"]), ""))
		if path.is_empty() or not ResourceLoader.exists(path):
			continue
		var sprite := Sprite2D.new()
		sprite.name = str(item["id"])
		sprite.texture = load(path)
		var cell: Vector2i = item["cell"]
		var footprint: Vector2i = PROP_FOOTPRINT.get(str(item["prop"]), Vector2i(1, 1))
		# Foot origin: the prop's bottom edge rests on its footprint's last row.
		sprite.position = Vector2(
			cell.x * TILE + footprint.x * TILE * 0.5,
			(cell.y + footprint.y) * TILE
		)
		sprite.texture_filter = CanvasItem.TEXTURE_FILTER_NEAREST
		sprite.offset = Vector2(0, -sprite.texture.get_height() * 0.5)
		_props.add_child(sprite)


## Walls are drawn as one node above the floor so their cast shadows land on it.
##
## The south wall is deliberately absent: the near walls are cut away so the
## floor plan stays readable, which is the same convention the reference art
## uses. Only the far (north) wall and the two dividers are built.
func _build_walls() -> void:
	_walls = Node2D.new()
	_walls.name = "Walls"
	# Walls are architecture: they draw above the floor and below actors, so a
	# character standing on the top room row still renders in front of the wall.
	_walls.z_index = 1
	add_child(_walls)
	var top: Texture2D = load("res://office/art/wall_top.png")
	var side: Texture2D = load("res://office/art/wall_side.png")
	var door: Texture2D = load("res://office/art/door_frame.png")
	# Wall art reads cap -> face -> cast shadow downward (56 px tall), so its top
	# edge sits at y = 0 and the cast shadow lands on the wall band.
	var wall_h := top.get_height()
	var door_center := (DOOR_COLS[0] + DOOR_COLS[1] + 1) * 0.5 * TILE
	var door_span := Rect2(
		door_center - door.get_width() * 0.5, 0.0, door.get_width(), wall_h
	)
	# The north wall runs the full width. Wall pieces are 4 tiles wide, so the
	# piece behind the doorway is skipped and the door art supplies that segment
	# instead, including its own wall either side of the opening.
	for x in range(0, MAP_WIDTH, 4):
		var piece := Rect2(x * TILE, 0.0, TILE * 4, wall_h)
		if piece.intersects(door_span):
			continue
		var sprite := Sprite2D.new()
		sprite.texture = top
		sprite.position = Vector2(x * TILE + TILE * 2, wall_h * 0.5)
		sprite.texture_filter = CanvasItem.TEXTURE_FILTER_NEAREST
		_walls.add_child(sprite)
	var doorway := Sprite2D.new()
	doorway.texture = door
	doorway.position = Vector2(door_center, wall_h * 0.5)
	doorway.texture_filter = CanvasItem.TEXTURE_FILTER_NEAREST
	_walls.add_child(doorway)
	# Dividers run the two room bands and stop either side of the corridor, which
	# mirrors the divider blockers exactly so the art never covers a walkable row.
	for x in DIVIDERS:
		for run in [
			Vector2i(WALL_BAND, CORRIDOR_TOP),
			Vector2i(CORRIDOR_BOTTOM + 1, SOUTH_WALL),
		]:
			for y in range(run.x, run.y, 2):
				var sprite := Sprite2D.new()
				sprite.texture = side
				sprite.position = Vector2(x * TILE - side.get_width() * 0.5, y * TILE + TILE)
				sprite.texture_filter = CanvasItem.TEXTURE_FILTER_NEAREST
				_walls.add_child(sprite)
	_build_wall_decor()


## Mounted decoration sits on the north wall face, above the wall art but below
## the furniture layer, and never blocks navigation. Missing art is skipped so a
## new decoration can be specified before its sprite exists.
func _build_wall_decor() -> void:
	const FACE_CENTER := 28.0
	for entry in WALL_DECOR:
		var path := str(PROP_TEXTURES.get(str(entry["prop"]), ""))
		if path.is_empty() or not ResourceLoader.exists(path):
			continue
		var texture: Texture2D = load(path)
		var sprite := Sprite2D.new()
		sprite.name = str(entry["id"])
		sprite.texture = texture
		sprite.position = Vector2(int(entry["x"]) * TILE + texture.get_width() * 0.5, FACE_CENTER)
		sprite.texture_filter = CanvasItem.TEXTURE_FILTER_NEAREST
		_walls.add_child(sprite)


func refresh(store: OfficeStore) -> void:
	for actor in store.actor_list():
		var session_id: String = actor.identity.session_id
		if not actors.has(session_id):
			_add_actor(actor)
			continue
		var existing := actors.get(session_id) as OfficeActor
		if existing != null:
			existing.update_from(actor, _anchor_for(actor))
	_refresh_overlay()


func _anchor_for(actor: ActorPresentation) -> Vector2:
	var slot: Variant = _assignments.get(actor.identity.session_id)
	if slot == null:
		slot = _next_slot(actor)
		_assignments[actor.identity.session_id] = slot
	return navigation.anchor_position(str(slot["desk"]), str(slot["anchor"]))


## The desk the root session occupies. It must name a desk the plan actually
## places, or navigation falls back to a default cell.
const ROOT_DESK := "desk_ceo"

## Deterministic desk assignment: repeated agents get distinct desks.
## Named station groups. The director routes by intent; the layout decides where
## that intent physically is, so a plan change never rewrites behaviour.
const STATIONS := {
	"play": ["play_pingpong", "play_sofa_a", "play_sofa_b", "play_tv"],
	"focus": ["focus_side"],
	"huddle": ["hud_table", "hud_whiteboard"],
	"ceo": ["desk_ceo"],
}


## The anchor position for a named station, or the origin when unknown.
## Whether the prop layer sorts by Y, which is the mechanism that keeps a seated
## actor in front of the prop it sits at. Exposed so the depth rule can be asserted
## without a test reaching into a private node.
func prop_sort_enabled() -> bool:
	return _props != null and _props.y_sort_enabled


func station_position(station: String, which: String = "work") -> Vector2:
	var group: Array = STATIONS.get(station, [])
	for desk_id in group:
		if ANCHORS.has(desk_id):
			return navigation.anchor_position(str(desk_id), which)
	return Vector2.ZERO


## Preference order for assigning an agent to a desk, after the lead office.
## Every id here must be a real anchor; test_layout.gd enforces that, so the
## order cannot drift away from the plan.
const DESK_ORDER := [
	"desk_prod_0", "desk_prod_1", "desk_prod_2", "desk_prod_3",
	"desk_ops_0", "desk_ops_1", "desk_ops_2", "desk_ops_3",
	"desk_eng_0", "desk_eng_1", "desk_eng_2", "desk_eng_3",
]

func _next_slot(actor: ActorPresentation) -> Dictionary:
	var used := {}
	for slot in _assignments.values():
		used[slot["desk"]] = true
	# The root session leads, and the plan gives the lead the CEO office. Naming a
	# desk that is not in the plan resolves to the navigation default cell, which
	# put the lead in a corner rather than in the office.
	if actor.identity.is_root():
		return {"desk": ROOT_DESK, "anchor": "work"}
	for desk in DESK_ORDER:
		if not used.has(desk):
			return {"desk": desk, "anchor": "work"}
	# Past the desks, an actor visits rather than being given a desk that does not
	# exist. Sharing a station is honest; inventing one is not.
	return {"desk": DESK_ORDER[0], "anchor": "visitor"}


func _add_actor(actor: ActorPresentation) -> void:
	var node := OfficeActor.new()
	# Actors join the Y-sorted props layer so furniture and people interleave by
	# their base line instead of drawing in two fixed passes.
	_props.add_child(node)
	node.motion = motion
	node.update_from(actor, _anchor_for(actor))
	actors[actor.identity.session_id] = node


## The room name for an actor, shown in the inspector.
func zone_for(session_id: String) -> String:
	var desk := desk_id_for(session_id)
	for item in FURNITURE:
		if str(item["id"]) != desk:
			continue
		var cell: Vector2i = item["cell"]
		for zone in ZONES:
			if (zone["rect"] as Rect2i).has_point(cell):
				return str(zone["id"])
	return "office"


## The engineering carpet is one region rather than per-tile fills, so it reads
## as a single rug instead of a grid. Everything above it lives in OfficeOverlay.
func _draw() -> void:
	pass


func selected_session_id() -> String:
	return _selected


func _refresh_overlay() -> void:
	queue_redraw()
	if _overlay != null:
		_overlay.queue_redraw()


## Move an actor to wherever its work now puts it.
##
## A working agent sits at its desk, except while consolidating context, when it
## retires to the focus chair. Idle agents go to the play room. The route is
## recomputed from the CURRENT position, so a preempted actor resumes from where
## it actually is rather than teleporting.
func apply_work_state(actor: ActorPresentation) -> void:
	var node := actors.get(actor.identity.session_id) as OfficeActor
	if node == null:
		return
	var target := _station_target(actor)
	node.set_route(navigation.route(node.position, target))
	node.update_from(actor, target)
	_refresh_overlay()


## Send an actor to a named station. Used by ambient behaviour and by reporting.
func apply_station(actor: ActorPresentation, station: String, which: String = "work") -> void:
	var node := actors.get(actor.identity.session_id) as OfficeActor
	if node == null:
		return
	var target := station_position(station, which)
	if target == Vector2.ZERO:
		return
	node.set_route(navigation.route(node.position, target))
	_refresh_overlay()


## Send a finished subagent to report to whoever it worked for.
##
## This is cosmetic movement only. The report's content is a source-backed
## interaction recorded from `session.task.updated`; the walk adds no words.
func apply_report(actor: ActorPresentation) -> void:
	var node := actors.get(actor.identity.session_id) as OfficeActor
	if node == null:
		return
	var target := station_position("ceo", "visitor")
	if target == Vector2.ZERO:
		return
	node.set_route(navigation.route(node.position, target))
	_refresh_overlay()


## Where this actor belongs right now, by work state and presence.
func _station_target(actor: ActorPresentation) -> Vector2:
	match actor.presence:
		"focus":
			var focus := station_position("focus", "work")
			if focus != Vector2.ZERO:
				return focus
		"play":
			var play := station_position("play", "work")
			if play != Vector2.ZERO:
				return play
	return _anchor_for(actor)


func apply_ambient(actor: ActorPresentation, kind: String) -> void:
	var node := actors.get(actor.identity.session_id) as OfficeActor
	if node == null:
		return
	node.set_ambient(kind)
	# Every ambient option names a real station. An option with no destination
	# would be an action that does nothing, which is what "stretch" and "read"
	# silently were before the stations existed.
	match kind:
		"read":
			apply_station(actor, "focus", "work")
		"stretch":
			apply_station(actor, "play", "visitor")
		_:
			# "pause" is the one option whose behaviour is to stay put.
			_refresh_overlay()


func show_notice(actor: ActorPresentation, text: String) -> void:
	notices[actor.identity.session_id] = text
	_refresh_overlay()


func clear_notice(session_id: String) -> void:
	notices.erase(session_id)
	_refresh_overlay()


## The actor whose clickable bounds contain a world-space point, or "".
##
## Bounds cover the sprite column and, when the actor has a notice, the bubble
## above it. Later actors win ties so the visually front-most one is selected,
## matching what the user sees in the Y-sorted layer.
func actor_at(point: Vector2) -> String:
	var found := ""
	for session_id in actors:
		var node := actors[session_id] as OfficeActor
		if node == null:
			continue
		if _actor_bounds(node, str(session_id)).has_point(point):
			found = str(session_id)
	return found


## Clickable bounds for one actor: its sprite footprint plus its notice bubble.
func _actor_bounds(node: OfficeActor, session_id: String) -> Rect2:
	var half := OfficeActor.FRAME_W * 0.5
	var top := node.position.y - OfficeActor.FRAME_H
	var bounds := Rect2(
		Vector2(node.position.x - half, top),
		Vector2(OfficeActor.FRAME_W, node.position.y - top)
	)
	if not notices.has(session_id):
		return bounds
	var bubble := OfficeOverlay.notice_box(
		ThemeDB.fallback_font, str(notices[session_id]), node.position
	)
	return bounds.merge(bubble)


func select_actor(session_id: String) -> void:
	_selected = session_id
	_refresh_overlay()


func desk_id_for(session_id: String) -> String:
	var slot: Variant = _assignments.get(session_id)
	return "" if slot == null else str(slot["desk"])
