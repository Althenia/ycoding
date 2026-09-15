## The office world.
##
## Renders a bright, zoned office with real depth: walls are tall boxes that cast
## a shadow band onto the floor, furniture is drawn as 3/4 boxes with lit tops and
## darker fronts, and everything solid is Y-sorted by its base line so actors pass
## correctly in front of and behind props.
class_name OfficeWorld
extends Node2D

const TILE := 32
const MAP_WIDTH := 34
const MAP_HEIGHT := 24

## Floor atlas columns from tools/generate_art.py (two tones per material).
const FLOOR_WOOD := 0
const FLOOR_CARPET_A := 2
const FLOOR_CARPET_B := 4
const FLOOR_TILE := 6
const FLOOR_CONCRETE := 8

## Room zones: id -> {rect (tiles), floor column, label}.
const ZONES := [
	{"id": "lead", "rect": Rect2i(1, 2, 9, 9), "floor": FLOOR_CARPET_A},
	{"id": "engineering", "rect": Rect2i(11, 2, 8, 12), "floor": FLOOR_CARPET_B},
	{"id": "lounge", "rect": Rect2i(20, 2, 13, 11), "floor": FLOOR_TILE},
	{"id": "meeting", "rect": Rect2i(1, 12, 9, 11), "floor": FLOOR_TILE},
	{"id": "break", "rect": Rect2i(11, 14, 8, 9), "floor": FLOOR_WOOD},
	{"id": "qa", "rect": Rect2i(20, 13, 13, 11), "floor": FLOOR_TILE},
]

## Furniture: grid cell, footprint, prop sprite. `solid` blocks navigation.
const FURNITURE := [
	# --- Lead office (rows 3-9) ---
	{"id": "rug_lead", "cell": Vector2i(2, 4), "prop": "rug_warm", "solid": false},
	{"id": "desk_lead", "cell": Vector2i(3, 5), "prop": "desk", "solid": true},
	{"id": "chair_lead", "cell": Vector2i(4, 8), "prop": "chair", "solid": false},
	{"id": "shelf_lead", "cell": Vector2i(7, 3), "prop": "shelf", "solid": true},
	{"id": "plant_lead", "cell": Vector2i(8, 8), "prop": "plant", "solid": true},
	{"id": "lamp_lead", "cell": Vector2i(2, 8), "prop": "lamp", "solid": true},
	# --- Engineering (rows 3-11) ---
	{"id": "rug_eng", "cell": Vector2i(11, 4), "prop": "rug_blue", "solid": false},
	{"id": "desk_backend", "cell": Vector2i(11, 4), "prop": "desk", "solid": true},
	{"id": "chair_backend", "cell": Vector2i(12, 7), "prop": "chair", "solid": false},
	{"id": "desk_frontend", "cell": Vector2i(15, 4), "prop": "desk", "solid": true},
	{"id": "chair_frontend", "cell": Vector2i(16, 7), "prop": "chair", "solid": false},
	{"id": "desk_qa_a", "cell": Vector2i(11, 9), "prop": "desk", "solid": true},
	{"id": "chair_qa_a", "cell": Vector2i(12, 12), "prop": "chair", "solid": false},
	{"id": "bookshelf_eng", "cell": Vector2i(18, 4), "prop": "bookshelf", "solid": true},
	{"id": "cooler_eng", "cell": Vector2i(18, 8), "prop": "cooler", "solid": true},
	# --- Lounge (rows 3-11, right column) ---
	{"id": "rug_lounge", "cell": Vector2i(21, 4), "prop": "rug_pink", "solid": false},
	{"id": "sofa_lounge", "cell": Vector2i(21, 3), "prop": "sofa", "solid": true},
	{"id": "table_lounge", "cell": Vector2i(22, 6), "prop": "table", "solid": true},
	{"id": "pingpong", "cell": Vector2i(21, 10), "prop": "pingpong", "solid": true},
	{"id": "plant_lounge", "cell": Vector2i(31, 3), "prop": "plant", "solid": true},
	{"id": "plant_lounge_b", "cell": Vector2i(31, 11), "prop": "plant", "solid": true},
	# --- Meeting room (rows 14-20, left) ---
	{"id": "board_meeting", "cell": Vector2i(2, 14), "prop": "whiteboard", "solid": true},
	{"id": "rug_meeting", "cell": Vector2i(2, 17), "prop": "rug_blue", "solid": false},
	{"id": "table_meeting", "cell": Vector2i(3, 17), "prop": "table", "solid": true},
	{"id": "chair_meeting_a", "cell": Vector2i(2, 16), "prop": "chair", "solid": false},
	{"id": "chair_meeting_b", "cell": Vector2i(5, 16), "prop": "chair", "solid": false},
	{"id": "chair_meeting_c", "cell": Vector2i(2, 19), "prop": "chair", "solid": false},
	{"id": "chair_meeting_d", "cell": Vector2i(5, 19), "prop": "chair", "solid": false},
	{"id": "shelf_meeting", "cell": Vector2i(7, 15), "prop": "shelf", "solid": true},
	# --- Break area (rows 14-20, middle) ---
	{"id": "coffee", "cell": Vector2i(11, 14), "prop": "coffee", "solid": true},
	{"id": "rug_break", "cell": Vector2i(14, 17), "prop": "rug_warm", "solid": false},
	{"id": "sofa_break", "cell": Vector2i(14, 16), "prop": "sofa", "solid": true},
	{"id": "table_break", "cell": Vector2i(15, 19), "prop": "table", "solid": true},
	{"id": "plant_break", "cell": Vector2i(18, 15), "prop": "plant", "solid": true},
	{"id": "cooler_break", "cell": Vector2i(18, 19), "prop": "cooler", "solid": true},
	# --- QA lab (rows 14-20, right) ---
	{"id": "desk_qa_b", "cell": Vector2i(21, 14), "prop": "desk", "solid": true},
	{"id": "chair_qa_b", "cell": Vector2i(22, 17), "prop": "chair", "solid": false},
	{"id": "desk_qa_c", "cell": Vector2i(25, 14), "prop": "desk", "solid": true},
	{"id": "chair_qa_c", "cell": Vector2i(26, 17), "prop": "chair", "solid": false},
	{"id": "bookshelf_qa", "cell": Vector2i(30, 15), "prop": "bookshelf", "solid": true},
]

## Interior wall dividers by tile column, separating the floor into rooms.
const INTERIOR_WALLS := [10, 19]

## Work/visitor anchors per desk.
##
## The work anchor is the desk's front row so the seated actor's base line is at
## or below the desk base and Y-sorting draws them in front of it. A work anchor
## above the desk base makes the actor disappear behind the desk.
const ANCHORS := {
	"desk_lead": {"work": Vector2i(4, 8), "visitor": Vector2i(4, 9)},
	"desk_backend": {"work": Vector2i(12, 7), "visitor": Vector2i(12, 8)},
	"desk_frontend": {"work": Vector2i(16, 7), "visitor": Vector2i(16, 8)},
	"desk_qa_a": {"work": Vector2i(12, 12), "visitor": Vector2i(12, 13)},
	"desk_qa_b": {"work": Vector2i(22, 17), "visitor": Vector2i(22, 18)},
	"desk_qa_c": {"work": Vector2i(26, 17), "visitor": Vector2i(26, 18)},
	"coffee": {"work": Vector2i(12, 17), "visitor": Vector2i(13, 17)},
	"table_meeting": {"work": Vector2i(3, 20), "visitor": Vector2i(6, 20)},
	"table_lounge": {"work": Vector2i(23, 8), "visitor": Vector2i(24, 8)},
	"table_break": {"work": Vector2i(15, 22), "visitor": Vector2i(17, 22)},
	"bookshelf_eng": {"work": Vector2i(17, 7), "visitor": Vector2i(17, 8)},
	"bookshelf_qa": {"work": Vector2i(30, 18), "visitor": Vector2i(31, 18)},
}



const PROP_TEXTURES := {
	"desk": "res://office/art/prop_desk.png",
	"chair": "res://office/art/prop_chair.png",
	"plant": "res://office/art/prop_plant.png",
	"sofa": "res://office/art/prop_sofa.png",
	"table": "res://office/art/prop_table.png",
	"shelf": "res://office/art/prop_shelf.png",
	"coffee": "res://office/art/prop_coffee.png",
	"whiteboard": "res://office/art/prop_whiteboard.png",
	"rug": "res://office/art/prop_rug.png",
	"rug_blue": "res://office/art/prop_rug_blue.png",
	"rug_warm": "res://office/art/prop_rug_warm.png",
	"rug_pink": "res://office/art/prop_rug_pink.png",
	"window": "res://office/art/prop_window.png",
	"bookshelf": "res://office/art/prop_bookshelf.png",
	"pingpong": "res://office/art/prop_pingpong.png",
	"lamp": "res://office/art/prop_lamp.png",
	"cooler": "res://office/art/prop_cooler.png",
}

## Prop footprint in tiles, used for routing blockers and anchor placement.
const PROP_FOOTPRINT := {
	"desk": Vector2i(3, 2),
	"chair": Vector2i(1, 1),
	"plant": Vector2i(1, 1),
	"sofa": Vector2i(3, 2),
	"table": Vector2i(2, 2),
	"shelf": Vector2i(2, 2),
	"coffee": Vector2i(2, 2),
	"whiteboard": Vector2i(3, 1),
	"rug": Vector2i(3, 2),
	"rug_blue": Vector2i(3, 2),
	"rug_warm": Vector2i(3, 2),
	"rug_pink": Vector2i(3, 2),
	"window": Vector2i(2, 1),
	"bookshelf": Vector2i(2, 2),
	"pingpong": Vector2i(3, 2),
	"lamp": Vector2i(1, 1),
	"cooler": Vector2i(1, 1),
}

var navigation: OfficeNavigation
var actors: Dictionary = {}
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
	_overlay = OfficeOverlay.new()
	_overlay.name = "Overlay"
	_overlay.world = self
	add_child(_overlay)
	queue_redraw()


## Routable blockers derived from each prop's real footprint, plus the interior
## wall dividers so paths route around them instead of through a wall.
func _blockers() -> Array:
	var list: Array = []
	for item in FURNITURE:
		if not bool(item.get("solid", false)):
			continue
		var footprint: Vector2i = PROP_FOOTPRINT.get(str(item["prop"]), Vector2i(1, 1))
		list.append(
			{"id": item["id"], "cell": item["cell"], "size": footprint, "blocking": true}
		)
	# Dividers block their column from the wall band down to the last floor row,
	# leaving the rows around the doorway corridors passable.
	for x in INTERIOR_WALLS:
		list.append({"id": "wall_%d" % x, "cell": Vector2i(x, 2), "size": Vector2i(1, MAP_HEIGHT - 3), "blocking": true})
	return list


## Floors are drawn per zone with the material that zone uses, so the plan reads
## as furnished rooms rather than one flat plane. Row 0 is a wall band: the north
## wall art covers it and casts its shadow onto row 1.
func _build_tiles() -> void:
	_floor = TileMapLayer.new()
	_floor.name = "Floor"
	_floor.tile_set = load("res://office/maps/hq/hq_tileset.tres")
	add_child(_floor)
	move_child(_floor, 0)
	# Wall band rows 0-1 sit underneath the north wall art.
	for x in MAP_WIDTH:
		for band in range(2):
			_floor.set_cell(Vector2i(x, band), 0, Vector2i(FLOOR_CONCRETE, 0))
	for y in range(2, MAP_HEIGHT):
		for x in MAP_WIDTH:
			_floor.set_cell(Vector2i(x, y), 0, Vector2i(FLOOR_CONCRETE, 0))
	for zone in ZONES:
		var rect: Rect2i = zone["rect"]
		var base: int = zone["floor"]
		for y in range(maxi(rect.position.y, 2), rect.position.y + rect.size.y):
			for x in range(rect.position.x, rect.position.x + rect.size.x):
				# Alternate the two tones of the material for a woven surface.
				var column := base + ((x + y) % 2)
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
func _build_walls() -> void:
	_walls = Node2D.new()
	_walls.name = "Walls"
	# Walls are architecture: they draw above the floor and below actors, so a
	# character standing on the top row still renders in front of the wall base.
	_walls.z_index = 1
	add_child(_walls)
	var top: Texture2D = load("res://office/art/wall_top.png")
	var side: Texture2D = load("res://office/art/wall_side.png")
	var door: Texture2D = load("res://office/art/door_frame.png")
	# Wall art reads cap -> face -> cast shadow downward (56 px tall), so its top
	# edge sits at y = 0 and the cast shadow lands on the floor's wall band.
	var wall_h := top.get_height()
	for x in range(0, MAP_WIDTH, 4):
		var sprite := Sprite2D.new()
		sprite.texture = top
		sprite.position = Vector2(x * TILE + TILE * 2, wall_h * 0.5)
		sprite.texture_filter = CanvasItem.TEXTURE_FILTER_NEAREST
		_walls.add_child(sprite)
	var doorway := Sprite2D.new()
	doorway.texture = door
	doorway.position = Vector2(15 * TILE, door.get_height() * 0.5)
	doorway.texture_filter = CanvasItem.TEXTURE_FILTER_NEAREST
	_walls.add_child(doorway)
	# Vertical wall runs divide the floor into rooms. Each divider starts below
	# the north wall band and runs down the map.
	for divider in INTERIOR_WALLS:
		var x: int = divider
		for y in range(2, MAP_HEIGHT - 1, 2):
			var sprite := Sprite2D.new()
			sprite.texture = side
			sprite.position = Vector2(x * TILE - side.get_width() * 0.5, y * TILE + TILE)
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


## Deterministic desk assignment: repeated agents get distinct desks.
func _next_slot(actor: ActorPresentation) -> Dictionary:
	var used := {}
	for slot in _assignments.values():
		used[slot["desk"]] = true
	if actor.identity.is_root():
		return {"desk": "desk_lead", "anchor": "work"}
	for desk in ["desk_backend", "desk_frontend", "desk_qa_a", "desk_qa_b", "desk_qa_c", "coffee"]:
		if not used.has(desk):
			return {"desk": desk, "anchor": "work"}
	return {"desk": "coffee", "anchor": "visitor"}


func _add_actor(actor: ActorPresentation) -> void:
	var node := OfficeActor.new()
	# Actors join the Y-sorted props layer so furniture and people interleave by
	# their base line instead of drawing in two fixed passes.
	_props.add_child(node)
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


func apply_work_state(actor: ActorPresentation) -> void:
	var node := actors.get(actor.identity.session_id) as OfficeActor
	if node == null:
		return
	node.set_route(navigation.route(node.position, _anchor_for(actor)))
	node.update_from(actor, _anchor_for(actor))
	_refresh_overlay()


func apply_ambient(actor: ActorPresentation, kind: String) -> void:
	var node := actors.get(actor.identity.session_id) as OfficeActor
	if node == null:
		return
	node.set_ambient(kind)
	var target := navigation.anchor_position("coffee", "visitor") if kind == "coffee" else node.position
	node.set_route(navigation.route(node.position, target))
	_refresh_overlay()


func show_notice(actor: ActorPresentation, text: String) -> void:
	notices[actor.identity.session_id] = text
	_refresh_overlay()


func clear_notice(session_id: String) -> void:
	notices.erase(session_id)
	_refresh_overlay()


func select_actor(session_id: String) -> void:
	_selected = session_id
	_refresh_overlay()


func desk_id_for(session_id: String) -> String:
	var slot: Variant = _assignments.get(session_id)
	return "" if slot == null else str(slot["desk"])
