## Pixel-world viewport.
##
## Renders the office on a SubViewport so the pixel world stays on an integer
## grid independently of crisp screen-resolution panel text. Actor status is
## read from the store; the view never invents facts.
##
## `stretch` is enabled so the container owns the SubViewport size, which maps
## one world pixel to one screen pixel with no non-uniform distortion. The
## camera zoom only chooses how much of the map is visible, preserving aspect.
class_name OfficeViewport
extends SubViewportContainer

const WORLD_SIZE := Vector2(OfficeWorld.MAP_WIDTH * OfficeWorld.TILE, OfficeWorld.MAP_HEIGHT * OfficeWorld.TILE)

## Zoom bounds. The lower bound must not override the fit calculation, or a map
## taller than the viewport gets cropped and its top rows (the walls) disappear.
const MIN_ZOOM := 0.35
const MAX_ZOOM := 2.5
## Allow panning when the map is larger than the viewport.
const PAN_SPEED := 420.0

var world: OfficeWorld
var _store: OfficeStore
var _camera: Camera2D


func _ready() -> void:
	stretch = true
	world = $SubViewport/OfficeWorld
	_camera = $SubViewport/OfficeWorld/Camera
	_camera.position = WORLD_SIZE * 0.5
	world.setup(self)
	resized.connect(_fit)
	_fit()


## Fit the whole office inside the container, preserving aspect so nothing is
## distorted or cropped. The camera centres on the map so the north wall band and
## the south rooms are both visible.
func _fit() -> void:
	if _camera == null or size.x <= 0.0 or size.y <= 0.0:
		return
	var fit := minf(size.x / WORLD_SIZE.x, size.y / WORLD_SIZE.y)
	_camera.position = WORLD_SIZE * 0.5
	var zoom := clampf(fit, MIN_ZOOM, MAX_ZOOM)
	_camera.zoom = Vector2(zoom, zoom)


func bind_store(store: OfficeStore) -> void:
	_store = store


## Pan the view with the arrow keys or WASD, then recenter on a double press.
func _unhandled_input(event: InputEvent) -> void:
	if _camera == null or not (event is InputEventKey):
		return
	var key := event as InputEventKey
	if not key.pressed:
		return
	var pan := Vector2.ZERO
	match key.keycode:
		KEY_LEFT, KEY_A:
			pan.x -= 1.0
		KEY_RIGHT, KEY_D:
			pan.x += 1.0
		KEY_UP, KEY_W:
			pan.y -= 1.0
		KEY_DOWN, KEY_S:
			pan.y += 1.0
		_:
			return
	var step := PAN_SPEED / maxf(_camera.zoom.x, 0.01)
	_camera.position = (_camera.position + pan * step).clamp(
		Vector2.ZERO, WORLD_SIZE
	)


func refresh(store: OfficeStore) -> void:
	if world != null:
		world.refresh(store)


func apply_work_state(actor: ActorPresentation) -> void:
	if world != null:
		world.apply_work_state(actor)


func apply_ambient(actor: ActorPresentation, kind: String) -> void:
	if world != null:
		world.apply_ambient(actor, kind)


func show_notice(actor: ActorPresentation, text: String) -> void:
	if world != null:
		world.show_notice(actor, text)


func clear_notice(session_id: String) -> void:
	if world != null:
		world.clear_notice(session_id)


func select_actor(session_id: String) -> void:
	if world != null:
		world.select_actor(session_id)
