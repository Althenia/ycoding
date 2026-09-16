## Release identity contract tests.
##
## An exported client that has no icon and no version fails silently: the user
## gets a generic blank app and nothing to report when something goes wrong. The
## identity is declared in three places that a render test never touches — the
## project icon, the project version, and the macOS export preset — so these pin
## all three against the bytes that actually ship.
##
## The icon is checked as a real asset, not merely as a declared path: it must
## decode at 512x512 from its own IHDR chunk and hold more than a flat plate of
## colour, because "file exists" is satisfied by an empty or single-tone image.
extends RefCounted

const ICON_PATH := "res://office/art/icon_512.png"
const ICON_SIDE := 512

## The release this client reports. The repository's release version is the newest
## `docs/releases/v*.md`, which is what `.github/workflows/release.yml` derives the
## build version from; at the time of writing that is v0.2.4, matching both
## `ycoding --version` and the `v0.2.4` tag.
const VERSION := "0.2.4"

const PRESETS := "res://export_presets.cfg"
const GENERATOR := "res://tools/generate_icon.py"

## A flat plate of one or two tones is visually blank at icon size. Real artwork
## carries far more; this floor only rejects the failure mode, it is not a style
## budget.
const MIN_DISTINCT_COLOURS := 16


func run(t) -> void:
	test_the_icon_exists_at_the_declared_size(t)
	test_the_project_declares_the_icon(t)
	test_the_project_declares_the_release_version(t)
	test_the_export_preset_declares_icon_and_version(t)
	test_the_icon_is_not_a_blank_plate(t)
	test_the_icon_generator_is_hermetic(t)


## The shipped icon is a 512x512 image on disk. The IHDR chunk is the file's own
## authority, so this holds independently of the engine's import cache.
func test_the_icon_exists_at_the_declared_size(t) -> void:
	t.check(
		FileAccess.file_exists(ICON_PATH),
		"the icon ships at %s" % ICON_PATH
	)
	t.check(ResourceLoader.exists(ICON_PATH), "the icon resolves as a resource")
	var disk := _png_size(ICON_PATH)
	t.check_equal(
		disk,
		Vector2i(ICON_SIDE, ICON_SIDE),
		"the icon PNG is %dx%d" % [ICON_SIDE, ICON_SIDE]
	)
	if not ResourceLoader.exists(ICON_PATH):
		return
	var texture := load(ICON_PATH) as Texture2D
	t.check(texture != null, "the icon loads as a Texture2D")
	if texture == null:
		return
	t.check_equal(
		texture.get_size(),
		Vector2(ICON_SIDE, ICON_SIDE),
		"the imported icon is %dx%d" % [ICON_SIDE, ICON_SIDE]
	)


## `application/config/icon` is what the engine, the editor and every export
## preset that leaves the icon empty inherit. A path that does not resolve would
## still export as a blank icon, so the declared value is resolved here too.
func test_the_project_declares_the_icon(t) -> void:
	var declared := str(ProjectSettings.get_setting("application/config/icon", ""))
	t.check(not declared.is_empty(), "project.godot declares application/config/icon")
	t.check_equal(declared, ICON_PATH, "the declared icon is the shipped icon")
	t.check(
		ResourceLoader.exists(declared),
		"the declared icon %s resolves" % declared
	)


## The version the app reports must be the release the repository actually made.
func test_the_project_declares_the_release_version(t) -> void:
	var declared := str(ProjectSettings.get_setting("application/config/version", ""))
	t.check(not declared.is_empty(), "project.godot declares application/config/version")
	t.check_equal(declared, VERSION, "the declared version is the release version")


## The macOS preset is what the export actually reads; a project-level icon alone
## is not enough when the preset overrides it. Both the icon and the version must
## be declared on the preset.
func test_the_export_preset_declares_icon_and_version(t) -> void:
	var section := _macos_preset(t)
	if section.is_empty():
		return
	var config := ConfigFile.new()
	config.load(PRESETS)
	var options := section + ".options"
	t.check_equal(
		str(config.get_value(section, "name", "")),
		"macOS",
		"the export preset is the named macOS preset"
	)
	var icon := str(config.get_value(options, "application/icon", ""))
	t.check(not icon.is_empty(), "the macOS preset declares application/icon")
	t.check_equal(icon, ICON_PATH, "the preset's icon is the shipped icon")
	t.check(ResourceLoader.exists(icon), "the preset's icon %s resolves" % icon)
	var version := str(config.get_value(options, "application/version", ""))
	t.check(not version.is_empty(), "the macOS preset declares application/version")
	t.check_equal(version, VERSION, "the preset's version is the release version")


## A single-tone or nearly empty image satisfies every path check above and still
## exports as a blank generic icon. This samples the real pixels.
func test_the_icon_is_not_a_blank_plate(t) -> void:
	var image := _image()
	if image == null:
		t.check(false, "the icon decodes into an Image for sampling")
		return
	var seen := {}
	for y in image.get_height():
		for x in image.get_width():
			seen[image.get_pixel(x, y).to_rgba32()] = true
	t.check(
		seen.size() >= MIN_DISTINCT_COLOURS,
		"the icon is real artwork, not a flat plate (%d distinct colours)" % seen.size()
	)


## The icon is a shipped asset with the same provenance claim as every other
## sprite: generated in-repo, deterministically, with no network and no
## third-party module.
func test_the_icon_generator_is_hermetic(t) -> void:
	var source := FileAccess.get_file_as_string(GENERATOR)
	t.check(not source.is_empty(), "the icon generator source is readable")
	if source.is_empty():
		return
	for forbidden in [
		"urllib", "requests", "http.client", "urlopen", "socket",
		"subprocess", "popen", "os.system", "os.exec",
		"urandom", "uuid", "getpid", "datetime", "time.time", "time.monotonic",
	]:
		t.check(
			source.find(forbidden) == -1,
			"the icon generator does not reach outside itself via %s" % forbidden
		)


## The section name of the macOS export preset, or "" when the file declares none.
func _macos_preset(t) -> String:
	var config := ConfigFile.new()
	var error := config.load(PRESETS)
	t.check_equal(error, OK, "%s loads as a ConfigFile" % PRESETS)
	if error != OK:
		return ""
	for section in config.get_sections():
		if not section.begins_with("preset.") or section.ends_with(".options"):
			continue
		if str(config.get_value(section, "platform", "")) == "macOS":
			return section
	t.check(false, "%s declares a macOS preset" % PRESETS)
	return ""


func _image() -> Image:
	if not ResourceLoader.exists(ICON_PATH):
		return null
	var texture := load(ICON_PATH) as Texture2D
	return null if texture == null else texture.get_image()


## Width and height read from the PNG's own IHDR chunk: bytes 16..23 of the file.
## The IHDR fields are big-endian while `PackedByteArray.decode_u32` is
## little-endian, so the bytes are assembled explicitly.
func _png_size(path: String) -> Vector2i:
	var bytes := FileAccess.get_file_as_bytes(path)
	if bytes.size() < 24:
		return Vector2i.ZERO
	if bytes.slice(0, 8) != PackedByteArray([137, 80, 78, 71, 13, 10, 26, 10]):
		return Vector2i.ZERO
	return Vector2i(_be32(bytes, 16), _be32(bytes, 20))


func _be32(bytes: PackedByteArray, offset: int) -> int:
	return (bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]
