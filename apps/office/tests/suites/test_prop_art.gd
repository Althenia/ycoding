## Prop art contract tests.
##
## The plan's geometry and the art must agree, or actors sort behind desks and
## props float above the floor. These pin the two agreements that are invisible
## in the source and only show up as a visual defect:
##
##   1. every prop in the plan has a sprite, and its footprint matches the tile
##      grid the runtime anchors to;
##   2. a *standing* prop's bottom row is cast shadow only, so its ground contact
##      line is the top of that shadow.
##
## Floor decals are explicitly exempt from the second rule: a rug is the floor
## surface itself, so it is opaque edge to edge and carries no cast shadow.
extends RefCounted

## Props that lie flat on the floor. They are the floor surface, not standing
## furniture, so the foot-origin rule does not apply.
const DECALS := ["rug_blue", "rug_warm", "rug_pink", "rug_checker"]

## Maximum alpha allowed in the bottom row of a standing prop, matching the
## alpha-40 contact shadow the generator draws.
const SHADOW_MAX_ALPHA := 60


func run(t) -> void:
	test_every_prop_has_a_sprite(t)
	test_every_prop_has_a_footprint(t)
	test_standing_props_are_shadow_footed(t)
	test_decals_are_flat_and_unsolid(t)
	test_no_plan_prop_is_unused(t)
	test_notice_bubble_contains_its_text(t)
	test_notice_bubble_is_centred_on_its_actor(t)
	test_overlay_draws_above_every_other_layer(t)
	test_clicking_an_actor_opens_its_source(t)
	test_clicking_a_notice_bubble_opens_its_source(t)
	test_clicking_empty_floor_selects_nothing(t)


## Clicking an actor must resolve to that actor, which is how a user opens the
## full source for something they can see. TASK-021 requires this.
func test_clicking_an_actor_opens_its_source(t) -> void:
	var world := OfficeWorld.new()
	world.setup(null)
	var presentation := ActorPresentation.new(
		ActorIdentity.new("ses_click", "backend", "ses_root", "Backend")
	)
	world.refresh(_store_with(presentation))
	t.check(world.actors.has("ses_click"), "the actor was added to the world")
	var node := world.actors.get("ses_click") as OfficeActor
	t.check(node != null, "the actor node exists")
	if node != null:
		var centre := node.position + Vector2(0, -OfficeActor.FRAME_H * 0.5)
		t.check(
			world.actor_at(centre) == "ses_click",
			"clicking the actor's body resolves to it"
		)
	world.free()


## The notice bubble is part of the clickable area: clicking the caption opens
## the source it came from.
func test_clicking_a_notice_bubble_opens_its_source(t) -> void:
	var world := OfficeWorld.new()
	world.setup(null)
	var presentation := ActorPresentation.new(
		ActorIdentity.new("ses_bubble", "qa", "ses_root", "Qa")
	)
	world.refresh(_store_with(presentation))
	var node := world.actors.get("ses_bubble") as OfficeActor
	t.check(node != null, "the actor node exists")
	if node == null:
		world.free()
		return
	world.show_notice(presentation, "Waiting for your decision")
	var box := OfficeOverlay.notice_box(
		ThemeDB.fallback_font, "Waiting for your decision", node.position
	)
	t.check(world.notices.has("ses_bubble"), "the notice is registered")
	t.check(
		world.actor_at(box.get_center()) == "ses_bubble",
		"clicking inside the notice bubble resolves to its actor"
	)
	t.check(
		box.size.x > 60.0,
		"the bubble is wide enough to be a real click target"
	)
	world.free()


## Empty floor must not select an arbitrary actor.
func test_clicking_empty_floor_selects_nothing(t) -> void:
	var world := OfficeWorld.new()
	world.setup(null)
	var presentation := ActorPresentation.new(
		ActorIdentity.new("ses_far", "lead", "ses_root", "Lead")
	)
	world.refresh(_store_with(presentation))
	t.check(
		world.actor_at(Vector2(4, 4)) == "",
		"a click on empty floor selects nothing"
	)
	world.free()


## A store holding exactly one actor, for the click tests.
func _store_with(presentation: ActorPresentation) -> OfficeStore:
	var store := OfficeStore.new()
	var identity: ActorIdentity = presentation.identity
	store.actors[identity.session_id] = presentation
	return store


## The overlay carries the status glyph, the selection highlight and notice
## bubbles. They are signals, so they must draw above the floor, the walls and
## the furniture. Raising the wall or prop layer without raising this one hides
## those signals, which is a real defect this pins.
func test_overlay_draws_above_every_other_layer(t) -> void:
	var world := OfficeWorld.new()
	world.setup(null)
	var overlay := world.get_node_or_null("Overlay")
	t.check(overlay != null, "the overlay node exists")
	if overlay != null:
		for child in world.get_children():
			if child == overlay:
				continue
			t.check(
				(overlay as Node2D).z_index > (child as Node2D).z_index,
				"the overlay draws above %s" % child.name
			)
	world.free()


## A notice bubble must contain the whole caption. It previously used a fixed
## one-line box, so "Waiting for your decision" rendered as "wait".
func test_notice_bubble_contains_its_text(t) -> void:
	var font := ThemeDB.fallback_font
	t.check(font != null, "a fallback font is available")
	if font == null:
		return
	var anchor := Vector2(500, 300)
	var width_limit := OfficeOverlay.MAX_WIDTH - OfficeOverlay.PAD * 2.0
	for text in ["Blocked", "Waiting for your decision", "Needs your approval"]:
		var box := OfficeOverlay.notice_box(font, text, anchor)
		var measured := font.get_multiline_string_size(
			text,
			HORIZONTAL_ALIGNMENT_LEFT,
			width_limit,
			OfficeOverlay.FONT_SIZE,
			OfficeOverlay.MAX_LINES
		)
		t.check(box.size.x > OfficeOverlay.PAD * 2.0, "bubble for '%s' has width" % text)
		t.check(
			box.size.x - OfficeOverlay.PAD * 2.0 >= measured.x - 0.5,
			"bubble for '%s' is wide enough for its text" % text
		)
		t.check(
			box.size.y - OfficeOverlay.PAD * 2.0 >= measured.y - 0.5,
			"bubble for '%s' is tall enough for its text" % text
		)
		t.check(box.position.x >= 4.0, "bubble for '%s' stays on the map" % text)
		t.check(
			box.position.x + box.size.x <= OfficeWorld.MAP_WIDTH * OfficeWorld.TILE - 4.0 + 0.5,
			"bubble for '%s' does not run off the map" % text
		)


## The bubble is anchored above its actor and centred on it.
func test_notice_bubble_is_centred_on_its_actor(t) -> void:
	var font := ThemeDB.fallback_font
	if font == null:
		return
	var anchor := Vector2(
		OfficeWorld.MAP_WIDTH * OfficeWorld.TILE * 0.5,
		OfficeWorld.MAP_HEIGHT * OfficeWorld.TILE * 0.5
	)
	var box := OfficeOverlay.notice_box(font, "Blocked", anchor)
	t.check(
		absf((box.position.x + box.size.x * 0.5) - anchor.x) < 0.5,
		"the bubble is horizontally centred on its actor"
	)
	t.check(box.position.y < anchor.y, "the bubble sits above its actor")


func test_every_prop_has_a_sprite(t) -> void:
	for item in OfficeWorld.FURNITURE:
		var prop := str(item["prop"])
		var path := str(OfficeWorld.PROP_TEXTURES.get(prop, ""))
		t.check(not path.is_empty(), "prop %s declares a texture" % prop)
		t.check(
			ResourceLoader.exists(path),
			"prop %s sprite exists at %s" % [prop, path]
		)


func test_every_prop_has_a_footprint(t) -> void:
	for item in OfficeWorld.FURNITURE:
		var prop := str(item["prop"])
		t.check(
			OfficeWorld.PROP_FOOTPRINT.has(prop),
			"prop %s declares a footprint" % prop
		)
		var footprint: Vector2i = OfficeWorld.PROP_FOOTPRINT.get(prop, Vector2i.ZERO)
		t.check(
			footprint.x >= 1 and footprint.y >= 1,
			"prop %s has a positive footprint" % prop
		)


## A standing prop must not have body pixels in its bottom row, or its ground
## contact line drifts by however tall the body is.
func test_standing_props_are_shadow_footed(t) -> void:
	var checked := {}
	for item in OfficeWorld.FURNITURE:
		var prop := str(item["prop"])
		if DECALS.has(prop) or checked.has(prop):
			continue
		checked[prop] = true
		var image := _image(str(OfficeWorld.PROP_TEXTURES[prop]))
		t.check(image != null, "prop %s image decodes" % prop)
		if image == null:
			continue
		var bottom := image.get_height() - 1
		var worst := 0
		for x in image.get_width():
			worst = maxi(worst, int(image.get_pixel(x, bottom).a * 255.0))
		t.check(
			worst <= SHADOW_MAX_ALPHA,
			"prop %s bottom row is cast shadow only (max alpha %d)" % [prop, worst]
		)


## A rug is the floor surface: opaque edge to edge, and never a navigation
## blocker, or it would wall off the room it decorates.
func test_decals_are_flat_and_unsolid(t) -> void:
	var seen := {}
	for item in OfficeWorld.FURNITURE:
		var prop := str(item["prop"])
		if not DECALS.has(prop):
			continue
		seen[prop] = true
		t.check(
			not bool(item.get("solid", false)),
			"decal %s is not solid" % prop
		)
	for prop in DECALS:
		var image := _image(str(OfficeWorld.PROP_TEXTURES[prop]))
		t.check(image != null, "decal %s image decodes" % prop)
		if image == null:
			continue
		var bottom := image.get_height() - 1
		var opaque := 0
		for x in image.get_width():
			if image.get_pixel(x, bottom).a > 0.9:
				opaque += 1
		t.check(
			opaque == image.get_width(),
			"decal %s is opaque across its bottom row" % prop
		)


## Every declared texture should actually be placed, so a renamed prop cannot
## leave a sprite stranded and unnoticed. Wall decoration counts as placement:
## the window sprite is mounted on the north wall rather than standing on floor.
func test_no_plan_prop_is_unused(t) -> void:
	var used := {}
	for item in OfficeWorld.FURNITURE:
		used[str(item["prop"])] = true
	for entry in OfficeWorld.WALL_DECOR:
		used[str(entry["prop"])] = true
	for prop in OfficeWorld.PROP_TEXTURES:
		t.check(used.has(str(prop)), "texture %s is used by the plan" % prop)


func _image(path: String) -> Image:
	if not ResourceLoader.exists(path):
		return null
	var texture: Texture2D = load(path)
	return null if texture == null else texture.get_image()
