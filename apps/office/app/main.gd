## Application composition root.
##
## Selects exactly one transport, owns the store, and wires the director to the
## office view. This is the only place that decides DEMO vs LIVE.
class_name OfficeMain
extends Node

const DEMO_FIXTURE := "res://fixtures/oauth-workplace.jsonl"
const AMBIENT_INTERVAL_MS := 6000

## The message a launch shows when no local service registration exists. It names
## the file that was searched and the command that creates one, because an empty
## office with no next step is indistinguishable from a broken one.
const NO_SERVICE_MESSAGE := (
	"No local service registration found (service.json)."
	+ " Start it with `ycoding service start`, then retry."
)

var store: OfficeStore
var director: OfficeDirector
var demo: DemoTransport
var live: LiveTransport
## Separate transports, because a transport is a poller: sharing one would make
## two owners each see half the entries.
var models_api: ModelCatalogApi
var sessions_api: SessionApi

var office_view: OfficeViewport
var prompt_panel: PromptPanel
var conversation_panel: ConversationPanel
var sidebar: SidebarPanel
var chrome_toggles: ChromeToggles
## The Statistics surface. Its data binding is StatisticsPage, which owns what may be said.
var statistics_panel: StatisticsPanel
## The Settings surface. The grouping, the scope rules and the configuration review rules
## live in core; these panels render them and drive the real `server.config` owner.
var settings_panel: SettingsPanel
## The configuration owner reader. Its own transport, because two pollers sharing one
## would each consume half the answers.
var config_api: ConfigApi
## The read/preview/commit rules for one value. Owns no scene tree, so a test reaches it.
var config_review: ConfigReview
## Owns the read for the statistics surface. Separate from the model catalogue's reader.
var usage_api: UsageApi
## Reads provider ACCOUNT limits, which are a different source from session usage.
var provider_usage_api: ProviderUsageApi

var _shell: Control
## The route owner. Which surface is showing is presentation state, so it lives
## here with the other shell state and never reaches the store or the transports.
var router: OfficeRouter = OfficeRouter.new()
## The folder a new session would run in, once one is chosen. Empty until then, which
## is why a fresh client could not create a session: `_known_directory` had nothing to
## report. Resolution is delegated to `FolderTarget`, which owns the canonicalization
## and refusal rules.
var folder_target: FolderTarget = FolderTarget.new()
## The recent and pinned project list. Presentation state: it remembers folders the
## user opened so they can return, and it is never runtime authority.
var project_ledger: ProjectLedger = ProjectLedger.new()
## The presentation preference shared by every actor. Loaded once at startup and
## applied on every refresh, so a change reaches actors created later too.
var motion: Motion = Motion.new()
## The interface text scale. Bounded by UiScale, because past the ceiling the shell
## cannot lay itself out and a panel would be clipped.
var ui_scale: float = UiScale.MIN
## The agent chosen in the sidebar. DEMO has no runtime agent to select, so this
## stays empty there rather than naming one the runtime did not choose.
var selected_agent_id: String = ""
## The model the user chose, remembered against the work they chose it for. A single
## remembered choice would follow the user into every other project, quietly making
## one project's model another's.
var _chosen_model_by_target: Dictionary = {}
## What the user was looking at, per project. Disposable desktop data: it is restored so
## returning to a project resumes the work, and it is never runtime authority.
var view_state: OfficeViewState = OfficeViewState.new()
## The project entry the saved view state belongs to, so the project being LEFT can be
## written before the one being entered is read.
var _view_entry_id: String = ""
## The models the SERVICE last reported. Held apart from the synthetic catalogue so
## a state refresh cannot substitute one for the other, and empty until a real read
## answers.
var _service_models: Array = []
var _elapsed_ms: int = 0
var _ambient_accumulator: int = 0
var _ambient_tick: int = 0
## When a capture harness drives the clock itself, the scene must not also
## advance it, or playback time becomes non-deterministic.
var capture_mode: bool = false
## Pending cosmetic reenactments keyed by actor, bounded by the director.
var _pending: Array[Dictionary] = []
var _active: Dictionary = {}
## The prompt id for the draft the composer is holding, the text it belongs to, and
## the session it is aimed at. Kept together so an exact retry of that draft against
## that session reconciles, and so the same words sent to a DIFFERENT session are a
## new input: the service reconciles an id match as an exact retry, so reusing an id
## across projects would have it answer a prompt that project never received.
var _pending_prompt_id: String = ""
var _pending_prompt_text: String = ""
var _pending_prompt_target: String = ""


func _ready() -> void:
	# Load the saved preference before the first actor exists, so the office never
	# animates once and then stops.
	motion.load()
	# The project list is remembered between launches, which is what makes a recent a
	# recent. A missing or corrupt file is survivable and falls back to an empty list.
	project_ledger.load()
	# What the user was looking at. Read before the panels exist is fine: only the route
	# is restored immediately, and the rest is restored by the switch transaction when a
	# project is actually opened.
	view_state.load()
	store = OfficeStore.new()
	if not view_state.last_error().is_empty():
		store.last_error = view_state.last_error()
	director = OfficeDirector.new()
	demo = DemoTransport.new()
	live = LiveTransport.new()
	models_api = ModelCatalogApi.new()
	sessions_api = SessionApi.new()

	office_view = $Shell/OfficeViewport
	prompt_panel = $Shell/PromptPanel
	conversation_panel = $Shell/ConversationPanel
	sidebar = $Shell/Sidebar
	chrome_toggles = $Shell/ChromeToggles
	statistics_panel = $Shell/StatisticsPanel
	settings_panel = $Shell/SettingsPanel

	_wire_signals()
	office_view.bind_store(store)
	if office_view.world != null:
		office_view.world.motion = motion

	# The shell design owns every region; the scene file carries no layout.
	_shell = $Shell
	_shell.resized.connect(_apply_regions)
	# Mark the starting route before the first layout, so the rail shows which
	# surface is live from the first frame rather than after a navigation.
	# The route the user left on is restored, but only as a SURFACE: the router decides
	# what is shown and never touches work, so resuming a route cannot start, move or stop
	# anything.
	var last_route := str(view_state.state_for(view_state.last_entry_id()).get("view_route", ""))
	if not last_route.is_empty():
		router.go(last_route)
	sidebar.set_route(router.route())
	_apply_route_visibility()
	_apply_regions()
	# A shell that has not been laid out yet reports zero size, so apply again
	# once the tree is ready rather than leaving the first frame collapsed.
	call_deferred("_apply_regions")

	# A production launch attaches to the real service or states honestly that
	# there is none. Synthetic playback is never the default, and this path cannot
	# reach it: DEMO is entered only by the user's own mode action.
	_boot_live()


## Connect the panels to this root.
##
## Separated from `_ready` because it is wiring only: it reads no scene node and
## starts no transport. A test drives the boot decision with the same wiring
## `_ready` performs, rather than a second copy of it that could drift.
func _wire_signals() -> void:
	prompt_panel.prompt_submitted.connect(_on_prompt_submitted)
	prompt_panel.stop_requested.connect(_on_stop_requested)
	prompt_panel.model_selected.connect(_on_model_selected)
	conversation_panel.close_requested.connect(_close_drawer)
	conversation_panel.attention_replied.connect(_on_attention_replied)
	chrome_toggles.action_requested.connect(_on_chrome_action)
	sidebar.session_selected.connect(_on_actor_selected)
	sidebar.new_session_requested.connect(_on_new_session)
	sidebar.agent_selected.connect(_on_agent_selected)
	sidebar.mode_toggle_requested.connect(_on_mode_toggle)
	sidebar.retry_connection_requested.connect(_retry_connection)
	# The rail ASKS; the root routes. A rail that owned the route could not be
	# reasoned about separately from the surfaces it switches between.
	sidebar.route_requested.connect(_on_route_requested)
	# The rail ASKS to open a project; the root resolves and adopts it.
	sidebar.project_requested.connect(_on_project_requested)
	# The settings page ASKS to close; the root routes. A page that owned the route
	# could not be reasoned about separately from the surfaces it switches between.
	if settings_panel != null:
		settings_panel.close_requested.connect(_on_settings_close_requested)
		settings_panel.scope_changed.connect(_on_settings_scope_changed)
	router.route_changed.connect(_on_route_changed)
	# The sidebar shows each actor's room without reaching into the scene.
	sidebar.zone_provider = func(session_id: String) -> String:
		return zone_for(session_id)
	# Clicking an actor or its notice bubble in the world opens the same
	# source-backed drawer as selecting it in the team list.
	office_view.actor_clicked.connect(_on_actor_selected)
	# Hiding the chrome is presentation only: it never reaches the store.
	chrome_toggles.toggled.connect(_on_chrome_toggled)


## Apply the shell overlay design.
##
## The window is split into two regions: a docked sidebar column that touches the left
## edge and spans the content height, and the office, which owns every remaining pixel.
## There is no header. Only the composer floats, because it belongs to the office it
## sits in. The sidebar carries the mode badge, the sessions, the team and the selector.
func _apply_regions() -> void:
	if _shell == null or _shell.size.x < 1.0 or _shell.size.y < 1.0:
		return
	var overlays := OfficeShellLayout.overlays(_shell.size, ui_scale)
	OfficeShellLayout.place($Backdrop, Rect2(Vector2.ZERO, _shell.size))
	OfficeShellLayout.place(office_view, OfficeShellLayout.office_region(_shell.size, ui_scale))
	# The composer is placed by its BOTTOM edge against the height its own content
	# needs. The engine clamps a Control's size up to its minimum, and a size clamped
	# from the top grows the panel downward - which put the composer's last line, the
	# target it exists to name, below the window.
	OfficeShellLayout.place(prompt_panel, OfficeShellLayout.composer_placed(
		overlays["composer"], prompt_panel.get_combined_minimum_size().y
	))

	# The Statistics surface occupies the content region east of the sidebar, the same
	# region the world uses. Exactly one of them is visible per route.
	if statistics_panel != null:
		OfficeShellLayout.place(statistics_panel, OfficeShellLayout.office_region(_shell.size, ui_scale))
	# The Settings surface is a large bounded page centred in the same content region.
	# It is placed like the other surfaces so its rect comes from the layout owner
	# rather than from a literal here.
	if settings_panel != null:
		OfficeShellLayout.place(
			settings_panel, OfficeShellLayout.settings_region(_shell.size, ui_scale)
		)
	OfficeShellLayout.place(sidebar, overlays["sidebar"])
	# The cluster reflows to the room it actually has BESIDE the sidebar, so a narrow
	# window at a large text scale wraps it into more rows instead of letting it
	# overlap the roster. The width passed is the real gap, not the reserved region,
	# because the reserved region is deliberately the cluster's own single-row width.
	chrome_toggles.wrap_to(
		maxf(_shell.size.x - OfficeShellLayout.sidebar_width(_shell.size, ui_scale)
			- OfficeShellLayout.TOGGLES_MARGIN * 2.0, 1.0)
	)
	OfficeShellLayout.place(chrome_toggles, overlays["toggles"])
	# Seed the toggle from the SAVED preference before the first apply, or the
	# default (full motion) would overwrite the user's stored choice on startup.
	chrome_toggles.set_hidden("motion", motion.reduced())
	_apply_chrome_visibility()
	# The contextual drawer is a layout-owned overlay now, so its bounds live with
	# the other regions rather than as literals here.
	OfficeShellLayout.place(conversation_panel, overlays["drawer"])


## Enter synthetic playback. Reachable ONLY through the explicit demo action.
##
## Nothing in a production launch reaches here: `_ready` boots LIVE, and the two
## callers are the user's own mode toggle and the sibling mode method it drives.
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


## The production launch decision: attach to the registered service, or state
## honestly that there is none.
##
## A normal launch never fabricates an office. Discovery is read-only and best
## effort; a missing registration renders a disconnected state that names what is
## missing and how to fix it, with the composer still able to hold a draft.
func _boot_live() -> void:
	_boot_with(_read_service_registration())


## Adopt one discovery result. Kept separate from `_boot_live` so the decision is
## driven directly by a test without depending on whether the machine running it
## happens to have a service registered.
func _boot_with(registration: Dictionary) -> void:
	if registration.is_empty():
		_enter_disconnected_live(NO_SERVICE_MESSAGE)
		return
	var error := start_live(
		str(registration.get("url", "")),
		str(registration.get("password", ""))
	)
	if not error.is_empty():
		_enter_disconnected_live(error)


## Render the honest disconnected office.
##
## Nothing is discarded that a user typed and nothing is invented: the mode is
## LIVE because the client is trying to be, the connection is stated as down, and
## the message says what is missing. The composer is told there are no models so
## its model control is disabled and says so rather than opening an empty menu.
##
## Synthetic state is discarded here too, because this is also how a DEMO office
## leaves for LIVE when the attach fails. Without that, synthetic actors and their
## history would stay on screen under a LIVE badge: the same fiction-as-fact the
## live path exists to prevent. The composer draft is not part of the projection, so
## it survives.
func _enter_disconnected_live(message: String) -> void:
	_reset_projection()
	store.mode = OfficeStore.MODE_LIVE
	store.connection_state = OfficeStore.CONNECTION_DISCONNECTED
	store.last_error = message if not message.is_empty() else NO_SERVICE_MESSAGE
	prompt_panel.set_models([], "")
	prompt_panel.set_mode(OfficeStore.MODE_LIVE)
	_refresh_ui()


## Drop whatever the previous transport accumulated, so one mode's facts can never
## be presented as another's. Shared by the live attach and the disconnected state,
## because both are leaving synthetic playback behind.
func _reset_projection() -> void:
	# Two transports feeding one store would make the office report fiction as
	# fact, so the demo stops before the projection it produced is discarded.
	_stop_demo()
	store = OfficeStore.new()
	office_view.bind_store(store)
	if office_view.world != null:
		office_view.world.motion = motion


## Try the registered service again. The composer is not touched, so a failed
## connection costs the user nothing they typed.
func _retry_connection() -> void:
	if store.mode != OfficeStore.MODE_LIVE:
		return
	_boot_with(_read_service_registration())


## Connect to a real local service.
##
## LIVE is only entered on an explicit request or by the boot decision. Nothing
## here can move DEMO to LIVE on its own, which the badge and the mode boundary
## both depend on.
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
	_reset_projection()
	# A new attach reads the canonical state again, because the feed is volatile and anything
	# sent during the gap is lost.
	_rearm_canonical_read()
	store.mode = OfficeStore.MODE_LIVE
	# A reconnect re-enters this method, so every signal is connected once. An
	# unguarded connect would raise an engine error on the second attach.
	if not live.event_ready.is_connected(_on_event):
		live.event_ready.connect(_on_event)
	if not live.connection_changed.is_connected(_on_connection_changed):
		live.connection_changed.connect(_on_connection_changed)
	if not live.failure.is_connected(_on_live_failure):
		live.failure.connect(_on_live_failure)
	if not live.reload_required.is_connected(_on_reload_required):
		live.reload_required.connect(_on_reload_required)
	if not live.reload_ready.is_connected(_on_reload_ready):
		live.reload_ready.connect(_on_reload_ready)
	if not live.reload_failed.is_connected(_on_reload_failed):
		live.reload_failed.connect(_on_reload_failed)
	sessions_api = SessionApi.new(_side_transport())
	sessions_api.session_created.connect(_on_session_created)
	sessions_api.create_failed.connect(_on_session_create_failed)
	sessions_api.interrupt_failed.connect(_on_interrupt_failed)
	# A stop must be ACKNOWLEDGED, not assumed. Without this the UI could not tell a
	# settled cancellation from one the service never accepted.
	sessions_api.interrupted.connect(_on_interrupted)
	# The drawer's stop names the session it shows, so a background project's work can be
	# stopped from the surface that describes it without first changing the selection.
	if not conversation_panel.stop_requested.is_connected(_on_drawer_stop):
		conversation_panel.stop_requested.connect(_on_drawer_stop)
	# A row's exact source is a session, so opening one selects it the same way clicking an
	# actor does - through the same path, so the office, the composer target and the history
	# read all move together rather than only the drawer.
	if not conversation_panel.open_session_requested.is_connected(_on_actor_selected):
		conversation_panel.open_session_requested.connect(_on_actor_selected)
	models_api = ModelCatalogApi.new()
	_side = _side_transport()
	models_api.configure(_side)
	# The configuration owner gets its OWN transport, for the same reason every other
	# module does: two pollers sharing one would each consume half the answers.
	config_api = ConfigApi.new()
	config_api.configure(_side_transport())
	config_review = ConfigReview.new()
	config_review.configure(config_api)
	# The review surface is bound only now, because before this point there is no reader
	# for it to drive and an unbound surface would offer controls that cannot act.
	if settings_panel != null:
		settings_panel.bind_review(config_review)
		if settings_panel.review_surface() != null:
			if not settings_panel.review_surface().read_requested.is_connected(_on_config_read_requested):
				settings_panel.review_surface().read_requested.connect(_on_config_read_requested)
			if not settings_panel.review_surface().preview_requested.is_connected(_on_config_preview_requested):
				settings_panel.review_surface().preview_requested.connect(_on_config_preview_requested)
			if not settings_panel.review_surface().commit_requested.is_connected(_on_config_commit_requested):
				settings_panel.review_surface().commit_requested.connect(_on_config_commit_requested)
			if not settings_panel.review_surface().remove_requested.is_connected(_on_config_remove_requested):
				settings_panel.review_surface().remove_requested.connect(_on_config_remove_requested)
			if not settings_panel.review_surface().remove_commit_requested.is_connected(_on_config_remove_commit_requested):
				settings_panel.review_surface().remove_commit_requested.connect(_on_config_remove_commit_requested)
	# The statistics read gets its OWN transport too, so a usage answer cannot be consumed
	# by another module's poller and the page's figures are never another read's result.
	# Guarded: this runs from `start_live`, which a hand-built shell in a test may call without
	# the statistics surface, and a shell without it simply has no export to request.
	if statistics_panel != null and not statistics_panel.export_requested.is_connected(_on_export_requested):
		statistics_panel.export_requested.connect(_on_export_requested)
	usage_api = UsageApi.new()
	usage_api.configure(_side_transport())
	# Provider quota has its own reader and transport for the same reason: a quota snapshot is
	# a different source from session usage, and its answer must not be consumed elsewhere.
	provider_usage_api = ProviderUsageApi.new()
	provider_usage_api.configure(_side_transport())
	# The history read gets its OWN transport, so its answers cannot be consumed by another
	# module's poller.
	conversation_api = ConversationApi.new()
	conversation_api.configure(_side_transport())
	conversation_panel.bind_history(conversation_api.history)
	# A folder chosen before this transport was built still has to reach it, or the
	# location-scoped model read would answer for the wrong directory.
	if not folder_target.directory().is_empty():
		_side.set_location(folder_target.directory())
	live.play()
	_refresh_models()
	prompt_panel.set_mode(OfficeStore.MODE_LIVE)
	_refresh_ui()
	return ""


## A transport dedicated to this module's own requests.
##
## It points at the same service as the live feed but polls independently, which
## is what keeps two owners from stealing each other's answers.
## The canonical history read. Its own transport, because two pollers sharing one would each
## see half the answers.
var conversation_api: ConversationApi = ConversationApi.new()
## The side transport, held so a chosen folder can reach it after it was built.
var _side: HttpTransport


func _side_transport() -> HttpTransport:
	var transport := HttpTransport.new()
	transport.configure(live.base_url(), Gateway.AUTH_USERNAME, str(live.credentials()["password"]))
	return transport


## Read the service's real models.
##
## DEMO has no service, so the synthetic set stands in and is labelled as such by
## the composer. LIVE asks the service, and a refusal leaves the list empty rather
## than showing fabricated models as if the runtime had offered them.
## Begin reading the model catalogue for the location now in front of the user.
##
## The route is location-scoped, so the list belongs to a PROJECT rather than to the
## window. Reading it once at attach and never again left the previous project's models
## on offer after a switch: the user would pick a model from one project's list while the
## prompt went to another.
##
## The read is STARTED, not waited on. It settles on the frame loop, so choosing a
## folder never stalls the window behind a socket, and starting a new read is also what
## discards an older one: a response whose request is no longer the current one is not
## this project's list and is never installed.
func _refresh_models() -> void:
	if store.mode != OfficeStore.MODE_LIVE:
		prompt_panel.set_models(_model_catalog(), _default_model_ref())
		return
	# Nothing of the departed project's list is kept, for the same reason a failed read
	# keeps nothing: it does not describe where the user is, so offering it would be the
	# same untruth as inventing one.
	_service_models = []
	if not models_api.start():
		prompt_panel.set_models([], "")
		var reason := models_api.last_error()
		if not reason.is_empty():
			store.last_error = reason
		_refresh_ui()
		return
	# While the list is unknown nothing can be named from it, so the composer says so
	# rather than keeping a name whose project has been left.
	prompt_panel.set_models([], "")


## Install a catalogue read once it settles. Called from the frame loop, because the
## read is asynchronous by design.
##
## This is the ONLY caller of `models_api.poll`: a second poller would consume the
## entries this one needs, and the read would then never settle.
## Read usage for the session the statistics surface describes.
##
## The page's figures are the SERVICE's accounting for one session, so the read needs a
## session to ask about. A root session's Summary already includes its delegated family, so
## asking for the family's ROOT is what covers the family without summing it here.
##
## The read is STARTED, not waited on: choosing the Statistics route must never stall the
## window on a socket. `_settle_usage` polls it once per frame like every other module.
func refresh_statistics() -> void:
	if statistics_panel == null:
		return
	var target := store.selected_actor()
	if target == null:
		target = store.actor_for(store.root_session_id)
	if target == null:
		# Nothing is selected and no root is known, so there is no session to account for.
		# The page says so rather than reporting zero work.
		statistics_panel.page = StatisticsPage.new()
		statistics_panel.adopt(statistics_panel.page)
		return
	var session_id := target.identity.session_id
	if store.mode != OfficeStore.MODE_LIVE:
		# A synthetic office performs no provider work, so there is nothing to account for
		# and no invented figure is shown.
		statistics_panel.page = StatisticsPage.new()
		statistics_panel.adopt(statistics_panel.page)
		statistics_panel.page.fail("Statistics read the runtime's own provider accounting, which a synthetic office does not produce.")
		statistics_panel.adopt(statistics_panel.page)
		return
	usage_api.start(session_id)


## Advance the usage read within one frame and hand a settled answer to the page.
##
## A failed read is reported as ERROR with its reason, never as an empty page: "we could not
## read it" and "there is none" are different facts.
func _settle_usage() -> void:
	if usage_api == null or not usage_api.is_pending():
		return
	if store.mode != OfficeStore.MODE_LIVE:
		return
	var usage := usage_api.poll()
	if usage_api.is_pending():
		return
	var page := StatisticsPage.new()
	if not usage_api.last_error().is_empty():
		page.fail(usage_api.last_error())
		statistics_panel.adopt(page)
		return
	page.adopt(usage, usage_api.session_id())
	# A projection known to be incomplete marks its figures stale, because a partial total
	# must not read as the whole picture.
	if store.is_stale():
		page.mark_stale("The projection was reloaded after a reconnect.")
	statistics_panel.adopt(page)


## Read provider account limits. Best effort and STARTED rather than waited on: a quota read
## polls the providers, so it must never stall the window or block sending a prompt.
func refresh_quota() -> void:
	if provider_usage_api == null or statistics_panel == null:
		return
	if store.mode != OfficeStore.MODE_LIVE:
		# A synthetic office has no provider account, so there is no quota to report and none
		# is invented.
		statistics_panel.adopt_quota(QuotaPage.empty())
		return
	provider_usage_api.start()


## Advance the quota read and hand a settled answer to the quota tab.
func _settle_quota() -> void:
	if provider_usage_api == null or not provider_usage_api.is_pending():
		return
	if store.mode != OfficeStore.MODE_LIVE:
		return
	var snapshots := provider_usage_api.poll()
	if provider_usage_api.is_pending():
		return
	var page := QuotaPage.new()
	var freshness := QuotaPage.FRESH
	if not provider_usage_api.last_error().is_empty():
		freshness = QuotaPage.ERROR
	# A snapshot the runtime itself marks stale makes the page stale: freshness is the
	# runtime's statement, not a measurement made here.
	for snapshot in snapshots:
		if snapshot is Dictionary and str(snapshot.get("status", "")) == "stale":
			freshness = QuotaPage.STALE
	page.adopt(snapshots, QuotaPage.VALID_AT, freshness)
	statistics_panel.adopt_quota(page)


## Export what the statistics surface is showing, because the user asked.
##
## A USER ACTION with no automatic path: this runs only from the surface's own control. The
## file is written under `user://` - the application's own data directory - so nothing is
## placed where the user did not choose, and nothing is uploaded anywhere.
func _on_export_requested() -> void:
	if statistics_panel == null:
		return
	var builder := ExportBuilder.new()
	builder.add_rows(statistics_panel.export_rows())
	var path := "user://statistics-export.csv"
	var error := builder.write_csv(path)
	if error != OK:
		store.last_error = "The export could not be written."
		_refresh_ui()
		return
	store.last_error = "Exported %d rows to %s" % [
		builder.rows_count(), ProjectSettings.globalize_path(path),
	]
	_refresh_ui()


func _settle_models() -> void:
	if store.mode != OfficeStore.MODE_LIVE or not models_api.is_pending():
		return
	var fetched := models_api.poll()
	if models_api.is_pending():
		return
	if fetched.is_empty():
		# Nothing is put in its place: an empty list and the service's own reason are
		# the truthful outcome of a read that settled without models.
		_service_models = []
		prompt_panel.set_models([], "")
		var reason := models_api.last_error()
		if not reason.is_empty():
			store.last_error = reason
		_refresh_ui()
		return
	_service_models = fetched.duplicate()
	prompt_panel.set_models(_service_models, _default_model_ref())
	_refresh_ui()


## Return to synthetic playback, discarding live state.
func start_demo_mode() -> void:
	if store.mode == OfficeStore.MODE_LIVE:
		live.stop()
		# A boot that failed to attach never connected this signal. Connecting a
		# signal twice would raise an engine error, so the disconnect is guarded
		# exactly as the connect in `start_live` is.
		if live.event_ready.is_connected(_on_event):
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
	_boot_with(_read_service_registration())


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
	# FIRST ATTACH READS THE CANONICAL STATE. The feed is volatile and starts from NOW - it
	# replays nothing - so a client that only consumed events would show an empty office even
	# though the service holds sessions. `reload_required` fires on a feed ERROR or an epoch
	# CHANGE, neither of which happens on a first connect, so the initial read has to be asked
	# for here.
	#
	# It runs ONCE per attach: a reconnect already gets its reload from the transport's own
	# error and close paths, and asking twice would read the whole session list twice.
	if state == OfficeStore.CONNECTION_LIVE and not _reloaded_once:
		_reloaded_once = true
		_on_reload_required(store.source_epoch)
	_refresh_ui()


## Whether the initial canonical read has been asked for on this attach.
var _reloaded_once := false


## Arm the one canonical read an attach performs.
##
## Called by `start_live`, so every attach - first or reconnect - asks for the state once. It
## is a named operation rather than an assignment so the rule has one home.
func _rearm_canonical_read() -> void:
	_reloaded_once = false





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


## Answer a pending request from the drawer, and report a refusal.
##
## The chosen reply is already a schema literal when it arrives, so this only has
## to carry it. DEMO has nothing to answer, and the helper says so rather than
## pretending an approval happened.
## Stop the session the drawer is showing.
##
## The session is passed in rather than resolved from the selection: the drawer shows ONE
## session, and a user who stops from there means that one. Resolving the selection instead
## would stop whatever happened to be selected, which is the cross-project mistake this
## programme keeps finding.
func _on_drawer_stop(session_id: String) -> void:
	if session_id.is_empty():
		prompt_panel.show_notice(PromptPanel.STOP_DISABLED_REASON)
		return
	var reason := stop_session(session_id)
	if not reason.is_empty():
		prompt_panel.show_notice(reason)


func _on_attention_replied(request_id: String, body: Dictionary) -> void:
	var error := answer_attention(request_id, body)
	if not error.is_empty():
		prompt_panel.show_notice(error)
		return
	_refresh_ui()
	if conversation_panel.visible and store.selected_actor() != null:
		conversation_panel.show_actor(
			store,
			store.selected_actor().identity.session_id,
			zone_for(store.selected_actor().identity.session_id)
		)


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
	_retire_admitted_prompt(event)
	_react(event, previous)
	_refresh_ui()


## Retire the composer's prompt id once the service durably admits it.
##
## This is the confirmation, not the request returning: a queued request can still
## time out, and a retry after that timeout has to reuse the id so the service
## reconciles it rather than admitting the same prompt twice.
func _retire_admitted_prompt(event: Dictionary) -> void:
	if str(event.get("type", "")) != Wire.INPUT_ADMITTED:
		return
	var data: Dictionary = event.get("data", {})
	if str(data.get("inputID", "")) != _pending_prompt_id:
		return
	_pending_prompt_id = ""
	_pending_prompt_text = ""
	_pending_prompt_target = ""


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
		# Each module owns its own transport, so each is polled once per frame.
		# They are bounded and return promptly when there is nothing to read.
		sessions_api.poll()
		conversation_api.poll()
		_settle_models()
		_settle_usage()
		_settle_quota()
		_settle_config()
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
	var reason := live.submit_prompt(session_id, text, _prompt_message_id(session_id, text))
	if reason.is_empty():
		# The request is QUEUED, not admitted: `submit_prompt` returns before the
		# service answers, and an HTTP timeout can still land after this returns. The
		# id is therefore kept until the durable `session.input.admitted` for it is
		# observed, so a retry after a timeout reconciles instead of double-admitting.
		prompt_panel.show_notice("Sent to " + _session_label(session_id))
		return
	# A refusal also keeps the id: the user is most likely to retry the same draft,
	# and that retry must reconcile rather than double-admit.
	prompt_panel.show_notice(reason)


## Stop the work the user asked to stop: the same session a prompt would go to,
## because that is the work the composer is about.
func _on_stop_requested() -> void:
	if store.mode != OfficeStore.MODE_LIVE:
		prompt_panel.show_notice(PromptPanel.STOP_DEMO_REASON)
		return
	var session_id := _prompt_target()
	if session_id.is_empty():
		prompt_panel.show_notice(PromptPanel.STOP_DISABLED_REASON)
		return
	var reason := stop_session(session_id)
	if not reason.is_empty():
		prompt_panel.show_notice(reason)


## The session a prompt goes to: the selected actor when there is one, else the
## root session, which is what the office is about when nothing is selected.
func _prompt_target() -> String:
	var actor := store.selected_actor()
	if actor != null and not actor.identity.session_id.is_empty():
		return actor.identity.session_id
	return store.root_session_id


## A unique suffix for a prompt id, shaped like the service's own ascending ids so a
## retry is distinguishable from a new input by value alone.
func _new_prompt_token() -> String:
	var token := ""
	for _byte in 10:
		token += "abcdefghijklmnopqrstuvwxyz0123456789"[randi() % 36]
	return "%d%s" % [Time.get_unix_time_from_system(), token]


## The id for the draft the composer is holding.
##
## The service reconciles an EXACT retry only when the session, prompt and delivery
## mode match, so the id must survive the retry it is meant to reconcile. Deriving
## it from the second-resolution clock defeated that: a timeout retry more than a
## second later produced a NEW id, which the service admitted as a second prompt
## instead of reconciling. The id is therefore created once per draft and reused
## until the draft is replaced by a successful send.
##
## A deliberate resend of the same text is still a new input, because the id is
## retired on success and the next send mints a fresh one.
func _prompt_message_id(target: String, text: String) -> String:
	if (
		_pending_prompt_id.is_empty()
		or text != _pending_prompt_text
		or target != _pending_prompt_target
	):
		_pending_prompt_target = target
		_pending_prompt_text = text
		_pending_prompt_id = "msg_office_%s" % _new_prompt_token()
	return _pending_prompt_id


## How the composer names the session it sent to. Falls back to the id so the
## notice never claims a role the projection did not produce.
func _session_label(session_id: String) -> String:
	var actor := store.actor_for(session_id)
	if actor != null and not actor.identity.display_role.is_empty():
		return actor.identity.display_role
	return session_id


## The model references in play.
##
## DEMO has no server, so the synthetic catalogue stands in and is labelled as such
## by `ModelCatalog.is_demo_catalog`. LIVE has no synthetic fallback at all: the
## list is either what the service sent or empty, so a fabricated entry is never
## presented as the runtime's.
func _model_catalog() -> Array:
	if store.mode != OfficeStore.MODE_DEMO:
		return _service_models
	return ModelCatalog.demo_catalog()


## The folder work would actually land in, and therefore the folder the composer
## names.
##
## A prompt goes to the session `_prompt_target` resolves, so the name comes from
## THAT session's own directory. Showing the last folder the picker returned while a
## session in another project is selected would name a folder the prompt never
## reaches. With no session to aim at, the folder a new session would be created in
## is the thing being chosen, so that is what is shown.
func _effective_target_location() -> String:
	var target := _prompt_target()
	if not target.is_empty():
		var actor := store.actor_for(target)
		# A synthetic playback reports fixture folders, which are not real places and
		# must never be named as one: DEMO leaves the composer with no folder chosen.
		if (
			actor != null
			and not actor.synthetic
			and not actor.location_directory.is_empty()
		):
			return actor.location_directory
	return folder_target.directory()


## The composer starts on the model the TARGET already reports, so switching work
## does not silently change the model in use - and a model chosen for one project is
## remembered for that project, not for whichever one is opened next.
func _default_model_ref() -> String:
	var target := _prompt_target()
	var chosen := str(_chosen_model_by_target.get(target, ""))
	if not chosen.is_empty():
		return chosen
	# The TARGET's own model. The roster order says nothing about which session the
	# composer is aimed at, so any actor's model would be another project's.
	var actor := store.actor_for(target) if not target.is_empty() else null
	if actor != null and not actor.model_ref.is_empty():
		return actor.model_ref
	return ""


## Adopt the chosen model for the next submission.
##
## In LIVE this is a real request: the service refuses a switch the current
## context cannot fit, and that refusal is reported rather than hidden. DEMO has
## no service, so it only moves the selection.
func _on_model_selected(ref: String) -> void:
	_chosen_model_by_target[_prompt_target()] = ref
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
## Create a session, or say why one was not created.
##
## A new session needs a place to run. The office takes the directory it already
## knows — the one its actors report — so the user is not asked to retype a path
## the product can see. When nothing reports a directory, the create is refused
## with the reason rather than guessing one.
## Open a project the rail asked for, by its opaque local id.
##
## The entry is looked up rather than trusted, so a stale row cannot make the office
## adopt a folder that is no longer in the list.
func _on_project_requested(local_entry_id: String) -> void:
	var entry := project_ledger.find(local_entry_id)
	if entry.is_empty():
		return
	select_folder(str(entry["canonical_directory"]))
	project_ledger.touch(local_entry_id)


## Adopt a folder the user chose.
##
## This is the seam a test drives: a native `FileDialog` cannot be interacted with in a
## headless suite, so the picker delivers a path here and the resolution rules are
## exercised directly. It resolves, reports what it found, and pushes the location to
## the transports.
##
## Choosing a folder is NOT execution consent: this creates no session, submits no
## prompt and starts no work. The user still has to send something.
## What the user is looking at right now, in the shape the store persists.
##
## Read from the panels and the router rather than from bookkeeping, so what is saved is
## what was actually on screen.
func _capture_view_state() -> Dictionary:
	var actor := store.selected_actor()
	var session_id := actor.identity.session_id if actor != null else ""
	var camera: Dictionary = {}
	if office_view != null:
		camera = office_view.capture_view()
	return {
		"selected_session_id": session_id,
		"selected_actor_id": session_id,
		"unsent_draft": prompt_panel.current_text() if prompt_panel != null else "",
		"view_route": router.route(),
		"camera_state": camera,
		# The settings PAGE, not the route: a user who was configuring permissions
		# should return to permissions, and the page belongs to the project it was
		# chosen in like the draft and the camera do.
		"settings_page": settings_panel.page() if settings_panel != null else "",
	}


## Write the project being left and restore the one being entered.
##
## This is the switch transaction: the outgoing project's draft, session, route and
## camera are written BEFORE anything about the incoming project is read, so a switch can
## never leave either project holding the other's state.
func _switch_view_state(entry_id: String) -> void:
	if not _view_entry_id.is_empty() and _view_entry_id != entry_id:
		view_state.remember(_view_entry_id, _capture_view_state())
	_view_entry_id = entry_id
	view_state.set_last_entry_id(entry_id)
	_restore_view_state(entry_id)
	var error := view_state.save()
	if error != OK:
		# A preference that cannot be written is reported rather than swallowed. The
		# office keeps working: the state it holds is still correct, only its survival
		# across a restart is lost.
		store.last_error = view_state.last_error()


## Put a project's saved view state back: the surface, the session, the draft, and where
## the camera was. Every part is optional, so a partial state restores what it can.
func _restore_view_state(entry_id: String) -> void:
	# A project with no saved state starts CLEAN, and that is why this does not return
	# early: returning would leave the composer holding the draft of the project just
	# left, so a thought typed in one project could be sent to another - the same rule the
	# prompt target already follows.
	var saved := view_state.state_for(entry_id)
	# The route is a surface, not work: showing it never starts, moves, or stops anything.
	var route := str(saved.get("view_route", OfficeRoute.DEFAULT))
	router.go(route if OfficeRoute.ALL.has(route) else OfficeRoute.DEFAULT)
	# A saved session that is no longer in the roster is not restored. Selecting a session
	# the office does not have would paint a target that receives nothing.
	var session_id := str(saved.get("selected_session_id", ""))
	var restored := not session_id.is_empty() and store.actor_for(session_id) != null
	if restored:
		store.select_actor(session_id)
		conversation_panel.show_actor(store, session_id, zone_for(session_id))
		office_view.select_actor(session_id)
	else:
		# Nothing to select, so nothing stays selected and the drawer stops showing the
		# project we left. Its rows describe a session this project does not have.
		store.select_actor("")
		conversation_panel.visible = false
	if prompt_panel != null:
		prompt_panel.set_draft(str(saved.get("unsent_draft", "")))
	# The settings page belongs to the project it was chosen in, like the route and the
	# draft: a page left open in one project must not be the page another opens on.
	if settings_panel != null:
		var saved_page := str(saved.get("settings_page", ""))
		settings_panel.show_page_id(
			saved_page if SettingsGroup.is_page(saved_page) else SettingsGroup.default_page()
		)
	var camera: Variant = saved.get("camera_state", {})
	if office_view != null:
		# Validated against the map the office has NOW, because the map may have changed
		# since the state was written and a view parked off it shows the user nothing.
		var safe := OfficeViewState.safe_camera(camera, _navigation())
		if not safe.is_empty():
			office_view.restore_view(
				safe.get("position", office_view.capture_view().get("position", Vector2.ZERO)),
				float(safe.get("zoom", 0.0)),
			)


## The office's navigation, or null before the world is built. Restoring a saved position
## needs it, so the caller reports "nothing to validate against" rather than assuming.
func _navigation() -> OfficeNavigation:
	if office_view == null or office_view.world == null:
		return null
	return office_view.world.navigation


func select_folder(path: String) -> void:
	var resolved := folder_target.resolve(path)
	if resolved.is_empty():
		prompt_panel.show_notice(folder_target.last_error())
		return
	# The transports must actually receive it, or the service still refuses a session
	# for a missing location - which is the defect this exists to fix.
	live.set_location(resolved)
	# The model route is location-scoped too, so the side transport must know the
	# folder or the catalogue would answer for the wrong directory.
	if conversation_api != null and conversation_api.is_pending():
		# A read in flight was scoped to the folder being left, so it cannot answer for the
		# one being entered.
		conversation_api = ConversationApi.new()
		conversation_api.configure(_side_transport())
		conversation_panel.bind_history(conversation_api.history)
	if _side != null:
		_side.set_location(resolved)
	# The configuration owner is LOCATION-SCOPED, so its reader must be rebound to the
	# folder now in front of the user. Rebinding cancels whatever the old transport had in
	# flight, because an answer for the project the user left must not be adopted for the
	# one they are in - the same rule every other location-scoped module follows.
	if config_api != null:
		config_api.configure(_side_transport())
		if config_review != null:
			# The review is re-pointed at the new reader and its armed preview is dropped:
			# a revision validated against another location's document cannot guard a
			# write here.
			config_review.configure(config_api)
			var surface := settings_panel.review_surface() if settings_panel != null else null
			if surface != null:
				surface.invalidate_preview()
				surface.refresh()
		# The new location's effective values are read when the settings page is next
		# shown, so switching projects does not stall the window on a socket.
	# The catalogue is location-scoped, so the list on offer belongs to the folder now
	# chosen. Without this the previous project's models stayed on offer for a project
	# that does not serve them.
	_refresh_models()
	# Remember it, so the project can be returned to next launch. Adding it here is
	# what makes a chosen folder a recent; nothing else about the selection changes.
	var entry := project_ledger.add(resolved)
	project_ledger.save()
	# The project being left is written and the one being entered is read, in that order.
	_switch_view_state(str(entry.get("local_entry_id", "")))
	# After the restore, so the composer names the session the restore actually selected
	# rather than the one that was selected before the switch.
	prompt_panel.set_target(resolved)
	var kind := folder_target.project_kind()
	var branch := folder_target.branch()
	if kind == FolderTarget.KIND_GIT and not branch.is_empty():
		prompt_panel.show_notice("%s · %s" % [resolved.get_file(), branch])
	else:
		prompt_panel.show_notice(resolved.get_file())


## Open the folder picker. A native dialog is used where the platform offers one, and
## the in-engine dialog otherwise, because a window with no picker at all would make
## a new project impossible to add.
func open_folder_picker() -> void:
	var dialog := FileDialog.new()
	dialog.file_mode = FileDialog.FILE_MODE_OPEN_DIR
	dialog.access = FileDialog.ACCESS_FILESYSTEM
	dialog.title = "Choose a project folder"
	if DisplayServer.has_feature(DisplayServer.FEATURE_NATIVE_DIALOG_FILE):
		dialog.use_native_dialog = true
	dialog.dir_selected.connect(func(path: String) -> void:
		select_folder(path)
		dialog.queue_free()
	)
	dialog.canceled.connect(func() -> void: dialog.queue_free())
	add_child(dialog)
	dialog.popup_centered_ratio(0.6)


func _on_new_session() -> void:
	if store.mode != OfficeStore.MODE_LIVE:
		prompt_panel.show_notice("DEMO preview — a new session is not created")
		return
	# A folder the user CHOSE wins over one merely observed from history: their
	# explicit selection is the target they expect. Only when nothing was chosen does
	# the office fall back to what it has actually seen.
	var directory := _target_directory()
	var reason := sessions_api.create_session(directory, selected_agent_id, _default_model_ref())
	if not reason.is_empty():
		prompt_panel.show_notice(reason)
		return
	prompt_panel.show_notice("Creating a session…")


## The folder a session would run in: the one the user chose, else one observed from
## history. Empty when neither exists, which the caller reports rather than
## substituting the process directory.
func _target_directory() -> String:
	if not folder_target.directory().is_empty():
		return folder_target.directory()
	return _known_directory()


## A directory the office has actually observed. Empty when none is known, which
## the caller reports rather than substituting the process directory.
func _known_directory() -> String:
	var observed := store.locations()
	return observed[0] if not observed.is_empty() else ""


## The service created a session. It arrives on the feed too; this only reports it.
func _on_session_created(session_id: String) -> void:
	prompt_panel.show_notice("Session created: " + session_id)


func _on_session_create_failed(reason: String) -> void:
	prompt_panel.show_notice(reason)


func _on_interrupt_failed(session_id: String, reason: String) -> void:
	prompt_panel.show_notice(reason)


## The service accepted the stop. The durable `session.execution.interrupted` event is
## what actually settles the office; this only tells the user the request landed.
func _on_interrupted(session_id: String) -> void:
	prompt_panel.show_notice("Stopping " + _session_label(session_id) + "…")


## Stop the work a session is running.
##
## Interrupting an idle session is a no-op the service accepts, so the guard here
## is only that a session was named.
func stop_session(session_id: String) -> String:
	if store.mode != OfficeStore.MODE_LIVE:
		return "DEMO preview — there is no running work to stop."
	return sessions_api.interrupt_session(session_id)


func _on_agent_selected(agent_id: String) -> void:
	if agent_id.is_empty():
		return
	selected_agent_id = agent_id
	_refresh_ui()


func _on_actor_selected(session_id: String) -> void:
	store.select_actor(session_id)
	_read_history(session_id)
	conversation_panel.show_actor(store, session_id, zone_for(session_id))
	office_view.select_actor(session_id)
	_refresh_ui()


## Begin reading a session's DURABLE history, so what the user opens is the service's record
## rather than only the events this client happened to observe.
##
## The read is started and settles on the frame loop, so opening a session never stalls the
## window behind a socket. DEMO has no service to read from, and the synthetic office's rows
## are its own, so nothing is requested there.
func _read_history(session_id: String) -> void:
	if store.mode != OfficeStore.MODE_LIVE or session_id.is_empty():
		return
	var started := conversation_api.start(session_id)
	if not started and not conversation_api.last_error().is_empty():
		store.last_error = conversation_api.last_error()


## Show or hide a floating panel. The office is a full-bleed scene, so a user who
## wants an unobstructed view hides the chrome rather than resizing anything.
func _on_chrome_toggled(_name: String, _hidden: bool) -> void:
	_apply_chrome_visibility()


## Keyboard shortcuts.
##
## The registry decides WHAT an input means; this decides what it does, which is
## the only place that can, because it owns the panels. Typing always wins: while
## the composer has the caret, only Escape is acted on, so a shortcut can never
## steal a keystroke from the text being written.
func _unhandled_input(event: InputEvent) -> void:
	if capture_mode:
		return
	var action := Shortcuts.intent(event)
	if action.is_empty():
		return
	if prompt_panel.has_input_focus() and action != Shortcuts.DISMISS:
		return
	_apply_shortcut(action)
	get_viewport().set_input_as_handled()


## Perform one shortcut. Each intent maps to a real action the shell already has,
## so a shortcut is never a second path to a different behaviour.
func _apply_shortcut(action: String) -> void:
	var chrome := Shortcuts.chrome_name(action)
	if not chrome.is_empty():
		var hiding := not chrome_toggles.is_hidden(chrome)
		chrome_toggles.set_hidden(chrome, hiding)
		_apply_chrome_visibility()
		# Revealing the composer puts the caret in it, so the shortcut actually ends
		# in a prompt rather than in a panel the user must then click.
		if chrome == "composer" and not hiding:
			prompt_panel.focus_input()
		return
	if Shortcuts.is_selection(action):
		_move_selection(Shortcuts.selection_step(action))
		return
	if action == Shortcuts.TOGGLE_THEME:
		_cycle_theme()
		return
	if action == Shortcuts.TOGGLE_SCALE:
		_cycle_scale()
		return
	if action == Shortcuts.INSPECT:
		# Inspecting with nothing chosen opens the lead, so the shortcut is never a
		# dead key on a fresh window. With nothing in the office at all there is
		# nothing to inspect and the key does nothing.
		var target := store.selected_actor()
		if target == null:
			# The lead is what the office is about when nothing is chosen.
			target = store.actor_for(store.root_session_id)
		if target == null:
			var roster := store.actor_list()
			if roster.is_empty():
				return
			target = roster[0]
		_on_actor_selected(target.identity.session_id)
		return
	if action == Shortcuts.DISMISS:
		# Escape releases what is open, innermost first: the caret, then the drawer.
		if prompt_panel.has_input_focus():
			prompt_panel.release_input_focus()
			return
		if conversation_panel.visible:
			# The same close path the panel's own control uses, so focus return and
			# dirty-state protection cannot differ between the two ways of closing.
			_close_drawer()


## Switch the palette mode and repaint.
##
## The palette changes tones, never presence: every label keeps its colour role, so
## no runtime state is hidden by switching.
func _cycle_theme() -> void:
	OfficeTheme.set_mode(OfficePalette.next_mode(OfficeTheme.mode()))
	_repaint_theme()


## Change the text scale and apply it.
##
## This is a FONT factor, not the window's content scale: a content scale would
## zoom the office art along with the text, so enlarging the interface would also
## magnify the world it exists to present. Every font override resolves through
## `OfficeTheme.font`, so raising this enlarges all text together and the panels
## grow with it.
func _cycle_scale(step: float = -1.0) -> void:
	var next := UiScale.next_scale(ui_scale) if step < 0.0 else UiScale.clamp_scale(step)
	if not OfficeTheme.set_text_scale(next):
		return
	ui_scale = OfficeTheme.text_scale()
	chrome_toggles.set_ui_scale(ui_scale)
	sidebar.set_ui_scale(ui_scale)
	prompt_panel.set_ui_scale(ui_scale)
	# Every font override and every minimum that depends on one is now different, so
	# the surfaces are rebuilt and the regions re-applied.
	_repaint_theme()


## Repaint the surfaces that captured a colour.
##
## Colours read at paint time follow the palette on their own; a StyleBox and a
## theme override capture their value once, so the panels that carry one are
## restyled explicitly. Nothing is rebuilt and no state is reloaded, so switching
## mode cannot change what the office reports.
func _repaint_theme() -> void:
	# A font size is baked into an override when it is set, so every surface is
	# re-scaled before it repaints; otherwise existing text keeps the old size.
	OfficeTheme.rescale(_shell)
	for surface in [sidebar, prompt_panel, conversation_panel, chrome_toggles, settings_panel]:
		if surface != null:
			surface.restyle()
	# Re-scaling changes how wide a panel's contents are, so the regions are applied
	# AFTER the rescale. Applying them first would place the panels against the
	# sizes they had a moment ago, which is how the composer ended up over the rail.
	_apply_regions()
	_refresh_ui()


## A momentary chrome control was pressed.
func _on_chrome_action(name: String) -> void:
	match name:
		"theme":
			_cycle_theme()
		"scale":
			_cycle_scale()


## Move the selection along the roster, wrapping at both ends so the shortcut is
## always useful and never a dead key at the edge.
func _move_selection(step: int) -> void:
	var roster := store.actor_list()
	if roster.is_empty():
		return
	var current := store.selected_actor()
	var index := 0
	if current != null:
		for position in roster.size():
			if roster[position].identity.session_id == current.identity.session_id:
				index = position
				break
	var target := wrapi(index + step, 0, roster.size())
	_on_actor_selected(roster[target].identity.session_id)


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
	# The composer names the folder the prompt would reach, and the target moves with
	# the selection, so the name is re-derived here rather than left at whatever the
	# picker last returned.
	prompt_panel.set_target(_effective_target_location())
	sidebar.set_location(store)
	if selected_agent_id.is_empty():
		selected_agent_id = _default_agent_id()
	sidebar.set_agents(_agent_ids(), selected_agent_id)
	sidebar.refresh(store, demo.is_playing())
	sidebar.set_projects(project_ledger, store)
	office_view.refresh(store)
	# The drawer is the live view of an arriving answer, so it follows every change
	# while it is open. `show_actor` owns the filters; this only redraws the rows.
	if conversation_panel.visible:
		conversation_panel.refresh(store)
	_refresh_stop()


## A Stop control is offered only when there is work it could actually stop: the
## session a prompt would target must be running. Otherwise it is disabled with the
## reason, so the control never claims a capability the office does not have.
func _refresh_stop() -> void:
	if store.mode != OfficeStore.MODE_LIVE:
		prompt_panel.set_stop_available(false, PromptPanel.STOP_DEMO_REASON)
		return
	var actor := store.actor_for(_prompt_target())
	var working := actor != null and Presence.is_working(actor.work_state)
	prompt_panel.set_stop_available(working)


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


## Show a route the rail asked for.
##
## The router refuses an unknown route, so nothing here can leave the shell with no
## surface. Routing changes what is displayed and nothing else: no transport, store
## or permission state is touched, which is what the acceptance requires.
func _on_route_requested(route: String) -> void:
	router.go(route)


## Apply a route change to the surfaces.
##
## The spatial world and its composer are shown only on the Office route; the
## detail routes would otherwise sit behind a world that is not the thing the user
## asked for. The runtime subscriptions are NOT touched here: work keeps running
## and attention stays queued whichever surface is showing.
func _on_route_changed(route: String) -> void:
	sidebar.set_route(route)
	_apply_route_visibility()


## The settings page asked to close. Closing means returning to the office, which is
## the surface a settings visit interrupts. It routes; it does not touch work.
func _on_settings_close_requested() -> void:
	router.go(OfficeRoute.OFFICE)


## The user asked to read the effective configuration. This is a READ: it changes no
## value and writes no file.
##
## A read is STARTED rather than waited on, so opening the page never stalls the window
## on a socket. `_settle_config` advances it on the frame loop.
func _on_config_read_requested() -> void:
	if config_review == null:
		return
	config_review.begin_read()


## The user asked to validate an edit. This calls preview, which writes NOTHING: it is
## what makes the apply control's guarantee real, because only text a preview accepted
## can be committed.
func _on_config_preview_requested(key: String, text: String) -> void:
	if config_review == null:
		return
	if not config_review.begin_preview(key, text):
		_refresh_config_surface()
		return
	# A preview is a round trip and the review owns the poll, so nothing more is needed
	# here; the settled answer arms the apply control through the panel.


## The user chose a write scope. The review owns which document a write targets, so the
## choice is handed to it; a change invalidates any preview validated elsewhere.
func _on_settings_scope_changed(scope: String) -> void:
	if config_review == null:
		return
	config_review.set_chosen_scope(scope)
	# A preview validated against another document's revision cannot arm a write here, so
	# the surface is told to disarm rather than being left showing a stale revision.
	var surface := settings_panel.review_surface() if settings_panel != null else null
	if surface != null:
		surface.invalidate_preview()
	_refresh_config_surface()


## The user asked to remove a key. Removal goes through the SAME revision-aware path as an
## edit: a preview validates the removal against the document's current revision, and only
## a settled preview arms the commit.
func _on_config_remove_requested(key: String) -> void:
	if config_review == null:
		return
	if not config_review.begin_preview_removal(key):
		_refresh_config_surface()
		return


## The user asked to commit a validated removal.
func _on_config_remove_commit_requested(key: String, expected_revision: String) -> void:
	if config_review == null:
		return
	if not config_review.begin_commit_removal(key, expected_revision):
		_refresh_config_surface()
		return


## The user asked to write the previewed value. The revision is the one the PREVIEW
## validated against, so a concurrent edit between preview and commit is refused by the
## service rather than overwritten.
func _on_config_commit_requested(key: String, text: String, expected_revision: String) -> void:
	if config_review == null:
		return
	if not config_review.begin_commit(key, text, expected_revision):
		_refresh_config_surface()
		return


## Advance the configuration read/preview/commit within one frame and hand a settled
## answer to the surface.
##
## The commit path adopts the service's settled readback through `ConfigReview`, so what
## the page shows after a write is what the service reports, never the patch this client
## sent.
func _settle_config() -> void:
	if config_review == null or config_api == null or not config_api.is_pending():
		return
	var kind := config_api.pending_kind()
	match kind:
		ConfigApi.KIND_READ:
			if config_review.poll():
				_refresh_config_surface()
		ConfigApi.KIND_PREVIEW:
			# The identity captured when the request was MADE, before the answer is
			# applied. Comparing against the editor's current contents instead would let an
			# edit made while the call was in flight be blessed by an answer that
			# validated different text.
			var asked := config_review.pending_request()
			if config_review.poll_preview():
				var surface := settings_panel.review_surface() if settings_panel != null else null
				if surface != null:
					if not config_review.last_error().is_empty():
						surface.refusal_settled()
					elif bool(asked.get("removal", false)):
						# A removal arms Apply for a `null` write, which is a different
						# payload from an edit of the same key.
						surface.removal_settled(str(asked.get("key", "")), config_review.preview_revision())
					else:
						surface.preview_settled(
							str(asked.get("key", "")),
							str(asked.get("text", "")),
							config_review.preview_revision(),
							str(asked.get("scope", "")),
							config_review.resolved_directory(),
						)
				_refresh_config_surface()
		ConfigApi.KIND_COMMIT:
			if config_review.poll_commit():
				var surface := settings_panel.review_surface() if settings_panel != null else null
				if surface != null:
					# A refusal keeps the editor's text: the user's edit is what was
					# refused, and discarding it would lose their work. A success clears
					# the editor, because the readback is now the effective value.
					if config_review.last_error().is_empty():
						surface.commit_settled()
					else:
						surface.refusal_settled()
				_refresh_config_surface()


## Repaint the configuration surface from the review's current state.
func _refresh_config_surface() -> void:
	if settings_panel == null or settings_panel.review_surface() == null:
		return
	settings_panel.review_surface().refresh()


func _apply_route_visibility() -> void:
	var shows_world := router.shows_world()
	office_view.visible = shows_world
	prompt_panel.visible = shows_world
	# The Statistics surface owns the content region on its own route, and nothing else
	# renders there. It refreshes on show, so the figures are read when looked at rather
	# than on a background timer.
	#
	# Guarded on the panel's existence: this is called from `_ready`, but also from route
	# changes and from a hand-built shell, and a shell without the surface simply has no
	# surface to show.
	if statistics_panel != null:
		statistics_panel.visible = router.route() == OfficeRoute.STATISTICS
		if statistics_panel.visible:
			statistics_panel.show_page(store)
			refresh_statistics()
			refresh_quota()
	# The Settings surface owns the content region on its own route. It is shown the
	# store so its scope selector knows whether a folder and a session are actually
	# present, which is what makes a narrow scope valid.
	#
	# The PANEL owns the page it is showing; this only hands it fresh context, so a
	# repaint cannot reset the page under the user.
	if settings_panel != null:
		settings_panel.visible = router.route() == OfficeRoute.SETTINGS
		if settings_panel.visible:
			settings_panel.show_page(store)
			# The page is read when it is first looked at, not on a background timer, so
			# opening Settings shows the effective configuration without a poll running
			# while nobody is looking. A read in flight is awaited; a settled one is not
			# repeated. A read that FAILED is retried, because the user opening the page is
			# the moment they are asking for it.
			if config_review != null and config_review.state() != ConfigReview.READY:
				config_review.begin_read()
	# The drawer is NOT closed when the office is left. It speaks for one session - its
	# pending requests and its transcript - and a session that is blocked does not stop being
	# blocked because the user looked at Statistics. The kit requires human-attention banners
	# to stay reachable on every route with project and family identity, and the drawer is
	# that surface. Leaving it shown is also what keeps answering from stealing focus: the
	# user replies and carries on where they were.


## Close the contextual drawer.
##
## Closing is how the user gets back to the office, so it must not strand the caret
## inside a panel they can no longer see: focus returns to the composer, which is
## where the next action happens.
##
## The composer's DRAFT IS NEVER DISCARDED by closing a panel that merely describes
## work. The draft lives in the composer, not here, so there is nothing to lose -
## but the rule is stated and asserted rather than left as an accident of ownership.
func _close_drawer() -> void:
	conversation_panel.visible = false
	if router.shows_world():
		prompt_panel.focus_input()
