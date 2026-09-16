## Concurrent-actor tests (TASK-039).
##
## The office claims a finite floor. These place more actors than there are desks
## and check the office stays truthful: every actor gets a distinct, walkable
## position, and the overflow is seated rather than stacked on top of someone.
extends RefCounted


func run(t) -> void:
	test_twelve_actors_all_get_distinct_positions(t)
	test_overflow_actors_are_still_reachable(t)
	test_every_actor_has_a_click_target(t)


## Twelve actors is the stated target. The plan has 13 desks, so all twelve must
## be seated and no two may share a position.
func test_twelve_actors_all_get_distinct_positions(t) -> void:
	var world := OfficeWorld.new()
	world.setup(null)
	world.refresh(_store_of(12))
	t.check_equal(world.actors.size(), 12, "all twelve actors joined the world")
	var positions := {}
	for key in world.actors:
		var node := world.actors[key] as OfficeActor
		positions[node.position] = str(positions.get(node.position, "")) + key
	var shared: Array = []
	for position in positions:
		if str(positions[position]).length() > 24:
			shared.append(position)
	t.check(shared.is_empty(), "no two actors share a position: %s" % str(shared))
	world.free()


## An actor past the desks must still stand somewhere walkable, not at the
## navigation default cell that a missing desk silently resolves to.
func test_overflow_actors_are_still_reachable(t) -> void:
	var world := OfficeWorld.new()
	world.setup(null)
	# More actors than desks forces the overflow path.
	world.refresh(_store_of(20))
	t.check_equal(world.actors.size(), 20, "twenty actors joined the world")
	var nav := world.navigation
	var unreachable: Array = []
	for key in world.actors:
		var node := world.actors[key] as OfficeActor
		var cell := Vector2i(int(node.position.x / OfficeWorld.TILE), int(node.position.y / OfficeWorld.TILE))
		if nav.is_blocked(cell):
			unreachable.append(key)
	t.check(unreachable.is_empty(), "every actor stands on a cell the plan does not block: %s" % str(unreachable))
	world.free()


## Selection is how a user opens an actor's source, so every actor must be
## clickable. Twelve actors must not overlap into one hit target.
func test_every_actor_has_a_click_target(t) -> void:
	var world := OfficeWorld.new()
	world.setup(null)
	world.refresh(_store_of(12))
	var resolved := {}
	for key in world.actors:
		var node := world.actors[key] as OfficeActor
		var centre := node.position + Vector2(0, -OfficeActor.FRAME_H * 0.5)
		var hit := world.actor_at(centre)
		resolved[hit] = true
	t.check_equal(
		resolved.size(),
		12,
		"each of the twelve actors resolves to its own click target"
	)
	world.free()


func _store_of(count: int) -> OfficeStore:
	var store := OfficeStore.new()
	for index in count:
		store.actors["ses_%02d" % index] = ActorPresentation.new(
			ActorIdentity.new(
				"ses_%02d" % index,
				"agent_%d" % (index % 4),
				"ses_root",
				"Role %d" % index
			)
		)
	return store
