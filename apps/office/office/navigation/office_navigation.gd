## Grid navigation and routing.
##
## One AStarGrid2D map derived from the furniture blockers. Anchor positions are
## reachable through the real doorway; diagonal corner cutting is disabled so
## characters never clip through a desk corner.
class_name OfficeNavigation
extends RefCounted

const TILE := 32
## Half a tile: the distance from a cell origin to its centre.
const CENTRE_OFFSET := Vector2(TILE * 0.5, TILE * 0.5)

var width: int = 0
var height: int = 0
var _grid: AStarGrid2D
var _anchors: Dictionary = {}
var _blocked: Dictionary = {}
## Outstanding reservations, keyed `"<desk_id>:<which>"` -> `{"holder": String,
## "at": int}`. The key is only ever a DECLARED anchor, because `reserve` refuses an
## unknown one, so the table cannot grow past the layout.
var _reservations: Dictionary = {}

## How long a reservation survives without being re-affirmed.
##
## The spec forbids letting a stuck holder block a work anchor permanently
## (`docs/PLAYER_CONTROLS.md:15`), and a caller contract cannot guarantee release
## when a session dies mid-flight, so the bound is enforced HERE rather than trusted
## to the caller. A holder that is still present re-affirms on its own cadence, which
## is far shorter than this.
const RESERVATION_TTL_MS := 30000


## Rasterize the layout's blockers into an AStarGrid2D.
##
## This function holds no layout knowledge of its own: the building shell, the
## dividers and the furniture footprints all arrive as blockers from OfficeWorld,
## so there is exactly one authority for where solid geometry is.
func build(
	map_width: int,
	map_height: int,
	furniture: Array,
	anchors: Dictionary
) -> void:
	width = map_width
	height = map_height
	_grid = AStarGrid2D.new()
	_grid.region = Rect2i(0, 0, width, height)
	_grid.cell_size = Vector2(TILE, TILE)
	_grid.diagonal_mode = AStarGrid2D.DIAGONAL_MODE_ONLY_IF_NO_OBSTACLES
	_grid.update()
	_blocked.clear()
	for item in furniture:
		if not bool(item.get("blocking", false)):
			continue
		var cell: Vector2i = item["cell"]
		var size: Vector2i = item["size"]
		for dx in size.x:
			for dy in size.y:
				_blocked[cell + Vector2i(dx, dy)] = true
	_anchors = anchors
	for cell in _blocked:
		_grid.set_point_solid(cell, true)


func is_blocked(cell: Vector2i) -> bool:
	return _blocked.has(cell)


func anchor_position(desk_id: String, which: String) -> Vector2:
	var desk: Dictionary = _anchors.get(desk_id, {})
	var cell: Vector2i = desk.get(which, Vector2i(2, 2))
	return Vector2(cell) * TILE + Vector2(TILE * 0.5, TILE * 0.5)


## Route between two grid cells. Returns an empty array when unreachable, which
## callers treat as a cosmetic dead end — never as a runtime blocker.
func route(from: Vector2, to: Vector2) -> Array[Vector2]:
	var from_cell := _cell_of(from)
	var to_cell := _cell_of(to)
	if from_cell == to_cell:
		return [to]
	var points := _grid.get_point_path(from_cell, to_cell)
	var path: Array[Vector2] = []
	# AStarGrid2D returns cell ORIGINS while anchors are cell CENTRES, so the last
	# waypoint must be converted or every arrival lands half a tile up-left of the
	# anchor it was routed to.
	for index in points.size():
		var point: Vector2 = points[index]
		if index == points.size() - 1:
			path.append(point + CENTRE_OFFSET)
			continue
		path.append(point)
	return path


func _cell_of(position: Vector2) -> Vector2i:
	var cell := Vector2i(int(position.x / TILE), int(position.y / TILE))
	return Vector2i(clampi(cell.x, 0, width - 1), clampi(cell.y, 0, height - 1))


## Reachability check used by tests: every anchor must be reachable from the
## doorway. The entrance is discovered rather than hardcoded, so it is the cell
## the shell actually leaves open in the wall band.
func all_anchors_reachable() -> bool:
	var entrance := _entrance()
	if entrance.x < 0:
		return false
	for desk_id in _anchors:
		var desk: Dictionary = _anchors[desk_id]
		for which in desk:
			var cell: Vector2i = desk[which]
			if is_blocked(cell):
				return false
			if _grid.get_point_path(entrance, cell).is_empty():
				return false
	return true


## The doorway: the first passable cell in the wall band.
func _entrance() -> Vector2i:
	for y in range(2):
		for x in width:
			if not is_blocked(Vector2i(x, y)):
				return Vector2i(x, y)
	return Vector2i(-1, -1)


## Claim an anchor for a holder.
##
## Succeeds when the anchor is free, already held by this same holder (a runner that
## re-affirms its seat every frame must not be told it lost it), or held by someone
## whose reservation has EXPIRED. Fails for an unknown anchor or kind, and fails for
## an anchor held by another live holder.
##
## An unknown anchor is REFUSED rather than keyed, which is what keeps the table
## bounded by the declared layout.
func reserve(desk_id: String, which: String, holder: String, now_ms: int = -1) -> bool:
	if not _has_anchor(desk_id, which) or holder.is_empty():
		return false
	var now := now_ms if now_ms >= 0 else Time.get_ticks_msec()
	var key := _key(desk_id, which)
	var existing: Variant = _reservations.get(key, null)
	if existing is Dictionary:
		var held: String = (existing as Dictionary).get("holder", "")
		var at: int = int((existing as Dictionary).get("at", 0))
		var expired := now - at >= RESERVATION_TTL_MS
		if held != holder and not expired:
			return false
	_reservations[key] = {"holder": holder, "at": now}
	return true


## Give up an anchor. A no-op when nobody holds it, so a repeated release is safe.
func release(desk_id: String, which: String) -> void:
	_reservations.erase(_key(desk_id, which))


## The holder of an anchor, or "" when it is free or its reservation has expired.
##
## An expired reservation reads as free rather than being reported as held, so a
## caller can never be told a dead holder owns the seat.
func holder_of(desk_id: String, which: String, now_ms: int = -1) -> String:
	var existing: Variant = _reservations.get(_key(desk_id, which), null)
	if not (existing is Dictionary):
		return ""
	var now := now_ms if now_ms >= 0 else Time.get_ticks_msec()
	if now - int((existing as Dictionary).get("at", 0)) >= RESERVATION_TTL_MS:
		return ""
	return str((existing as Dictionary).get("holder", ""))


## How many anchors are currently held by a live reservation.
func reserved_count(now_ms: int = -1) -> int:
	var now := now_ms if now_ms >= 0 else Time.get_ticks_msec()
	var total := 0
	for key in _reservations:
		var entry: Dictionary = _reservations[key]
		if now - int(entry.get("at", 0)) < RESERVATION_TTL_MS:
			total += 1
	return total


## The cell of a declared anchor, or `(-1, -1)` when it is not one.
func anchor_cell(desk_id: String, which: String) -> Vector2i:
	if not _has_anchor(desk_id, which):
		return Vector2i(-1, -1)
	return (_anchors[desk_id] as Dictionary)[which]


## Whether the layout declares this anchor at all.
func _has_anchor(desk_id: String, which: String) -> bool:
	if not _anchors.has(desk_id):
		return false
	return (_anchors[desk_id] as Dictionary).has(which)


func _key(desk_id: String, which: String) -> String:
	return "%s:%s" % [desk_id, which]


func anchor_count() -> int:
	var total := 0
	for desk_id in _anchors:
		total += (_anchors[desk_id] as Dictionary).size()
	return total
