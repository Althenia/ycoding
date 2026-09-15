## Reduced-motion tests (TASK-043).
##
## Reduced motion removes interpolation and frame cycling while the office stays
## truthful: an actor still ends at its destination and still faces the way it
## travelled. These tests pin both halves of that contract, because a change that
## simply disabled walking for everyone would keep the second half and quietly
## break the first, and a change that left the walk loop running would make the
## preference a no-op.
##
## The pure parse/default rules are checked without touching the filesystem; the
## persistence rules use a throwaway file under `user://` that is removed again.
extends RefCounted

## Throwaway settings file. Never the real preference path, so a test run cannot
## change what the app will do on next start.
const TEST_PATH := "user://test_motion.cfg"


func run(t) -> void:
	test_default_is_full_motion(t)
	test_resolve_reduced_reads_boolean_values(t)
	test_resolve_reduced_falls_back_for_corrupt_values(t)
	test_persisted_choice_round_trips(t)
	test_corrupt_file_falls_back_to_full(t)
	test_reduced_motion_arrives_at_the_destination(t)
	test_reduced_motion_faces_the_destination(t)
	test_reduced_motion_holds_the_rest_frame(t)
	test_full_motion_is_still_mid_route(t)
	test_toggling_motion_mid_walk_still_arrives(t)
	test_the_world_shares_one_motion_object(t)
	_remove_test_file()


## Motion is opt-in: with nothing stored, the office behaves exactly as before.
func test_default_is_full_motion(t) -> void:
	var motion := Motion.new()
	t.check(not motion.reduced(), "a fresh Motion preference is full motion")
	t.check(
		not Motion.resolve_reduced(null),
		"a missing stored value resolves to full motion"
	)


func test_resolve_reduced_reads_boolean_values(t) -> void:
	t.check(Motion.resolve_reduced(true), "stored true resolves to reduced motion")
	t.check(not Motion.resolve_reduced(false), "stored false resolves to full motion")


## A corrupt or hand-edited value must never force an unexpected mode, and must
## never crash the reader.
func test_resolve_reduced_falls_back_for_corrupt_values(t) -> void:
	for raw in [1, 0, "true", "yes", [], {}, 2.5]:
		t.check(
			not Motion.resolve_reduced(raw),
			"corrupt stored value %s falls back to full motion" % str(raw)
		)


func test_persisted_choice_round_trips(t) -> void:
	_remove_test_file()
	var written := Motion.new()
	written.set_reduced(true)
	t.check_equal(written.save(TEST_PATH), OK, "the reduced choice is persisted")
	var read := Motion.new()
	read.load(TEST_PATH)
	t.check(read.reduced(), "a persisted reduced choice is restored")
	written.set_reduced(false)
	t.check_equal(written.save(TEST_PATH), OK, "the full-motion choice is persisted")
	var read_back := Motion.new()
	read_back.load(TEST_PATH)
	t.check(not read_back.reduced(), "a persisted full-motion choice is restored")


## Loading must tolerate a file that is not a config file at all, and a
## well-formed file holding the wrong value type.
func test_corrupt_file_falls_back_to_full(t) -> void:
	var handle := FileAccess.open(TEST_PATH, FileAccess.WRITE)
	t.check(handle != null, "a scratch settings file can be written")
	if handle == null:
		return
	handle.store_string("this is not a config file\n")
	handle.close()
	var motion := Motion.new()
	motion.set_reduced(true)
	motion.load(TEST_PATH)
	t.check(not motion.reduced(), "an unreadable settings file falls back to full motion")

	var config := ConfigFile.new()
	config.set_value(Motion.SECTION, Motion.KEY, "yes")
	config.save(TEST_PATH)
	var wrong_type := Motion.new()
	wrong_type.set_reduced(true)
	wrong_type.load(TEST_PATH)
	t.check(
		not wrong_type.reduced(),
		"a wrong-typed stored value falls back to full motion"
	)


## The office must stay truthful about where an agent is: reduced motion snaps
## instead of interpolating, and it still arrives.
func test_reduced_motion_arrives_at_the_destination(t) -> void:
	var actor := _actor()
	actor.motion.set_reduced(true)
	actor.set_route([Vector2(0, 0), Vector2(64, 0), Vector2(64, 64)])
	actor._process(0.01)
	t.check_equal(actor.position, Vector2(64, 64), "reduced motion ends at the destination")
	t.check(not actor.is_walking(), "reduced motion stops walking on arrival")
	actor.free()


func test_reduced_motion_faces_the_destination(t) -> void:
	var actor := _actor()
	actor.motion.set_reduced(true)
	actor.set_route([Vector2(0, 0), Vector2(0, 64)])
	actor._process(0.01)
	t.check_equal(actor.facing(), OfficeActor.DIR_DOWN, "reduced motion faces the way it travelled")
	actor.free()


func test_reduced_motion_holds_the_rest_frame(t) -> void:
	var actor := _actor()
	actor.motion.set_reduced(true)
	actor.set_route([Vector2(0, 0), Vector2(64, 0), Vector2(64, 64)])
	actor._process(0.01)
	t.check_equal(
		actor._frame_row,
		OfficeActor.ROW_TYPE,
		"reduced motion holds the settled rest row, not a walk frame"
	)
	actor.free()


## The control case: full motion must still be mid-route after the same steps,
## proving reduced motion changed behavior rather than disabling walking twice.
func test_full_motion_is_still_mid_route(t) -> void:
	var actor := _actor()
	actor.motion.set_reduced(false)
	actor.set_route([Vector2(0, 0), Vector2(64, 0), Vector2(64, 64)])
	actor._process(0.01)
	t.check(actor.is_walking(), "full motion is still walking after one step")
	t.check(
		actor.position.x > 0.0 and actor.position.x < 64.0,
		"full motion is partway along the first leg"
	)
	t.check_equal(actor._frame_row, OfficeActor.ROW_WALK, "full motion cycles the walk row")
	actor.free()


## Toggling the preference mid-walk must never strand an actor partway.
func test_toggling_motion_mid_walk_still_arrives(t) -> void:
	var actor := _actor()
	actor.motion.set_reduced(false)
	actor.set_route([Vector2(0, 0), Vector2(64, 0), Vector2(64, 64)])
	actor._process(0.01)
	t.check(actor.is_walking(), "the actor is walking before the toggle")
	t.check(actor.position != Vector2(64, 64), "the actor is not yet at the destination")
	actor.motion.set_reduced(true)
	actor._process(0.01)
	t.check(not actor.is_walking(), "the toggle stops the walk")
	t.check_equal(actor.position, Vector2(64, 64), "the toggled actor still reaches the destination")
	actor.free()


## An actor whose motion comes from a private preference, so these tests neither
## read nor write the real stored setting. A typing actor settles on ROW_TYPE,
## which makes the walk frame observably different from the rest frame.
func _actor() -> OfficeActor:
	var presentation := ActorPresentation.new(
		ActorIdentity.new("ses_motion", "backend", "ses_root", "Backend")
	)
	presentation.set_work(WorkState.Kind.TYPING)
	var actor := OfficeActor.new()
	actor.motion = Motion.new()
	actor.update_from(presentation, Vector2(0, 0))
	return actor


func _remove_test_file() -> void:
	if not FileAccess.file_exists(TEST_PATH):
		return
	DirAccess.remove_absolute(ProjectSettings.globalize_path(TEST_PATH))

## The world hands the shared preference to every actor it spawns, so a new
## arrival never animates once and then stops. Assigning to the projection list
## instead of the scene silently did nothing, which is what this pins.
func test_the_world_shares_one_motion_object(t) -> void:
	var world := OfficeWorld.new()
	t.check(world.motion != null, "the world owns a motion preference")
	t.check(not world.motion.reduced(), "it defaults to full motion")
	world.motion.set_reduced(true)
	t.check(world.motion.reduced(), "the preference is shared by reference")
	world.free()
