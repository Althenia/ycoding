## Employee actor.
##
## A Node2D visual with foot-origin positioning so depth sorting is correct
## against furniture. Movement follows an OfficeNavigation route at a constant
## foot speed; the node owns no runtime facts and renders whatever the store
## already says.
class_name OfficeActor
extends Node2D

const TILE := 32
const FRAME_W := 32
## Must match CHAR_H in tools/generate_art.py: each sheet row is one frame tall.
const FRAME_H := 56

## Sprite sheet row order, matching tools/generate_art.py.
const ROW_IDLE := 0
const ROW_WALK := 2
const ROW_SIT := 8
const ROW_TYPE := 10
const ROW_READ := 12
const ROW_TALK := 14

const DIR_DOWN := 0
const DIR_UP := 1
const DIR_LEFT := 2
const DIR_RIGHT := 3

## Consistent foot speed so characters never idle-jog or slide.
const WALK_SPEED := 64.0
const FRAME_SECONDS := 0.11

const ROLE_TEXTURES := {
	"lead": "res://office/art/char_lead.png",
	"backend": "res://office/art/char_backend.png",
	"frontend": "res://office/art/char_frontend.png",
	"qa": "res://office/art/char_qa.png",
}

var session_id: String = ""
var display_name: String = ""
var work_state: int = WorkState.Kind.IDLE
var settled_status: String = ""
var attention_required: bool = false

## Presentation preference owned by the actor. Reduced motion removes
## interpolation and frame cycling without moving the actor's destination.
var motion: Motion = Motion.new()

var _sheet: Texture2D
var _sprite: Sprite2D
var _frame_row: int = ROW_IDLE
var _frame_variant: int = 0
var _direction: int = DIR_DOWN
var _frame_accumulator: float = 0.0
var _route: Array[Vector2] = []
var _route_index: int = 0
var _walking: bool = false
var _ambient: String = ""
var _ambient_remaining: float = 0.0


func update_from(actor: ActorPresentation, anchor: Vector2) -> void:
	if session_id.is_empty():
		session_id = actor.identity.session_id
		display_name = actor.identity.display_name
		position = anchor
		_load_sheet(actor.identity.agent_id)
		_build_sprite()
	work_state = actor.work_state
	settled_status = actor.settled_status
	attention_required = actor.attention_required
	# Do not override an active walk: the walk loop owns the row until it ends.
	if not _walking:
		_frame_row = _rest_row()
	_apply_frame()


func _load_sheet(agent_id: String) -> void:
	var path := str(ROLE_TEXTURES.get(agent_id, ROLE_TEXTURES["lead"]))
	if ResourceLoader.exists(path):
		_sheet = load(path)


## The pose held while standing still, ignoring any active walk.
func _rest_row() -> int:
	match work_state:
		WorkState.Kind.TYPING, WorkState.Kind.TESTING:
			return ROW_TYPE
		WorkState.Kind.READING, WorkState.Kind.REVIEWING:
			return ROW_READ
		WorkState.Kind.WAITING, WorkState.Kind.BLOCKED, WorkState.Kind.PROCESSING:
			return ROW_TALK
	return ROW_IDLE


func set_ambient(kind: String) -> void:
	_ambient = kind
	_ambient_remaining = 4.0
	if _route_index >= _route.size():
		_frame_row = _rest_row()


func set_route(route: Array[Vector2]) -> void:
	if route.size() <= 1:
		return
	_route = route
	_route_index = 1
	_walking = true
	_frame_row = ROW_WALK
	# Under reduced motion the route is still adopted whole, but the actor settles
	# on its final point at once rather than waiting for the next frame.
	if motion.reduced():
		_settle_still()


func is_walking() -> bool:
	return _walking


func facing() -> int:
	return _direction


func _process(delta: float) -> void:
	if _ambient_remaining > 0.0:
		_ambient_remaining -= delta
		if _ambient_remaining <= 0.0:
			_ambient = ""
			if not _walking:
				_frame_row = _rest_row()
	if motion.reduced():
		_settle_still()
		return
	_walk(delta)
	_animate(delta)


## Reduced motion: reach the destination without travelling there, and hold the
## rest pose instead of cycling frames.
##
## The office stays truthful about where an agent is — the actor still ends on
## the route's final point and still faces the way the route approached it — but
## nothing interpolates. This runs every frame, so it must be idempotent, and it
## is also what settles an actor whose motion is toggled mid-walk.
func _settle_still() -> void:
	if _walking and _route.size() >= 2:
		var last := _route.size() - 1
		_direction = _facing_for(_route[last] - _route[last - 1])
		position = _route[last]
		_route_index = _route.size()
		_walking = false
	elif _frame_row == _rest_row() and _frame_variant == 0:
		# Already settled: reduced motion does no per-frame work at all.
		return
	_frame_row = _rest_row()
	_frame_variant = 0
	_frame_accumulator = 0.0
	_apply_frame()


## Constant-speed progression toward each route point; never interpolates
## through a blocked cell because the route came from the navigation grid.
func _walk(delta: float) -> void:
	if not _walking or _route_index >= _route.size():
		return
	var target := _route[_route_index]
	var step := WALK_SPEED * delta
	var to_target := target - position
	if to_target.length() <= step:
		position = target
		_route_index += 1
		if _route_index >= _route.size():
			_walking = false
			_frame_row = _rest_row()
		return
	_direction = _facing_for(to_target)
	position += to_target.normalized() * step


func _facing_for(to_target: Vector2) -> int:
	if absf(to_target.x) > absf(to_target.y):
		return DIR_RIGHT if to_target.x > 0.0 else DIR_LEFT
	return DIR_DOWN if to_target.y > 0.0 else DIR_UP


func _animate(delta: float) -> void:
	_frame_accumulator += delta
	if _frame_accumulator < FRAME_SECONDS:
		return
	_frame_accumulator = 0.0
	var frames := 6 if _frame_row == ROW_WALK else 2
	_frame_variant = (_frame_variant + 1) % frames
	_apply_frame()


## The actor owns a Sprite2D child so the parent's Y-sort orders it against
## furniture by the feet line.
func _build_sprite() -> void:
	_sprite = Sprite2D.new()
	_sprite.name = "Sprite"
	_sprite.texture_filter = CanvasItem.TEXTURE_FILTER_NEAREST
	# The frame is 32x48 with the feet at the bottom, so shift up by half height.
	_sprite.offset = Vector2(0, -FRAME_H * 0.5 + 2)
	add_child(_sprite)
	_apply_frame()


func _apply_frame() -> void:
	if _sprite == null:
		return
	if _sheet == null:
		_sprite.texture = null
		return
	_sprite.texture = _sheet
	_sprite.region_enabled = true
	_sprite.region_rect = Rect2(
		_direction * FRAME_W,
		(_frame_row + _frame_variant % 2) * FRAME_H,
		FRAME_W,
		FRAME_H
	)
