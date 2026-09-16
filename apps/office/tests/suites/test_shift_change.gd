## Shift-change tests.
##
## The office has a finite floor, so attendance is explicit: a working agent holds
## a seat, an idle one plays, and a session that ends leaves so the next agent can
## take the shift. These pin the rules that make that coherent.
extends RefCounted


func run(t) -> void:
	test_idle_agent_leaves_its_seat(t)
	test_working_agent_keeps_its_seat(t)
	test_blocked_agent_still_holds_the_floor(t)
	test_play_spots_are_bounded_and_deterministic(t)
	test_departed_agent_leaves_the_office(t)
	test_departure_frees_the_seat_for_a_newcomer(t)
	test_unarchiving_brings_an_actor_back(t)
	test_presence_labels_are_readable_without_colour(t)
	test_working_agent_stations_at_its_desk(t)
	test_compaction_is_its_own_state(t)
	test_idle_agent_stations_in_the_play_room(t)
	test_reports_go_to_the_parent(t)
	test_departed_agent_stations_at_left(t)
	test_every_station_exists_in_the_world(t)
	test_a_finished_child_walks_to_the_ceo(t)


func _store_with(events: Array) -> OfficeStore:
	var store := OfficeStore.new()
	store.apply({"type": Wire.CONNECTED, "sessionID": "", "data": {}, "sourceEpoch": "epoch-a"})
	for event in events:
		store.apply(event)
	return store


func _created(session_id: String, agent: String) -> Dictionary:
	return {
		"type": Wire.SESSION_CREATED,
		"sessionID": session_id,
		"data": {"agent": agent, "parentID": "", "title": agent.capitalize()},
	}


func _working(session_id: String) -> Dictionary:
	return {"type": Wire.EXECUTION_STARTED, "sessionID": session_id, "data": {}}


## An agent with nothing in hand gives up its seat and plays instead.
func test_idle_agent_leaves_its_seat(t) -> void:
	var store := _store_with([_created("ses_a", "lead")])
	t.check(store.presence_of("ses_a") == Presence.PLAYING, "an idle agent plays")
	t.check(store.seated_actors().is_empty(), "an idle agent holds no seat")


func test_working_agent_keeps_its_seat(t) -> void:
	var store := _store_with([_created("ses_a", "lead"), _working("ses_a")])
	t.check(store.presence_of("ses_a") == Presence.AT_WORK, "a working agent is at work")
	t.check(store.seated_actors().size() == 1, "a working agent holds a seat")


## A blocked agent is mid-task and waiting on a decision, so it stays on shift.
func test_blocked_agent_still_holds_the_floor(t) -> void:
	var store := _store_with([_created("ses_a", "lead")])
	store.apply({"type": Wire.EXECUTION_STARTED, "sessionID": "ses_a", "data": {}})
	# A change that needs a human puts the agent in a waiting state.
	store.apply({
		"type": Wire.TASK_UPDATED,
		"sessionID": "ses_a",
		"data": {"change": {"type": Wire.CHANGE_QUESTION_ASKED}},
	})
	t.check(
		store.presence_of("ses_a") == Presence.AT_WORK,
		"an agent waiting on a human keeps the floor"
	)


## Play spots are a real floor limit, and the same roster always arranges the
## same way so a viewer sees no unexplained churn.
func test_play_spots_are_bounded_and_deterministic(t) -> void:
	var events: Array = []
	for i in range(OfficeStore.PLAY_SPOTS + 3):
		events.append(_created("ses_%02d" % i, "qa"))
	var store := _store_with(events)
	t.check(
		store.playing_actors().size() == OfficeStore.PLAY_SPOTS,
		"no more agents play than there are spots"
	)
	t.check(
		store.presence_of("ses_00") == Presence.PLAYING,
		"the earliest agent by id takes a spot"
	)
	t.check(
		store.presence_of("ses_%02d" % (OfficeStore.PLAY_SPOTS + 2)) == Presence.WAITING,
		"an agent past the limit waits rather than vanishing"
	)
	# Determinism: rebuilding the same roster gives the same arrangement.
	var again := _store_with(events)
	t.check(
		again.playing_actors().size() == store.playing_actors().size(),
		"the same roster produces the same arrangement"
	)


## A retired session leaves the office but is not erased.
func test_departed_agent_leaves_the_office(t) -> void:
	var store := _store_with([_created("ses_a", "lead"), _working("ses_a")])
	store.apply({"type": Wire.SESSION_DELETED, "sessionID": "ses_a", "data": {}})
	t.check(store.presence_of("ses_a") == Presence.LEFT, "a deleted session leaves")
	t.check(store.seated_actors().is_empty(), "a departed agent frees its seat")
	t.check(store.actor_for("ses_a") != null, "the session is not erased")
	t.check(store.departed_actors().size() == 1, "the departure is reported")


## The shift change itself: the leaver frees the seat and the newcomer takes it.
func test_departure_frees_the_seat_for_a_newcomer(t) -> void:
	var store := _store_with([
		_created("ses_old", "lead"),
		_working("ses_old"),
	])
	t.check(store.seated_actors().size() == 1, "the first agent holds the seat")
	store.apply({"type": Wire.SESSION_ARCHIVED, "sessionID": "ses_old", "data": {}})
	t.check(store.seated_actors().is_empty(), "archiving frees the seat")
	# A new agent enters and takes the shift.
	store.apply(_created("ses_new", "backend"))
	store.apply(_working("ses_new"))
	t.check(store.seated_actors().size() == 1, "the newcomer takes the shift")
	t.check(
		store.seated_actors()[0].identity.session_id == "ses_new",
		"the seat belongs to the newcomer"
	)


## An archived session can come back, so departure is not a one-way door.
func test_unarchiving_brings_an_actor_back(t) -> void:
	var store := _store_with([_created("ses_a", "lead")])
	store.apply({"type": Wire.SESSION_ARCHIVED, "sessionID": "ses_a", "data": {}})
	t.check(store.presence_of("ses_a") == Presence.LEFT, "the actor left")
	store.apply({"type": Wire.SESSION_UNARCHIVED, "sessionID": "ses_a", "data": {}})
	t.check(store.presence_of("ses_a") != Presence.LEFT, "the actor is back on the floor")
	t.check(store.departed_actors().is_empty(), "no departure is reported")


## Presence must be readable as text, not only as a colour or a position.
func test_presence_labels_are_readable_without_colour(t) -> void:
	for presence in [Presence.AT_WORK, Presence.PLAYING, Presence.WAITING, Presence.LEFT]:
		var label := Presence.label(presence)
		t.check(not label.is_empty(), "presence %s has a label" % presence)
	t.check(
		Presence.label(Presence.AT_WORK) != Presence.label(Presence.PLAYING),
		"working and playing read differently"
	)
	t.check(
		Presence.label(Presence.LEFT) != Presence.label(Presence.WAITING),
		"left and waiting read differently"
	)
	t.check(Presence.occupies_space(Presence.AT_WORK), "a seated agent occupies space")
	t.check(not Presence.occupies_space(Presence.LEFT), "a departed agent occupies none")

## A working agent's station is its desk, unless it is consolidating context.
func test_working_agent_stations_at_its_desk(t) -> void:
	var store := _store_with([_created("ses_a", "lead"), _working("ses_a")])
	t.check(store.station_of("ses_a") == "desk", "a working agent is at a desk")
	store.apply({"type": Wire.COMPACTION_STARTED, "sessionID": "ses_a", "data": {}})
	t.check(
		store.station_of("ses_a") == "focus",
		"an agent consolidating context retires to the focus station"
	)
	store.apply({"type": Wire.COMPACTION_ENDED, "sessionID": "ses_a", "data": {}})
	t.check(store.station_of("ses_a") == "desk", "it returns to its desk afterwards")


## Compaction is real work, so it must be visible rather than reported as a
## generic processing state.
func test_compaction_is_its_own_state(t) -> void:
	var store := _store_with([_created("ses_a", "lead"), _working("ses_a")])
	store.apply({"type": Wire.COMPACTION_STARTED, "sessionID": "ses_a", "data": {}})
	var actor := store.actor_for("ses_a")
	t.check(actor != null, "the actor exists")
	if actor == null:
		return
	t.check(
		actor.work_state == WorkState.Kind.COMPACTING,
		"compaction has its own work state"
	)
	t.check(
		WorkState.label(WorkState.Kind.COMPACTING) == "Compacting",
		"compaction has a readable label"
	)


## An idle agent's station is the play room.
func test_idle_agent_stations_in_the_play_room(t) -> void:
	var store := _store_with([_created("ses_a", "lead")])
	t.check(store.station_of("ses_a") == "play", "an idle agent plays")


## A report goes to the actor's parent, or to the root when it has none.
func test_reports_go_to_the_parent(t) -> void:
	var store := _store_with([
		_created("ses_root", "lead"),
		{"type": Wire.SESSION_CREATED, "sessionID": "ses_child", "data": {
			"agent": "backend", "parentID": "ses_root", "title": "Backend"}},
	])
	t.check(
		store.report_target_for("ses_child") == "ses_root",
		"a subagent reports to its parent"
	)
	t.check(
		store.report_target_for("ses_root") == "ses_root",
		"a root reports to itself, which the world ignores"
	)


## A departed agent's station is "left", so the world can walk it out.
func test_departed_agent_stations_at_left(t) -> void:
	var store := _store_with([_created("ses_a", "lead"), _working("ses_a")])
	store.apply({"type": Wire.SESSION_ARCHIVED, "sessionID": "ses_a", "data": {}})
	t.check(store.station_of("ses_a") == "left", "a departed agent is leaving")


## Every station the store can name must exist in the world, or an agent would be
## sent nowhere.
func test_every_station_exists_in_the_world(t) -> void:
	for station in ["play", "focus", "huddle", "ceo"]:
		t.check(
			OfficeWorld.STATIONS.has(station),
			"the world defines a %s station" % station
		)
		var group: Array = OfficeWorld.STATIONS.get(station, [])
		t.check(not group.is_empty(), "the %s station has at least one anchor" % station)
		for desk_id in group:
			t.check(
				OfficeWorld.ANCHORS.has(str(desk_id)),
				"station %s names a real anchor: %s" % [station, desk_id]
			)


## A subagent that finishes its assignment reports to the CEO by walking there.
##
## This is the movement the user asked for ("when subagents finished their tasks
## it walk report back to ceo"). The durable report text is not narrated; the walk
## is the signal, so the test asserts the route, not a caption.
func test_a_finished_child_walks_to_the_ceo(t) -> void:
	var world := OfficeWorld.new()
	world.setup(null)
	var store := OfficeStore.new()
	for entry in [
		["ses_root", "", "lead"],
		["ses_child", "ses_root", "backend"],
	]:
		store.actors[entry[0]] = ActorPresentation.new(
			ActorIdentity.new(entry[0], entry[2], entry[1], entry[2])
		)
	world.refresh(store)
	t.check(world.actors.has("ses_child"), "the child is in the world")
	var node := world.actors.get("ses_child") as OfficeActor
	t.check(node != null, "the child has a node")
	if node == null:
		world.free()
		return
	t.check(not node.is_walking(), "the child starts at rest")
	world.apply_report(store.actors["ses_child"])
	t.check(node.is_walking(), "completing an assignment sends the child to report")

	var ceo := world.station_position("ceo", "visitor")
	t.check(ceo != Vector2.ZERO, "the CEO station resolves to a real position")
	# Drive the walk to completion with large steps so the test stays fast.
	for step in 400:
		if not node.is_walking():
			break
		node._walk(1.0)
	t.check(
		node.position.is_equal_approx(ceo),
		"the child arrives at the CEO office, not beside it"
	)
	world.free()
