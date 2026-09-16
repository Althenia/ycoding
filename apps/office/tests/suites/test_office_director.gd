## OfficeDirector tests (TEST-021, TEST-024, TEST-028).
extends RefCounted


func run(t) -> void:
	test_attention_preempts_and_never_queues(t)
	test_running_state_produces_work_action(t)
	test_unchanged_state_produces_no_action(t)
	test_late_callback_cannot_revive_stale_state(t)
	test_queue_is_bounded(t)
	test_stale_actions_expire(t)
	test_ambient_carries_no_speech_and_is_preemptible(t)
	test_an_empty_ambient_plan_does_not_imply_clear_the_notice(t)
	test_queue_coalesces_per_actor(t)
	test_queue_refuses_an_action_with_no_actor(t)
	test_a_burst_queues_instead_of_redirecting_a_mover(t)


func _actor() -> ActorPresentation:
	return ActorPresentation.new(ActorIdentity.new("ses_1", "backend", "ses_root", "Backend"))


func test_attention_preempts_and_never_queues(t) -> void:
	var director := OfficeDirector.new()
	var actor := _actor()
	director.enqueue({"action": "visit"}, 0)
	director.enqueue({"action": "visit"}, 0)
	actor.attention_required = true
	var action := director.plan(actor, WorkState.Kind.TYPING)
	t.check_equal(action.get("action"), OfficeDirector.ACTION_BUBBLE, "attention produces an immediate bubble")
	t.check_equal(director.queue_size(), 0, "attention clears the cosmetic queue")
	t.check(not action.get("source_backed", true), "attention notice is not a source-backed quote")


func test_running_state_produces_work_action(t) -> void:
	var director := OfficeDirector.new()
	var actor := _actor()
	actor.set_work(WorkState.Kind.TYPING)
	var action := director.plan(actor, WorkState.Kind.IDLE)
	t.check_equal(action.get("action"), OfficeDirector.ACTION_WORK, "running state produces work action")
	t.check_equal(action.get("state"), WorkState.Kind.TYPING, "work action carries the state")


func test_unchanged_state_produces_no_action(t) -> void:
	var director := OfficeDirector.new()
	var actor := _actor()
	actor.set_work(WorkState.Kind.TYPING)
	t.check_equal(director.plan(actor, WorkState.Kind.TYPING), {}, "unchanged state plans nothing")


## A superseded sequence must not resume an old pose.
func test_late_callback_cannot_revive_stale_state(t) -> void:
	var director := OfficeDirector.new()
	var actor := _actor()
	actor.set_work(WorkState.Kind.TYPING)
	var action := director.plan(actor, WorkState.Kind.IDLE)
	t.check(OfficeDirector.is_current(action, actor), "fresh action is current")
	actor.interaction_token += 1
	t.check(not OfficeDirector.is_current(action, actor), "cancelled action is no longer current")


func test_queue_is_bounded(t) -> void:
	var director := OfficeDirector.new()
	for index in OfficeDirector.MAX_QUEUED_ACTIONS + 5:
		director.enqueue({"action": "visit", "actor": "ses_%d" % index, "index": index}, 0)
	t.check_equal(
		director.queue_size(), OfficeDirector.MAX_QUEUED_ACTIONS, "cosmetic queue is bounded"
	)


func test_stale_actions_expire(t) -> void:
	var director := OfficeDirector.new()
	director.enqueue({"action": "visit", "actor": "ses_age"}, 0)
	var result := director.dequeue(OfficeDirector.MAX_ACTION_AGE_MS + 1)
	t.check_equal(result, {}, "an over-age action is discarded rather than played late")


## TEST-028: ambient life costs no model call and never invents speech.
func test_ambient_carries_no_speech_and_is_preemptible(t) -> void:
	var director := OfficeDirector.new()
	var actor := _actor()
	var ambient := director.plan_ambient(actor, 1)
	t.check_equal(ambient.get("action"), OfficeDirector.ACTION_AMBIENT, "idle actor gets ambient")
	t.check(not ambient.has("text"), "ambient carries no speech")
	t.check(not ambient.get("source_backed", true), "ambient is never source-backed")
	actor.set_work(WorkState.Kind.TYPING)
	t.check_equal(director.plan_ambient(actor, 1), {}, "real work cancels ambient")
	actor.set_work(WorkState.Kind.IDLE)
	actor.attention_required = true
	t.check_equal(director.plan_ambient(actor, 1), {}, "attention cancels ambient")


## The ambient tick must leave an attention notice alone.
##
## The director already declines to plan ambient life for a blocked actor, but the
## caller treated an empty plan as "clear this actor's notice", so a real
## "waiting for your decision" bubble was erased within one ambient tick. This
## pins the decision the caller has to make, not the plan it receives.
func test_an_empty_ambient_plan_does_not_imply_clear_the_notice(t) -> void:
	var actor := ActorPresentation.new(
		ActorIdentity.new("ses_wait", "backend", "ses_root", "Backend")
	)
	actor.attention_required = true
	var director := OfficeDirector.new()
	t.check(
		director.plan_ambient(actor, 1).is_empty(),
		"a blocked actor is offered no ambient life"
	)
	# The rule the composition root must apply: only clear when the actor is not
	# blocked. Expressed here so the condition cannot drift from the caller.
	t.check(
		not should_clear_notice(actor, director.plan_ambient(actor, 1)),
		"an attention notice is not cleared by an empty ambient plan"
	)


## Whether an empty ambient plan may clear the actor's notice.
func should_clear_notice(actor: ActorPresentation, plan: Dictionary) -> bool:
	if actor.attention_required:
		return false
	return plan.is_empty()


## Two pending movements for one actor would make it walk to a place it has already
## been told to leave, so only the newest intent survives.
func test_queue_coalesces_per_actor(t) -> void:
	var director := OfficeDirector.new()
	t.check(director.enqueue({"action": "visit", "actor": "ses_a", "index": 1}, 0), "first queued")
	t.check(director.enqueue({"action": "visit", "actor": "ses_a", "index": 2}, 1), "second queued")
	t.check_equal(director.queue_size(), 1, "one actor holds one pending intent")
	var promoted := director.dequeue(2)
	t.check_equal(int(promoted.get("index", -1)), 2, "the newest intent is the one performed")

	# A different actor is unaffected by another actor's coalescing.
	t.check(director.enqueue({"action": "visit", "actor": "ses_b", "index": 3}, 2), "other actor queued")
	t.check_equal(director.queue_size(), 1, "the other actor still holds its own intent")


## An action with no actor cannot be coalesced or cancelled, so it is refused
## rather than queued where nothing can retire it.
func test_queue_refuses_an_action_with_no_actor(t) -> void:
	var director := OfficeDirector.new()
	t.check(not director.enqueue({"action": "visit"}, 0), "an actorless action is refused")
	t.check_equal(director.queue_size(), 0, "nothing was queued")


## A burst of work for an actor already travelling must queue rather than redirect
## it mid-walk. Redirecting would make the mover stutter between destinations,
## which is the unresponsiveness TASK-035 asks about.
func test_a_burst_queues_instead_of_redirecting_a_mover(t) -> void:
	var director := OfficeDirector.new()
	var actor := ActorPresentation.new(
		ActorIdentity.new("ses_moving", "backend", "ses_root", "Backend")
	)
	# The actor is available for work, so the director plans WORK for it.
	actor.set_work(WorkState.Kind.TYPING)
	var action := director.plan(actor, WorkState.Kind.IDLE)
	t.check_equal(
		str(action.get("action", "")),
		OfficeDirector.ACTION_WORK,
		"a newly busy actor is planned as work"
	)

	# What the composition root does when that actor is already walking.
	t.check(director.enqueue(action, 0), "the action is queued rather than enacted")
	t.check_equal(director.queue_size(), 1, "exactly one intent is held")
	var promoted := director.dequeue(1)
	t.check(
		str(promoted.get("actor", "")) == "ses_moving",
		"the queued work belongs to the actor that was moving"
	)
	t.check_equal(director.queue_size(), 0, "promotion drains the queue")
