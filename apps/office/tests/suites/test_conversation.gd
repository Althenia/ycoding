## Conversation drawer tests (TASK-037, TASK-038).
##
## The drawer is a projection of source-backed items, so these pin the three
## properties that are invisible in the code and only show up as a usability
## defect:
##
##   1. a thread is a real session family: a root's items and its children's
##      items read as one conversation, and a child item is attributed to the
##      child, not to the root;
##   2. the filter is driven by the real items and the real family, and a thread
##      with no items renders an empty state instead of the previous rows;
##   3. message text is untrusted and arbitrary: the excerpt ceiling is a real
##      character ceiling that marks truncation, and a multibyte message must
##      survive intact with no mojibake and no cut mid-codepoint.
##
## TASK-038 adds the file-change detail. The wire `session.file-change.recorded`
## carries `change = {path, patch, additions, deletions}` (packages/schema/src/
## session-event.ts), so the path and counts are shown, the patch excerpt is
## bounded, and the change KIND — which the wire does not send — is stated as
## unreported rather than invented.
extends RefCounted

## The drawer's own text for a filter that matches nothing.
const FILTER_EMPTY := "No items match this filter."

## The exact UI text the drawer uses for the truncation marker.
const MARK_TRUNCATED := "…"

## The wire source string every item must carry.
const SOURCE_TASK := "session.task.updated"
const SOURCE_CHANGE := "session.file-change.recorded"

## A multibyte message: Thai, CJK and an emoji. Each Thai character is three
## UTF-8 bytes, so a byte-wise cut would split one.
const MULTIBYTE_MESSAGE := "สวัสดีครับ 你好 🎉 ยินดีต้อนรับ"


func run(t) -> void:
	test_the_family_accessor_covers_a_root_and_its_children(t)
	test_a_root_drawer_includes_its_children_with_attribution(t)
	test_selecting_a_child_reads_as_the_same_thread(t)
	test_the_thread_filter_offers_the_real_family(t)
	test_the_kind_filter_is_derived_from_real_items(t)
	test_filtering_by_kind_hides_the_other_kinds(t)
	test_a_thread_with_no_items_shows_an_empty_state_and_no_stale_rows(t)
	test_an_over_ceiling_excerpt_is_truncated_and_marked(t)
	test_an_excerpt_at_the_ceiling_is_left_whole(t)
	test_a_multibyte_message_reaches_the_drawer_intact(t)
	test_a_multibyte_excerpt_is_not_cut_mid_codepoint(t)
	test_a_file_change_reaches_the_drawer_with_path_and_counts(t)
	test_a_file_change_names_its_source(t)
	test_a_file_change_never_claims_a_change_kind(t)
	test_a_large_patch_is_stored_bounded(t)


## --- fixtures ---------------------------------------------------------------

func _store() -> OfficeStore:
	var store := OfficeStore.new()
	store.apply({"type": Wire.CONNECTED, "sessionID": "", "data": {}, "sourceEpoch": "epoch-a"})
	return store


## One root with one child, both real sessions. The child deliberately has no
## items of its own unless a test records them, so the no-item thread is real.
func _family_store() -> OfficeStore:
	var store := _store()
	store.apply(
		{
			"type": Wire.SESSION_CREATED,
			"sessionID": "ses_root",
			"data": {"agent": "lead", "parentID": ""},
		}
	)
	store.apply(
		{
			"type": Wire.SESSION_CREATED,
			"sessionID": "ses_child",
			"data": {"agent": "backend", "parentID": "ses_root"},
		}
	)
	return store


func _delegation(store: OfficeStore) -> void:
	store.record_interaction(
		{
			"id": "delegation:oauth",
			"kind": "delegation",
			"session_id": "ses_root",
			"target_session_id": "ses_child",
			"description": "Implement the OAuth callback",
			"source": SOURCE_TASK,
			"source_verified": true,
		}
	)


func _child_report(store: OfficeStore) -> void:
	store.record_interaction(
		{
			"id": "report:ses_child",
			"kind": "report",
			"session_id": "ses_child",
			"description": "Report ready",
			"source": SOURCE_TASK,
			"source_verified": true,
		}
	)


## Every Label text under a node, in tree order.
func _texts(root: Node) -> Array[String]:
	var out: Array[String] = []
	var pending: Array[Node] = [root]
	while not pending.is_empty():
		var current: Node = pending.pop_back()
		if current is Label:
			out.append((current as Label).text)
		pending.append_array(current.get_children())
	return out


func _has_exact(texts: Array[String], needle: String) -> bool:
	return texts.has(needle)


func _has_fragment(texts: Array[String], needle: String) -> bool:
	for text in texts:
		if text.find(needle) != -1:
			return true
	return false


func _option_labels(option: OptionButton) -> Array[String]:
	var out: Array[String] = []
	for index in option.item_count:
		out.append(option.get_item_text(index))
	return out


## Drive an OptionButton the way a user does: choose the item and let the signal
## fire, so the test exercises the real handler rather than a private setter.
func _choose(option: OptionButton, fragment: String) -> bool:
	for index in option.item_count:
		if option.get_item_text(index).find(fragment) != -1:
			option.select(index)
			option.item_selected.emit(index)
			return true
	return false


## --- thread grouping --------------------------------------------------------

## The store must expose the real family so the drawer can group without
## inventing parentage. The family is derived from session parents, and it is a
## read-only projection: it never mutates the reducer.
func test_the_family_accessor_covers_a_root_and_its_children(t) -> void:
	var store := _family_store()
	if not store.has_method("family_session_ids"):
		t.check(false, "the store exposes family_session_ids for read-only thread grouping")
		return
	var from_child: Array = store.call("family_session_ids", "ses_child")
	t.check(from_child.has("ses_root"), "the family of a child includes its root")
	t.check(from_child.has("ses_child"), "the family includes the child itself")
	var from_root: Array = store.call("family_session_ids", "ses_root")
	t.check(from_root.has("ses_root"), "the family of a root includes the root")
	t.check(from_root.has("ses_child"), "the family of a root includes its child")


## Selecting a root must read as one thread: the root's own item and the child's
## item are both present, and the child's item names the child.
func test_a_root_drawer_includes_its_children_with_attribution(t) -> void:
	var store := _family_store()
	_delegation(store)
	_child_report(store)
	var panel := ConversationPanel.new()
	panel._ready()
	panel.show_actor(store, "ses_root")
	var texts := _texts(panel._list)
	t.check(_has_exact(texts, "Implement the OAuth callback"), "the root's own item is shown")
	t.check(_has_exact(texts, "Report ready"), "the child's item is shown in the same thread")
	t.check(
		_has_fragment(texts, "Backend"),
		"the child's item is attributed to the child, not the root"
	)
	panel.free()


## Selecting the child shows the same thread rather than losing the root.
func test_selecting_a_child_reads_as_the_same_thread(t) -> void:
	var store := _family_store()
	_delegation(store)
	_child_report(store)
	var panel := ConversationPanel.new()
	panel._ready()
	panel.show_actor(store, "ses_child")
	var texts := _texts(panel._list)
	t.check(
		_has_exact(texts, "Implement the OAuth callback"),
		"the parent's item is still visible from the child"
	)
	t.check(_has_exact(texts, "Report ready"), "the child's own item is visible from the child")
	panel.free()


## --- filter -----------------------------------------------------------------

## The thread filter lists the real family, so a member with no items is still
## selectable — which is what makes the empty state reachable.
func test_the_thread_filter_offers_the_real_family(t) -> void:
	var store := _family_store()
	_delegation(store)
	var panel := ConversationPanel.new()
	panel._ready()
	panel.show_actor(store, "ses_root")
	var option := panel.find_child("ThreadFilter", true, false) as OptionButton
	t.check(option != null, "the drawer offers a thread filter")
	if option == null:
		panel.free()
		return
	var labels := _option_labels(option)
	t.check(_has_fragment(labels, "Lead"), "the thread filter names the root")
	t.check(_has_fragment(labels, "Backend"), "the thread filter names the child")
	panel.free()


## The kind filter is derived from the items actually present, so it cannot offer
## a kind that has no rows.
func test_the_kind_filter_is_derived_from_real_items(t) -> void:
	var store := _family_store()
	_delegation(store)
	_child_report(store)
	var panel := ConversationPanel.new()
	panel._ready()
	panel.show_actor(store, "ses_root")
	var option := panel.find_child("KindFilter", true, false) as OptionButton
	t.check(option != null, "the drawer offers a kind filter")
	if option == null:
		panel.free()
		return
	var labels := _option_labels(option)
	t.check(_has_fragment(labels, "Delegation"), "the kind filter offers a kind that has an item")
	t.check(_has_fragment(labels, "Report"), "the kind filter offers the other present kind")
	t.check(not _has_fragment(labels, "Question"), "the kind filter omits a kind with no items")
	panel.free()


func test_filtering_by_kind_hides_the_other_kinds(t) -> void:
	var store := _family_store()
	_delegation(store)
	_child_report(store)
	var panel := ConversationPanel.new()
	panel._ready()
	panel.show_actor(store, "ses_root")
	var option := panel.find_child("KindFilter", true, false) as OptionButton
	t.check(option != null, "the drawer offers a kind filter")
	if option == null:
		panel.free()
		return
	t.check(_choose(option, "Report"), "the report kind is selectable")
	var texts := _texts(panel._list)
	t.check(_has_exact(texts, "Report ready"), "the matching kind stays visible")
	t.check(
		not _has_exact(texts, "Implement the OAuth callback"),
		"the other kind is hidden"
	)
	panel.free()


## Selecting a thread with no items must show an empty state, never the previous
## rows. Stale rows would present another assignment's history as this one's.
func test_a_thread_with_no_items_shows_an_empty_state_and_no_stale_rows(t) -> void:
	var store := _family_store()
	_delegation(store)
	var panel := ConversationPanel.new()
	panel._ready()
	panel.show_actor(store, "ses_root")
	t.check(
		_has_exact(_texts(panel._list), "Implement the OAuth callback"),
		"the root row is present before filtering"
	)
	var option := panel.find_child("ThreadFilter", true, false) as OptionButton
	t.check(option != null, "the drawer offers a thread filter")
	if option == null:
		panel.free()
		return
	t.check(_choose(option, "Backend"), "the item-less child is selectable")
	var texts := _texts(panel._list)
	t.check(_has_exact(texts, FILTER_EMPTY), "an empty state replaces the rows")
	t.check(
		not _has_exact(texts, "Implement the OAuth callback"),
		"no stale row survives the filter"
	)
	panel.free()


## --- excerpt ceiling and Unicode --------------------------------------------

## The ceiling is a real ceiling: the STORED description never exceeds it, and a
## truncation is marked so the reader knows text was removed.
func test_an_over_ceiling_excerpt_is_truncated_and_marked(t) -> void:
	var store := _store()
	var original := "x".repeat(OfficeStore.MAX_MESSAGE_EXCERPT + 160)
	store.record_interaction(
		{
			"id": "q-long",
			"kind": "question",
			"session_id": "ses_1",
			"description": original,
			"source": SOURCE_TASK,
		}
	)
	t.check(store.interactions.size() == 1, "the item was recorded")
	if store.interactions.is_empty():
		return
	var stored := str(store.interactions[-1].get("description", ""))
	t.check(
		stored.length() <= OfficeStore.MAX_MESSAGE_EXCERPT,
		"the stored description never exceeds the ceiling"
	)
	t.check(stored.ends_with(MARK_TRUNCATED), "the truncation is marked")
	t.check(stored.length() < original.length(), "text was genuinely removed")


## A message at exactly the ceiling already fits and must not be altered.
func test_an_excerpt_at_the_ceiling_is_left_whole(t) -> void:
	var store := _store()
	var original := "y".repeat(OfficeStore.MAX_MESSAGE_EXCERPT)
	store.record_interaction(
		{
			"id": "q-exact",
			"kind": "question",
			"session_id": "ses_1",
			"description": original,
			"source": SOURCE_TASK,
		}
	)
	if store.interactions.is_empty():
		t.check(false, "the item was recorded")
		return
	t.check_equal(
		str(store.interactions[-1].get("description", "")),
		original,
		"an excerpt at the ceiling is untouched"
	)


## A multibyte message must reach the drawer exactly, with no replacement glyph
## and no dropped characters.
func test_a_multibyte_message_reaches_the_drawer_intact(t) -> void:
	var store := _store()
	store.apply(
		{"type": Wire.SESSION_CREATED, "sessionID": "ses_1", "data": {"agent": "backend"}}
	)
	store.record_interaction(
		{
			"id": "q-unicode",
			"kind": "question",
			"session_id": "ses_1",
			"description": MULTIBYTE_MESSAGE,
			"source": SOURCE_TASK,
		}
	)
	t.check(store.interactions.size() == 1, "the message was recorded")
	if store.interactions.is_empty():
		return
	t.check_equal(
		str(store.interactions[-1].get("description", "")),
		MULTIBYTE_MESSAGE,
		"the stored message is unchanged"
	)
	var panel := ConversationPanel.new()
	panel._ready()
	panel.show_actor(store, "ses_1")
	var texts := _texts(panel._list)
	t.check(_has_exact(texts, MULTIBYTE_MESSAGE), "the multibyte message reaches the screen intact")
	t.check(not _has_fragment(texts, "\ufffd"), "no replacement glyph (mojibake) appears")
	panel.free()


## Truncating a multibyte message must cut on a character boundary, not inside a
## codepoint. A byte-wise cut would leave a broken sequence and mojibake.
func test_a_multibyte_excerpt_is_not_cut_mid_codepoint(t) -> void:
	var store := _store()
	var glyph := "ก"
	store.record_interaction(
		{
			"id": "q-unicode-long",
			"kind": "question",
			"session_id": "ses_1",
			"description": glyph.repeat(OfficeStore.MAX_MESSAGE_EXCERPT + 60),
			"source": SOURCE_TASK,
		}
	)
	t.check(store.interactions.size() == 1, "the message was recorded")
	if store.interactions.is_empty():
		return
	var stored := str(store.interactions[-1].get("description", ""))
	t.check(
		stored.length() <= OfficeStore.MAX_MESSAGE_EXCERPT,
		"the multibyte excerpt respects the ceiling"
	)
	t.check(stored.ends_with(MARK_TRUNCATED), "the multibyte truncation is marked")
	var prefix := stored.substr(0, stored.length() - 1)
	t.check_equal(
		prefix.length(),
		OfficeStore.MAX_MESSAGE_EXCERPT - 1,
		"the visible prefix keeps the ceiling"
	)
	var all_glyphs := true
	for index in prefix.length():
		if prefix[index] != glyph:
			all_glyphs = false
	t.check(all_glyphs, "no partial character survives the cut")
	t.check_equal(
		prefix.to_utf8_buffer().size(),
		prefix.length() * 3,
		"the prefix is a whole number of three-byte characters"
	)


## --- file change detail (TASK-038) ------------------------------------------

## `session.file-change.recorded` carries `change = {path, patch, additions,
## deletions}`, so the drawer shows the path and the line counts.
func test_a_file_change_reaches_the_drawer_with_path_and_counts(t) -> void:
	var store := _store()
	store.apply(
		{"type": Wire.SESSION_CREATED, "sessionID": "ses_1", "data": {"agent": "backend"}}
	)
	store.apply(
		{
			"type": Wire.FILE_CHANGE,
			"sessionID": "ses_1",
			"data":
			{
				"change":
				{
					"path": "core/session.ts",
					"patch": "@@ -1 +1 @@",
					"additions": 3,
					"deletions": 1,
				}
			},
		}
	)
	var panel := ConversationPanel.new()
	panel._ready()
	panel.show_actor(store, "ses_1")
	var texts := _texts(panel._list)
	t.check(_has_fragment(texts, "core/session.ts"), "the changed path is shown")
	t.check(_has_fragment(texts, "+3"), "the additions count is shown")
	t.check(_has_fragment(texts, "-1"), "the deletions count is shown")
	panel.free()


## The change is a real runtime fact, so it names its wire source.
func test_a_file_change_names_its_source(t) -> void:
	var store := _store()
	store.apply(
		{"type": Wire.SESSION_CREATED, "sessionID": "ses_1", "data": {"agent": "backend"}}
	)
	store.apply(
		{
			"type": Wire.FILE_CHANGE,
			"sessionID": "ses_1",
			"data": {"change": {"path": "core/wire.ts", "patch": "@@ -2 +2 @@", "additions": 2, "deletions": 0}},
		}
	)
	var panel := ConversationPanel.new()
	panel._ready()
	panel.show_actor(store, "ses_1")
	var texts := _texts(panel._list)
	t.check(_has_fragment(texts, SOURCE_CHANGE), "the change names its wire source")
	panel.free()


## The wire sends no change-kind field on this event, so the drawer must not
## claim one. It states the kind is unreported instead of inventing "modified".
func test_a_file_change_never_claims_a_change_kind(t) -> void:
	var store := _store()
	store.apply(
		{"type": Wire.SESSION_CREATED, "sessionID": "ses_1", "data": {"agent": "backend"}}
	)
	store.apply(
		{
			"type": Wire.FILE_CHANGE,
			"sessionID": "ses_1",
			"data": {"change": {"path": "core/store.ts", "patch": "@@ -1 +1 @@", "additions": 4, "deletions": 2}},
		}
	)
	var panel := ConversationPanel.new()
	panel._ready()
	panel.show_actor(store, "ses_1")
	var texts := _texts(panel._list)
	t.check(
		_has_fragment(texts, "not reported"),
		"the drawer states the change kind is not reported by the wire"
	)
	for invented in ["modified", "added", "deleted"]:
		t.check(
			not _has_fragment(texts, invented),
			"the drawer must not claim the change kind '%s'" % invented
		)
	panel.free()


## A patch is arbitrary tool output, so the stored excerpt is bounded like every
## other untrusted excerpt.
func test_a_large_patch_is_stored_bounded(t) -> void:
	var store := _store()
	store.apply(
		{"type": Wire.SESSION_CREATED, "sessionID": "ses_1", "data": {"agent": "backend"}}
	)
	store.apply(
		{
			"type": Wire.FILE_CHANGE,
			"sessionID": "ses_1",
			"data":
			{
				"change":
				{"path": "core/big.ts", "patch": "p".repeat(5000), "additions": 900, "deletions": 0},
			},
		}
	)
	t.check(store.interactions.size() == 1, "the change was recorded as one item")
	if store.interactions.is_empty():
		return
	var item: Dictionary = store.interactions[-1]
	t.check_equal(str(item.get("path", "")), "core/big.ts", "the path is stored as a fact")
	t.check(
		str(item.get("patch", "")).length() <= OfficeStore.MAX_MESSAGE_EXCERPT,
		"the stored patch excerpt is bounded"
	)
