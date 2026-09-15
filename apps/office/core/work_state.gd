## Work-state classification. F-08 requires these to be distinguishable without
## relying on color alone, so every state carries a text label.
class_name WorkState
extends RefCounted

enum Kind {
	IDLE,
	READING,
	TYPING,
	TESTING,
	REVIEWING,
	PROCESSING,
	WAITING,
	BLOCKED,
}

const LABELS := {
	Kind.IDLE: "Idle",
	Kind.READING: "Reading",
	Kind.TYPING: "Typing",
	Kind.TESTING: "Testing",
	Kind.REVIEWING: "Reviewing",
	Kind.PROCESSING: "Processing",
	Kind.WAITING: "Waiting",
	Kind.BLOCKED: "Blocked",
}

## Distinct glyph per state so the distinction never depends on color alone.
const GLYPHS := {
	Kind.IDLE: "-",
	Kind.READING: "o",
	Kind.TYPING: "=",
	Kind.TESTING: "T",
	Kind.REVIEWING: "R",
	Kind.PROCESSING: "*",
	Kind.WAITING: "?",
	Kind.BLOCKED: "!",
}


static func label(kind: int) -> String:
	return LABELS.get(kind, "Unknown")


static func glyph(kind: int) -> String:
	return GLYPHS.get(kind, "?")


## Verified tool names only. An unknown tool becomes PROCESSING rather than a
## guessed category, because the service does not classify arbitrary tools.
static func from_tool(tool_name: String) -> int:
	var name := tool_name.to_lower()
	if name == "read" or name == "grep" or name == "glob":
		return Kind.READING
	if name == "edit" or name == "write" or name == "patch":
		return Kind.TYPING
	if name == "shell" or name == "bash":
		return Kind.TESTING
	return Kind.PROCESSING


## `session.task.updated` change kind -> work state. Only a real launch or
## progress fact produces an active state.
static func from_change(change_type: String) -> int:
	match change_type:
		"launched", "started":
			return Kind.PROCESSING
		"progressed":
			return Kind.TYPING
		"question_asked":
			return Kind.WAITING
		"question_answered":
			return Kind.PROCESSING
		"completed":
			return Kind.REVIEWING
		"cancelled", "lost":
			return Kind.IDLE
		"failed":
			return Kind.BLOCKED
	return Kind.IDLE
