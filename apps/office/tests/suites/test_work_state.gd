## Work-state legibility tests (TEST-037 / F-08).
##
## F-08 requires reading, typing, waiting and blocked states to be distinguishable
## without relying on color alone.
extends RefCounted


func run(t) -> void:
	test_every_state_has_distinct_text_and_glyph(t)
	test_tool_classification_is_conservative(t)
	test_change_classification(t)


func test_every_state_has_distinct_text_and_glyph(t) -> void:
	var labels: Dictionary = {}
	var glyphs: Dictionary = {}
	for kind in WorkState.LABELS:
		var label := WorkState.label(kind)
		var glyph := WorkState.glyph(kind)
		t.check(not label.is_empty(), "state %d has a text label" % kind)
		t.check(not glyph.is_empty(), "state %d has a glyph" % kind)
		t.check(not labels.has(label), "label '%s' is unique" % label)
		t.check(not glyphs.has(glyph), "glyph '%s' is unique" % glyph)
		labels[label] = true
		glyphs[glyph] = true


func test_tool_classification_is_conservative(t) -> void:
	var expectations := {
		"read": WorkState.Kind.READING,
		"grep": WorkState.Kind.READING,
		"edit": WorkState.Kind.TYPING,
		"shell": WorkState.Kind.TESTING,
		"unclassified_tool": WorkState.Kind.PROCESSING,
	}
	for name in expectations:
		t.check_equal(
			WorkState.from_tool(name),
			expectations[name],
			"tool %s classifies correctly" % name
		)


func test_change_classification(t) -> void:
	var expectations := {
		"launched": WorkState.Kind.PROCESSING,
		"question_asked": WorkState.Kind.WAITING,
		"completed": WorkState.Kind.REVIEWING,
		"failed": WorkState.Kind.BLOCKED,
		"cancelled": WorkState.Kind.IDLE,
		"unrecognised": WorkState.Kind.IDLE,
	}
	for change in expectations:
		t.check_equal(
			WorkState.from_change(change),
			expectations[change],
			"change %s classifies correctly" % change
		)
