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
var live: LiveTransport

var office_view: OfficeViewport
var prompt_panel: PromptPanel
var conversation_panel: ConversationPanel
var sidebar: SidebarPanel
var chrome_toggles: ChromeToggles

var _shell: Control
## The presentation preference shared by every actor. Loaded once at startup and
## applied on every refresh, so a change reaches actors created later too.
var motion: Motion = Motion.new()
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
	# Load the saved preference before the first actor exists, so the office never
	# animates once and then stops.
	motion.load()
	store = OfficeStore.new()
	director = OfficeDirector.new()
	demo = DemoTransport.new()
	live = LiveTransport.new()

	office_view = $Shell/OfficeViewport
	prompt_panel = $Shell/PromptPanel
	conversation_panel = $Shell/ConversationPanel
	sidebar = $Shell/Sidebar
	chrome_toggles = $Shell/ChromeToggles

	office_view.bind_store(store)
	if office_view.world != null:
		office_view.world.motion = motion
	prompt_panel.prompt_submitted.connect(_on_prompt_submitted)
	prompt_panel.model_selected.connect(_on_model_selected)
	conversation_panel.close_requested.connect(func(): conversation_panel.visible = false)
	sidebar.session_selected.connect(_on_actor_selected)
	sidebar.new_session_requested.connect(_on_new_session)
	sidebar.agent_selected.connect(_on_agent_selected)
	sidebar.mode_toggle_requested.connect(_on_mode_toggle)
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
	# Seed the toggle from the SAVED preference before the first apply, or the
	# default (full motion) would overwrite the user's stored choice on startup.
	chrome_toggles.set_hidden("motion", motion.reduced())
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


## Connect to a real local service.
##
## LIVE is only entered on an explicit request. Nothing here can move DEMO to LIVE
## on its own, which the badge and the mode boundary both depend on.
##
## Returns an error string, or "" on success. The address is validated before any
## state changes, so a typo cannot leave the office in a half-live state.
func start_live(base_url: String, password: String = "") -> String:
	var error := live.configure(base_url, Gateway.AUTH_USERNAME, password)
	if not error.is_empty():
		store.last_error = error
		_refresh_ui()
		return error
	# Stop the demo cleanly first: two transports feeding one store would make
	# the office report fiction as fact.
	_stop_demo()
	# A live service is a different world, so the accumulated demo state, its
	# cursors and its cosmetic sequences are all discarded before it joins.
	store = OfficeStore.new()
	office_view.bind_store(store)
	if office_view.world != null:
		office_view.world.motion = motion
	store.mode = OfficeStore.MODE_LIVE
	live.event_ready.connect(_on_event)
	live.connection_changed.connect(_on_connection_changed)
	live.failure.connect(_on_live_failure)
	live.reload_required.connect(_on_reload_required)
	live.reload_ready.connect(_on_reload_ready)
	live.reload_failed.connect(_on_reload_failed)
	live.play()
	prompt_panel.set_mode(OfficeStore.MODE_LIVE)
	_refresh_ui()
	return ""


## Return to synthetic playback, discarding live state.
func start_demo_mode() -> void:
	if store.mode == OfficeStore.MODE_LIVE:
		live.stop()
		live.event_ready.disconnect(_on_event)
	store = OfficeStore.new()
	office_view.bind_store(store)
	if office_view.world != null:
		office_view.world.motion = motion
	_start_demo()
	_refresh_ui()


func _stop_demo() -> void:
	if demo != null and demo.is_playing():
		demo.stop()
	if demo != null and demo.event_ready.is_connected(_on_event):
		demo.event_ready.disconnect(_on_event)


## Toggle between the synthetic office and a live service.
##
## The address comes from the local service registration the CLI already writes,
## so the user does not retype a URL the product already knows.
func _on_mode_toggle() -> void:
	if store.mode == OfficeStore.MODE_LIVE:
		start_demo_mode()
		return
	var registration := _read_service_registration()
	if registration.is_empty():
		store.last_error = "No local service registration found. Start the server first."
		_refresh_ui()
		return
	var error := start_live(
		str(registration.get("url", "")),
		str(registration.get("password", ""))
	)
	if not error.is_empty():
		store.last_error = error
		_refresh_ui()


## The local service registration, as the CLI writes it.
##
## Read-only, best effort, and never fatal: an absent or unreadable file simply
## means there is nothing to attach to. Attaching never starts or stops the
## daemon, so closing the office leaves a running service exactly as it was.
func _read_service_registration() -> Dictionary:
	for path in ServiceRegistration.candidates(
		OS.get_environment("YCODING_SERVICE_FILE"),
		OS.get_environment("XDG_STATE_HOME"),
		OS.get_environment("HOME")
	):
		if not FileAccess.file_exists(path):
			continue
		var parsed: Variant = JSON.parse_string(FileAccess.get_file_as_string(path))
		if parsed is Dictionary and not str(parsed.get("url", "")).is_empty():
			return parsed
	return {}


func _on_connection_changed(state: String) -> void:
	store.connection_state = state
	_refresh_ui()


## The feed could not be resumed, so the projection is discarded and reloaded.
##
## The office keeps drawing while this happens; it just stops claiming the
## projection is complete, which is what the stale flag records.
func _on_reload_required(epoch: String) -> void:
	store.mark_stale()
	_refresh_ui()
	# Only a COMPLETED reload may clear staleness. The projection stays marked
	# incomplete until the session list and every session log have answered, so a
	# partial read can never be presented as a whole one.
	live.reload()


## The canonical reload finished: replace the projection with what the service
## actually reports, in the order its logs gave.
func _on_reload_ready(frames: Array, epoch: String) -> void:
	store.adopt_reload(frames, epoch)
	_refresh_ui()


## A reload that could not finish leaves the projection stale and says why.
func _on_reload_failed(reason: String) -> void:
	store.mark_stale()
	store.last_error = reason
	_refresh_ui()


## Answer a pending request from the UI.
##
## In DEMO there is nothing to answer: a synthetic office asks for nothing, and
## approving on the user's behalf would be inventing consent.
func answer_attention(request_id: String, body: Dictionary) -> String:
	if store.mode != OfficeStore.MODE_LIVE:
		return "DEMO preview — no request can be answered."
	var request := store.attention.for_session("")
	for entry in store.attention.pending():
		if str(entry["id"]) == request_id:
			request = entry
	if request.is_empty():
		return "That request is no longer pending."
	var error := live.reply(request, body)
	if not error.is_empty():
		return error
	# The runtime answers once; retiring it here stops the UI offering it again
	# before the confirmation event arrives.
	store.attention.resolve(request_id)
	_refresh_ui()
	return ""


func _on_live_failure(message: String) -> void:
	store.last_error = message
	_refresh_ui()


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
	# The report is decided from the event, not from the cosmetic action, because
	# an already-idle actor produces no action at all. A report supersedes the
	# settle that follows it: settling routes the actor back to its desk, which
	# would cancel the walk to the lead it is on.
	if _maybe_report(actor, event):
		return
	var action := director.plan(actor, int(previous.get(session_id, WorkState.Kind.IDLE)))
	if action.is_empty():
		return
	office_view.clear_notice(session_id)
	# A burst of events for one actor must not interrupt a walk already in progress:
	# the mover would stutter between destinations. The action is queued instead,
	# where it is bounded, aged out and coalesced per actor, and promoted when the
	# actor is free.
	if (
		str(action.get("action", "")) == OfficeDirector.ACTION_WORK
		and _is_moving(actor.identity.session_id)
	):
		_enqueue(action)
		return
	match str(action.get("action", "")):
		OfficeDirector.ACTION_WORK:
			_enact_work(actor, action)
		OfficeDirector.ACTION_BUBBLE:
			_show_bubble(actor, action)
		OfficeDirector.ACTION_SETTLE:
			_settle(actor)


## A finished child walks to the CEO to report, the way a person would.
##
## The report is the office's own reading of a real event: a subagent that
## completes its assignment crosses to the lead's office. Nothing is narrated —
## the movement is the signal, and the durable report stays in the source drawer.
func _maybe_report(actor: ActorPresentation, event: Dictionary) -> bool:
	if actor.identity.is_root():
		return false
	# A completed assignment is a CHANGE inside session.task.updated, not a
	# top-level event type.
	if str(event.get("type", "")) != Wire.TASK_UPDATED:
		return false
	var change: Dictionary = (event.get("data", {}) as Dictionary).get("change", {})
	if str(change.get("type", "")) != Wire.CHANGE_COMPLETED:
		return false
	# The store has already settled this actor to IDLE, so it is available to move.
	# A still-running actor keeps its seat instead of leaving its work.
	if actor.is_running():
		return false
	office_view.apply_report(actor)
	return true


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


## Whether this actor is currently travelling, and so must not be redirected.
func _is_moving(session_id: String) -> bool:
	var node = office_view.world.actors.get(session_id) if office_view.world != null else null
	return node != null and node.is_walking()


## Queue a bounded cosmetic action for later; over-age entries are dropped and a
## newer intent for the same actor supersedes the older one.
func _enqueue(action: Dictionary) -> void:
	if director.enqueue(action, _elapsed_ms):
		_pending.append(action)


## Promote one queued action, if it is still meaningful.
##
## A stale action is dropped rather than played late: the actor may have moved on,
## and `is_current` is what makes the actor's own token and generation decide.
func _promote_next() -> void:
	for attempt in OfficeDirector.MAX_QUEUED_ACTIONS:
		var action := director.dequeue(_elapsed_ms)
		if action.is_empty():
			return
		var actor := store.actor_for(str(action.get("actor", "")))
		if actor == null or not OfficeDirector.is_current(action, actor):
			continue
		if str(action.get("action", "")) == OfficeDirector.ACTION_WORK:
			_enact_work(actor, action)
			return
		_show_bubble(actor, action)
		return


func _process(delta: float) -> void:
	var delta_ms := int(delta * 1000.0)
	if capture_mode:
		# The harness owns the clock: advance nothing, but keep the world drawn.
		if store.mode == OfficeStore.MODE_LIVE:
			live.advance(0)
		else:
			demo.advance(0)
		return
	_elapsed_ms += delta_ms
	if store.mode == OfficeStore.MODE_LIVE:
		# LIVE polls a socket; it has no synthetic clock to advance.
		live.advance(delta_ms)
	else:
		demo.advance(delta_ms)
	# Promote queued work as soon as the actor stops moving, so a burst settles
	# instead of waiting for the next unrelated event.
	_promote_next()
	_ambient_accumulator += delta_ms
	if _ambient_accumulator < AMBIENT_INTERVAL_MS:
		return
	_ambient_accumulator = 0
	_tick_ambient()


## Ambient life is cosmetic and preemptible; real work and attention cancel it.
##
## An actor that needs a human decision is not available for ambient life, and its
## notice is a real signal rather than scenery. Clearing unconditionally erased
## "waiting for your decision" within one ambient tick, so the one thing the user
## had to act on disappeared on its own.
func _tick_ambient() -> void:
	_ambient_tick += 1
	for actor in store.actor_list():
		if actor.attention_required:
			continue
		var ambient := director.plan_ambient(actor, _ambient_tick)
		if ambient.is_empty():
			office_view.clear_notice(actor.identity.session_id)
			continue
		office_view.apply_ambient(actor, str(ambient.get("ambient", "")))


## Submit the composer text.
##
## DEMO is a preview and says so. LIVE admits the prompt as real work, and reports
## a refusal from the service instead of swallowing it. The message id is derived
## from the text and the second-resolution clock so a repeated submission is a
## deliberate new input rather than an accidental duplicate.
func _on_prompt_submitted(text: String) -> void:
	if store.mode != OfficeStore.MODE_LIVE:
		prompt_panel.show_notice("DEMO preview — nothing was sent: " + text)
		return
	var session_id := _prompt_target()
	if session_id.is_empty():
		prompt_panel.show_notice("No session is selected to receive that prompt")
		return
	var reason := live.submit_prompt(session_id, text, _prompt_message_id(text))
	if reason.is_empty():
		prompt_panel.show_notice("Sent to " + _session_label(session_id))
		return
	prompt_panel.show_notice(reason)


## The session a prompt goes to: the selected actor when there is one, else the
## root session, which is what the office is about when nothing is selected.
func _prompt_target() -> String:
	var actor := store.selected_actor()
	if actor != null and not actor.identity.session_id.is_empty():
		return actor.identity.session_id
	return store.root_session_id


## A stable id for a submitted prompt, so the service can reconcile an exact
## retry of the same input instead of admitting it twice.
func _prompt_message_id(text: String) -> String:
	return "msg_office_%d_%d" % [Time.get_unix_time_from_system(), text.hash()]


## How the composer names the session it sent to. Falls back to the id so the
## notice never claims a role the projection did not produce.
func _session_label(session_id: String) -> String:
	var actor := store.actor_for(session_id)
	if actor != null and not actor.display_role.is_empty():
		return actor.display_role
	return session_id


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


## Adopt the chosen model for the next submission.
##
## In LIVE this is a real request: the service refuses a switch the current
## context cannot fit, and that refusal is reported rather than hidden. DEMO has
## no service, so it only moves the selection.
func _on_model_selected(ref: String) -> void:
	composer_model_ref = ref
	if store.mode != OfficeStore.MODE_LIVE:
		return
	var session_id := _prompt_target()
	if session_id.is_empty():
		return
	var reason := live.switch_model(session_id, ref)
	if not reason.is_empty():
		prompt_panel.show_notice(reason)


## A new session is a real backend mutation, which DEMO must never perform. The
## demo path states that boundary rather than pretending to create one.
func _on_new_session() -> void:
	if store.mode == OfficeStore.MODE_LIVE:
		return
	prompt_panel.show_notice("DEMO preview — a new session is not created")


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
	# Reduced motion is the same kind of presentation choice as hiding a panel,
	# so it lives beside them rather than in a separate settings surface.
	var reduced := chrome_toggles.is_hidden("motion")
	if motion.reduced() != reduced:
		motion.set_reduced(reduced)
		motion.save()
	_apply_motion()


## Hand the shared preference to the actors actually in the world.
##
## The projection list is not the scene: the animated nodes live in the world, so
## assigning to a projection silently did nothing and the office kept animating.
func _apply_motion() -> void:
	if office_view == null or office_view.world == null:
		return
	for key in office_view.world.actors:
		var node = office_view.world.actors[key]
		if node is OfficeActor:
			node.motion = motion


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
	sidebar.set_location(store)
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
