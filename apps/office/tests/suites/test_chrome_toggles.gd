## Chrome-toggle tests.
##
## Hiding the floating panels is a usability feature, and its one hard requirement
## is that it can always be undone: the control that hides the panels must never
## be hideable itself, and its own state must be readable without colour.
extends RefCounted


func run(t) -> void:
	test_starts_visible(t)
	test_toggles_flip_state(t)
	test_emits_the_new_state(t)
	test_every_entry_is_offered(t)
	test_labels_state_the_action_not_the_colour(t)
	test_set_hidden_restores_an_arrangement(t)
	test_never_offers_to_hide_itself(t)


func test_starts_visible(t) -> void:
	var toggles := ChromeToggles.new()
	toggles._ready()
	for entry in ChromeToggles.ENTRIES:
		t.check(
			not toggles.is_hidden(str(entry["name"])),
			"%s starts visible" % entry["name"]
		)
	t.check(toggles.hidden_names().is_empty(), "nothing is hidden at first")
	toggles.free()


func test_toggles_flip_state(t) -> void:
	var toggles := ChromeToggles.new()
	toggles._ready()
	toggles._on_pressed("sidebar")
	t.check(toggles.is_hidden("sidebar"), "pressing hides the sidebar")
	toggles._on_pressed("sidebar")
	t.check(not toggles.is_hidden("sidebar"), "pressing again shows it")
	toggles._on_pressed("composer")
	t.check(toggles.is_hidden("composer"), "the composer is independent of the sidebar")
	t.check(not toggles.is_hidden("sidebar"), "hiding one does not hide the other")
	toggles.free()


## The composition root needs the new state, so the signal must carry it rather
## than making the listener re-read the control.
func test_emits_the_new_state(t) -> void:
	var toggles := ChromeToggles.new()
	toggles._ready()
	var seen: Array = []
	toggles.toggled.connect(func(name: String, hidden: bool): seen.append([name, hidden]))
	toggles._on_pressed("composer")
	t.check(seen.size() == 1, "one toggle emits once")
	if seen.size() == 1:
		t.check(seen[0][0] == "composer", "the signal names the overlay")
		t.check(seen[0][1] == true, "the signal carries the new hidden state")
	toggles._on_pressed("composer")
	if seen.size() == 2:
		t.check(seen[1][1] == false, "the second toggle reports visible again")
	toggles.free()


## Every hideable overlay must be reachable from the cluster, or a panel could be
## hidden with no control to restore it.
func test_every_entry_is_offered(t) -> void:
	var offered: Array[String] = []
	for entry in ChromeToggles.ENTRIES:
		offered.append(str(entry["name"]))
	for name: String in OfficeShellLayout.HIDEABLE:
		t.check(offered.has(name), "the cluster offers a control for %s" % name)
	t.check(
		not offered.has("toggles"),
		"the cluster does not offer to hide itself"
	)


## State must be readable as text, not only as a tint or a pressed flag.
func test_labels_state_the_action_not_the_colour(t) -> void:
	var toggles := ChromeToggles.new()
	toggles._ready()
	var button := toggles._buttons["sidebar"] as Button
	t.check(button != null, "the sidebar has a button")
	if button == null:
		toggles.free()
		return
	var shown_label := button.text
	toggles._on_pressed("sidebar")
	var hidden_label := button.text
	t.check(shown_label != hidden_label, "the label changes with the state")
	t.check(shown_label == "Hide", "a visible panel offers to Hide")
	t.check(hidden_label == "Show", "a hidden panel offers to Show")
	t.check(not shown_label.is_empty(), "the label is never blank")
	toggles.free()


func test_set_hidden_restores_an_arrangement(t) -> void:
	var toggles := ChromeToggles.new()
	toggles._ready()
	toggles.set_hidden("sidebar", true)
	toggles.set_hidden("composer", true)
	t.check(toggles.hidden_names().size() == 2, "both can be hidden at once")
	toggles.set_hidden("sidebar", false)
	t.check(toggles.hidden_names() == ["composer"], "one can be shown again alone")
	toggles.free()


func test_never_offers_to_hide_itself(t) -> void:
	var toggles := ChromeToggles.new()
	toggles._ready()
	t.check(not toggles._buttons.has("toggles"), "there is no control for the cluster")
	toggles.free()