## Character sheet contract tests.
##
## The actor reads fixed-size regions out of the generated sheets. If the art
## frame height and the code constant drift apart, every sprite samples the wrong
## area and characters silently disappear from the world. These tests pin the
## contract to the actual generated files.
extends RefCounted

const ROW_COUNT := 16


func run(t) -> void:
	test_sheet_dimensions_match_frame_constants(t)
	test_every_role_sheet_exists(t)
	test_row_layout_matches_generator(t)


func test_sheet_dimensions_match_frame_constants(t) -> void:
	var path := "res://office/art/char_lead.png"
	t.check(ResourceLoader.exists(path), "lead sheet exists")
	var texture: Texture2D = load(path)
	t.check_equal(
		texture.get_width(),
		OfficeActor.FRAME_W * 4,
		"sheet is four direction columns wide"
	)
	t.check_equal(
		texture.get_height(),
		OfficeActor.FRAME_H * ROW_COUNT,
		"sheet is %d frames tall and matches OfficeActor.FRAME_H" % ROW_COUNT
	)


func test_every_role_sheet_exists(t) -> void:
	for role in OfficeActor.ROLE_TEXTURES:
		var path := str(OfficeActor.ROLE_TEXTURES[role])
		t.check(ResourceLoader.exists(path), "sheet for role %s exists" % role)
		if not ResourceLoader.exists(path):
			continue
		var texture: Texture2D = load(path)
		t.check_equal(
			texture.get_height(),
			OfficeActor.FRAME_H * ROW_COUNT,
			"role %s sheet height matches FRAME_H" % role
		)


## The row indices the actor uses must land inside the sheet and follow the
## generator's declared order: idle, walk, sit, type, read, talk.
func test_row_layout_matches_generator(t) -> void:
	var rows := [
		OfficeActor.ROW_IDLE,
		OfficeActor.ROW_WALK,
		OfficeActor.ROW_SIT,
		OfficeActor.ROW_TYPE,
		OfficeActor.ROW_READ,
		OfficeActor.ROW_TALK,
	]
	t.check_equal(rows[0], 0, "idle starts at row 0")
	t.check_equal(rows[1], 2, "walk follows the two idle frames")
	t.check_equal(rows[2], 8, "sit follows the six walk frames")
	t.check(rows[5] + 1 < ROW_COUNT, "the talk row leaves room for its second frame")
	for row in rows:
		t.check(row >= 0 and row < ROW_COUNT, "row %d is inside the sheet" % row)
