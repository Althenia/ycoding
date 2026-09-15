## Application composition root.
##
## Selects exactly one transport, owns the store, and wires the director to the
## office view. This is the only place that decides DEMO vs LIVE.
class_name OfficeMain
extends Node

const DEMO_FIXTURE := "res://fixtures/oauth-workplace.jsonl"
const AMBIENT_INTERVAL_MS := 6000

var store: OfficeStore
var director: OfficeDirector
var demo: DemoTransport

var office_view: OfficeViewport
var prompt_panel: PromptPanel
var status_panel: StatusPanel
var conversation_panel: ConversationPanel
var mode_badge: ModeBadge

var _elapsed_ms: int = 0
var _ambient_accumulator: int = 0
var _ambient_tick: int = 0
## When a capture harness drives the clock itself, the scene must not also
## advance it, or playback time becomes non-deterministic.
var capture_mode: bool = false
## Pending cosmetic reenactments keyed by actor, bounded by the director.
var _pending: Array[Dictionary] = []
var _active: Dictionary = {}


func _ready() -> void:
	store = OfficeStore.new()
	director = OfficeDirector.new()
	demo = DemoTransport.new()

	office_view = $Shell/OfficeViewport
	prompt_panel = $Shell/PromptPanel
	status_panel = $Shell/StatusPanel
	conversation_panel = $Shell/ConversationPanel
	mode_badge = $Shell/TopBar/ModeBadge

	office_view.bind_store(store)
	prompt_panel.prompt_submitted.connect(_on_prompt_submitted)
	conversation_panel.close_requested.connect(func(): conversation_panel.visible = false)
	status_panel.actor_selected.connect(_on_actor_selected)

	_start_demo()
	_refresh_ui()


## DEMO is the initial default. LIVE requires an explicit connection and is not
## implemented in this milestone; the badge states that plainly.
func _start_demo() -> void:
	store.mode = OfficeStore.MODE_DEMO
	var error := demo.load_fixture(DEMO_FIXTURE)
	if not error.is_empty():
		store.last_error = error
		store.connection_state = OfficeStore.CONNECTION_DISCONNECTED
		return
	demo.event_ready.connect(_on_event)
	demo.play(true)
	prompt_panel.set_mode(OfficeStore.MODE_DEMO)


func _on_event(event: Dictionary) -> void:
	var previous: Dictionary = {}
	for actor in store.actor_list():
		previous[actor.identity.session_id] = actor.work_state
	store.apply(event)
	_react(event, previous)
	_refresh_ui()


## Canonical state is already updated by the store; the director only plans
## cosmetic follow-ups, and the panel never waits for them.
func _react(event: Dictionary, previous: Dictionary) -> void:
	var session_id := str(event.get("sessionID", ""))
	if session_id.is_empty():
		# A connection or epoch frame can still invalidate cosmetic work.
		if store.source_epoch != "":
			_pending.clear()
			_active.clear()
		return
	var actor := store.actor_for(session_id)
	if actor == null:
		return
	var action := director.plan(actor, int(previous.get(session_id, WorkState.Kind.IDLE)))
	if action.is_empty():
		return
	office_view.clear_notice(session_id)
	match str(action.get("action", "")):
		OfficeDirector.ACTION_WORK:
			_enact_work(actor, action)
		OfficeDirector.ACTION_BUBBLE:
			_show_bubble(actor, action)
		OfficeDirector.ACTION_SETTLE:
			_settle(actor)


## Real movement: route the actor to its work anchor, then adopt the work pose.
func _enact_work(actor: ActorPresentation, action: Dictionary) -> void:
	if not OfficeDirector.is_current(action, actor):
		return
	_active[actor.identity.session_id] = action
	office_view.apply_work_state(actor)
	_promote_next()


## A source-backed bubble stays until superseded; a status notice is not a quote.
func _show_bubble(actor: ActorPresentation, action: Dictionary) -> void:
	if not OfficeDirector.is_current(action, actor):
		return
	office_view.show_notice(actor, str(action.get("text", "")))


func _settle(actor: ActorPresentation) -> void:
	_active.erase(actor.identity.session_id)
	office_view.clear_notice(actor.identity.session_id)
	office_view.apply_work_state(actor)


## Queue a bounded cosmetic action for later; over-age entries are dropped.
func _enqueue(action: Dictionary) -> void:
	if director.enqueue(action, _elapsed_ms):
		_pending.append(action)


func _promote_next() -> void:
	var action := director.dequeue(_elapsed_ms)
	if action.is_empty():
		return
	var actor := store.actor_for(str(action.get("actor", "")))
	if actor == null or not OfficeDirector.is_current(action, actor):
		return
	_show_bubble(actor, action)


func _process(delta: float) -> void:
	var delta_ms := int(delta * 1000.0)
	if capture_mode:
		# The harness owns the clock: advance nothing, but keep the world drawn.
		demo.advance(0)
		return
	_elapsed_ms += delta_ms
	demo.advance(delta_ms)
	_ambient_accumulator += delta_ms
	if _ambient_accumulator < AMBIENT_INTERVAL_MS:
		return
	_ambient_accumulator = 0
	_tick_ambient()


## Ambient life is cosmetic and preemptible; real work and attention cancel it.
func _tick_ambient() -> void:
	_ambient_tick += 1
	for actor in store.actor_list():
		var ambient := director.plan_ambient(actor, _ambient_tick)
		if ambient.is_empty():
			office_view.clear_notice(actor.identity.session_id)
			continue
		office_view.apply_ambient(actor, str(ambient.get("ambient", "")))


func _on_prompt_submitted(text: String) -> void:
	# In DEMO the composer is a preview: it never mutates backend state.
	prompt_panel.show_demo_notice(text)


func _on_actor_selected(session_id: String) -> void:
	store.select_actor(session_id)
	conversation_panel.show_actor(store, session_id, zone_for(session_id))
	office_view.select_actor(session_id)
	_refresh_ui()


## Which room an actor currently occupies, derived from its assigned desk.
func zone_for(session_id: String) -> String:
	if office_view == null or office_view.world == null:
		return ""
	return office_view.world.zone_for(session_id)


func _refresh_ui() -> void:
	status_panel.refresh(store)
	mode_badge.refresh(store, demo.is_playing())
	office_view.refresh(store)
