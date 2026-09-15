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
var conversation_panel: ConversationPanel
var sidebar: SidebarPanel
var chrome_toggles: ChromeToggles

var _shell: Control
## The agent chosen in the sidebar. DEMO has no runtime agent to select, so this
## stays empty there rather than naming one the runtime did not choose.
var selected_agent_id: String = ""
## The model chosen in the composer, once the user picks one.
var composer_model_ref: String = ""
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
	conversation_panel = $Shell/ConversationPanel
	sidebar = $Shell/Sidebar
	chrome_toggles = $Shell/ChromeToggles

	office_view.bind_store(store)
	prompt_panel.prompt_submitted.connect(_on_prompt_submitted)
	prompt_panel.model_selected.connect(_on_model_selected)
	conversation_panel.close_requested.connect(func(): conversation_panel.visible = false)
	sidebar.session_selected.connect(_on_actor_selected)
	sidebar.new_session_requested.connect(_on_new_session)
	sidebar.agent_selected.connect(_on_agent_selected)
	# The sidebar shows each actor's room without reaching into the scene.
	sidebar.zone_provider = func(session_id: String) -> String:
		return zone_for(session_id)
	# Clicking an actor or its notice bubble in the world opens the same
	# source-backed drawer as selecting it in the team list.
	office_view.actor_clicked.connect(_on_actor_selected)
	# Hiding the chrome is presentation only: it never reaches the store.
	chrome_toggles.toggled.connect(_on_chrome_toggled)

	# The shell design owns every region; the scene file carries no layout.
	_shell = $Shell
	_shell.resized.connect(_apply_regions)
	_apply_regions()
	# A shell that has not been laid out yet reports zero size, so apply again
	# once the tree is ready rather than leaving the first frame collapsed.
	call_deferred("_apply_regions")

	_start_demo()
	_refresh_ui()


## Apply the shell overlay design.
##
## The office is full-bleed and reaches the window edges; the panels float over
## it. There is no header and no tiled frame: the sidebar carries the mode badge,
## the sessions, the team and the agent selector.
func _apply_regions() -> void:
	if _shell == null or _shell.size.x < 1.0 or _shell.size.y < 1.0:
		return
	var overlays := OfficeShellLayout.overlays(_shell.size)
	OfficeShellLayout.place($Backdrop, Rect2(Vector2.ZERO, _shell.size))
	OfficeShellLayout.place(office_view, OfficeShellLayout.office_region(_shell.size))
	OfficeShellLayout.place(prompt_panel, overlays["composer"])

	OfficeShellLayout.place(sidebar, overlays["sidebar"])
	OfficeShellLayout.place(chrome_toggles, overlays["toggles"])
	_apply_chrome_visibility()
	# The source drawer floats above the composer on the right. Its placement is
	# provisional: it was not part of the reviewed overlay design.
	OfficeShellLayout.place(
		conversation_panel,
		Rect2(
			Vector2(
				_shell.size.x - 552.0,
				maxf(_shell.size.y - 200.0 - 552.0 * 0.6, 16.0)
			),
			Vector2(536.0, minf(552.0 * 0.6, _shell.size.y - 200.0))
		)
	)


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


## The model references actually in play. DEMO has no server, so the synthetic
## catalogue stands in and is labelled as such by ModelCatalog.is_demo_catalog.
##
## TODO(LIVE): read /api/model instead of the synthetic set once LIVE is wired.
func _model_catalog() -> Array:
	return ModelCatalog.demo_catalog()


## The composer starts on the model a session already reports, so switching work
## does not silently change the model in use.
func _default_model_ref() -> String:
	if not composer_model_ref.is_empty():
		return composer_model_ref
	for actor in store.actor_list():
		if not actor.model_ref.is_empty():
			return actor.model_ref
	return ""


func _on_model_selected(ref: String) -> void:
	composer_model_ref = ref


## A new session is a real backend mutation, which DEMO must never perform. The
## demo path states that boundary rather than pretending to create one.
func _on_new_session() -> void:
	if store.mode == OfficeStore.MODE_LIVE:
		return
	prompt_panel.show_demo_notice("DEMO preview — a new session is not created")


func _on_agent_selected(agent_id: String) -> void:
	if agent_id.is_empty():
		return
	selected_agent_id = agent_id
	_refresh_ui()


func _on_actor_selected(session_id: String) -> void:
	store.select_actor(session_id)
	conversation_panel.show_actor(store, session_id, zone_for(session_id))
	office_view.select_actor(session_id)
	_refresh_ui()


## Show or hide a floating panel. The office is a full-bleed scene, so a user who
## wants an unobstructed view hides the chrome rather than resizing anything.
func _on_chrome_toggled(_name: String, _hidden: bool) -> void:
	_apply_chrome_visibility()


func _apply_chrome_visibility() -> void:
	if chrome_toggles == null:
		return
	sidebar.visible = not chrome_toggles.is_hidden("sidebar")
	prompt_panel.visible = not chrome_toggles.is_hidden("composer")


## Which room an actor currently occupies, derived from its assigned desk.
func zone_for(session_id: String) -> String:
	if office_view == null or office_view.world == null:
		return ""
	return office_view.world.zone_for(session_id)


func _refresh_ui() -> void:
	# Presence is derived state, so it is recomputed once per change rather than
	# recomputed by the world or re-derived by each panel.
	store.sync_presence()
	prompt_panel.set_models(_model_catalog(), _default_model_ref())
	prompt_panel.set_location(store)
	if selected_agent_id.is_empty():
		selected_agent_id = _default_agent_id()
	sidebar.set_agents(_agent_ids(), selected_agent_id)
	sidebar.refresh(store, demo.is_playing())
	office_view.refresh(store)


## The agent new work starts as: the root session's agent when there is one, else
## the first observed agent.
func _default_agent_id() -> String:
	var root := store.actor_for(store.root_session_id)
	if root != null and not root.identity.agent_id.is_empty():
		return root.identity.agent_id
	var agents := _agent_ids()
	return agents[0] if not agents.is_empty() else ""


## The agents the office can currently speak as.
##
## In DEMO these are the agents actually present in the fixture, so the selector
## never names an agent the runtime did not produce. In LIVE the list would come
## from the provider's agent inventory; until that is wired, the observed agents
## remain the honest source.
func _agent_ids() -> Array[String]:
	var seen := {}
	for actor in store.actor_list():
		var agent_id := actor.identity.agent_id
		if not agent_id.is_empty():
			seen[agent_id] = true
	var out: Array[String] = []
	for agent_id in seen:
		out.append(str(agent_id))
	out.sort()
	return out
