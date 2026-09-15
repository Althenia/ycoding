## Scoped assignment identity.
##
## An agent definition is reusable: two child sessions using the same agent are
## two distinct actors. The scoped key is the real session identity, never the
## agent id. Display profiles may be reused across assignments; histories must not
## be merged by agent name.
class_name ActorIdentity
extends RefCounted

const SESSION_PREFIX := "ses_"

var session_id: String
var parent_session_id: String
var agent_id: String
var display_role: String
var display_name: String

func _init(
	p_session_id: String,
	p_agent_id: String,
	p_parent_session_id: String = "",
	p_display_role: String = "",
) -> void:
	session_id = p_session_id
	parent_session_id = p_parent_session_id
	agent_id = p_agent_id
	display_role = p_display_role if not p_display_role.is_empty() else p_agent_id
	display_name = display_role


## Assignment key. Two sessions sharing an agent produce different keys.
func key() -> String:
	return session_id


func is_root() -> bool:
	return parent_session_id.is_empty()


## Disambiguate repeated agent definitions, e.g. "Backend A" / "Backend B".
func apply_ordinal(ordinal: int, total: int) -> void:
	if total <= 1:
		return
	display_name = "%s %s" % [display_role, char("A".unicode_at(0) + ordinal)]


func to_dictionary() -> Dictionary:
	return {
		"session_id": session_id,
		"parent_session_id": parent_session_id,
		"agent_id": agent_id,
		"display_role": display_role,
		"display_name": display_name,
	}
