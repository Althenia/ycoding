## Motion preference for the office presentation.
##
## Reduced motion is a presentation-only choice: the office stays truthful about
## where an agent is, but the actor snaps to its destination and holds a still
## frame instead of interpolating. This module owns only the preference and its
## persistence; the actor decides what reduced motion means for it.
##
## The resolution helpers are static and pure so the parse and the default can be
## tested without touching the filesystem.
class_name Motion
extends RefCounted

## ConfigFile section and key holding the choice.
const SECTION := "motion"
const KEY := "reduced"

## The default settings path under `user://`, per Godot's own persistence idiom.
const DEFAULT_PATH := "user://motion.cfg"

var _reduced := false


## Whether motion is currently reduced. Full motion is the default.
func reduced() -> bool:
	return _reduced


func set_reduced(value: bool) -> void:
	_reduced = value


## Read the persisted choice, falling back to full motion when the file is
## missing, unreadable, or holds an unusable value. Never fails.
func load(path: String = DEFAULT_PATH) -> void:
	var config := ConfigFile.new()
	if config.load(path) != OK:
		_reduced = false
		return
	if not config.has_section_key(SECTION, KEY):
		_reduced = false
		return
	_reduced = Motion.resolve_reduced(config.get_value(SECTION, KEY, null))


## Persist the choice. Returns the write error so a caller can report it.
func save(path: String = DEFAULT_PATH) -> Error:
	var config := ConfigFile.new()
	config.set_value(SECTION, KEY, _reduced)
	return config.save(path)


## The effective reduced flag for a raw stored value.
##
## Only a genuine boolean enables reduced motion. Anything else — a missing key,
## a string, a number, an array — is treated as full motion, so a corrupt or
## hand-edited settings file can never silently change how the office behaves.
static func resolve_reduced(raw: Variant) -> bool:
	if raw is bool:
		return raw
	return false