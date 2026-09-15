## Grid navigation and routing.
##
## One AStarGrid2D map derived from the furniture blockers. Anchor positions are
## reachable through the real doorway; diagonal corner cutting is disabled so
## characters never clip through a desk corner.
class_name OfficeNavigation
extends RefCounted

const TILE := 32

var width: int = 0
var height: int = 0
var _grid: AStarGrid2D
var _anchors: Dictionary = {}
var _blocked: Dictionary = {}


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
	# Walls occupy the top and left band; the doorway stays passable.
	for x in width:
		_blocked[Vector2i(x, 0)] = true
	for y in height:
		_blocked[Vector2i(0, y)] = true
	_blocked.erase(Vector2i(9, 0))
	_blocked.erase(Vector2i(10, 0))
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
	for point in points:
		path.append(point)
	return path


func _cell_of(position: Vector2) -> Vector2i:
	var cell := Vector2i(int(position.x / TILE), int(position.y / TILE))
	return Vector2i(clampi(cell.x, 0, width - 1), clampi(cell.y, 0, height - 1))


## Reachability check used by tests: every anchor must be reachable from the
## doorway entrance.
func all_anchors_reachable() -> bool:
	var entrance := Vector2i(9, 1)
	if is_blocked(entrance):
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


func anchor_count() -> int:
	var total := 0
	for desk_id in _anchors:
		total += (_anchors[desk_id] as Dictionary).size()
	return total
