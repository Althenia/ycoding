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
		director.enqueue({"action": "visit", "index": index}, 0)
	t.check_equal(
		director.queue_size(), OfficeDirector.MAX_QUEUED_ACTIONS, "cosmetic queue is bounded"
	)


func test_stale_actions_expire(t) -> void:
	var director := OfficeDirector.new()
	director.enqueue({"action": "visit"}, 0)
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
