## Effort slider tests.
##
## The card is the reference's effort picker. Its one hard rule is that the dots
## must be the model's REAL stops: a model with three variants gets three, and a
## model with none is never offered a slider at all.
extends RefCounted


func run(t) -> void:
	test_stop_count_is_the_models_own(t)
	test_knob_sits_at_the_selected_stop(t)
	test_single_stop_has_no_travel(t)
	test_clicking_snaps_to_the_nearest_stop(t)
	test_reset_returns_to_the_first_stop(t)
	test_the_title_names_the_slider_and_the_model(t)
	test_the_card_opens_and_declares_its_bounds(t)
	test_no_card_is_opened_for_a_model_without_variants(t)


func _deepseek() -> Dictionary:
	for entry in ModelCatalog.demo_catalog():
		if str(entry.get("id", "")).find("deepseek-v4.1-flash") != -1:
			return entry
	return {}


func _slider(entry: Dictionary, variant: String) -> EffortSlider:
	var slider := EffortSlider.new()
	slider._ready()
	slider.open(entry, variant, ModelCatalog.variant_stops(entry))
	return slider


## The stops come from the model, never from a fixed global list.
func test_stop_count_is_the_models_own(t) -> void:
	var entry := _deepseek()
	t.check(not entry.is_empty(), "the demo model exists")
	var slider := _slider(entry, "low")
	t.check(
		slider.variants() == ["low", "high", "max"],
		"the slider offers exactly the model's variants"
	)
	t.check(not slider.variants().has("medium"), "it does not invent a medium stop")
	slider.free()


func test_knob_sits_at_the_selected_stop(t) -> void:
	var entry := _deepseek()
	var slider := _slider(entry, "high")
	t.check(slider.current_index() == 1, "high is the middle stop")
	t.check(
		absf(slider.knob_fraction() - 0.5) < 0.001,
		"the knob sits halfway along a three-stop track"
	)
	slider.free()


## One stop means no travel: the knob cannot move, so the fill cannot lie.
func test_single_stop_has_no_travel(t) -> void:
	var entry := {"id": "x", "providerID": "openrouter", "name": "X", "variants": []}
	var slider := EffortSlider.new()
	slider._ready()
	slider.open(entry, "", [])
	t.check(slider.current_index() == 0, "a model with no variants starts at zero")
	t.check(
		slider.knob_fraction() == 0.0,
		"a single-stop track has no travel"
	)
	t.check(slider.selected_variant() == "", "there is no variant to report")
	slider.free()


func test_clicking_snaps_to_the_nearest_stop(t) -> void:
	var entry := _deepseek()
	var slider := _slider(entry, "low")
	t.check(slider.current_index() == 0, "it starts at the first stop")
	slider._on_track_clicked(1.0)
	t.check(slider.current_index() == 2, "clicking the far end selects the last stop")
	slider._on_track_clicked(0.4)
	t.check(slider.current_index() == 1, "clicking near the middle selects the middle")
	slider._on_track_clicked(-5.0)
	t.check(slider.current_index() == 0, "a click before the track clamps to the first")
	slider.free()


func test_reset_returns_to_the_first_stop(t) -> void:
	var entry := _deepseek()
	var slider := _slider(entry, "max")
	var seen: Array = []
	slider.variant_chosen.connect(func(variant: String): seen.append(variant))
	t.check(slider.selected_variant() == "max", "it starts on max")
	slider._on_reset()
	t.check(slider.selected_variant() == "low", "reset returns to the mildest stop")
	t.check(seen == ["low"], "the reset reports the new variant once")
	slider.free()


## The card must name both the effort and the model, which is what makes it
## readable without the surrounding composer.
func test_the_title_names_the_slider_and_the_model(t) -> void:
	var entry := _deepseek()
	var slider := _slider(entry, "max")
	t.check(slider._title.text == "Max", "the title names the variant")
	t.check(not slider._model.text.is_empty(), "the card names the model")
	t.check(
		slider._model.text.find("/") == -1 and slider._model.text.find("#") == -1,
		"the model label is never the config string form"
	)
	slider.free()


## The card opens for a model that has variants, and it declares a height so the
## host can clamp it. It lives in the shell rather than inside the composer, so
## this asserts the properties the clamp depends on rather than guessing at a
## scene tree the headless runner does not have.
func test_the_card_opens_and_declares_its_bounds(t) -> void:
	var panel := PromptPanel.new()
	panel._ready()
	panel.set_models(ModelCatalog.demo_catalog(), "openrouter/deepseek/deepseek-v4.1-flash#high")
	var entry := panel.current_entry()
	t.check(not entry.is_empty(), "the catalogue resolves the selected model")
	var stops := ModelCatalog.variant_stops(entry)
	t.check(stops.size() == 3, "the model declares three stops")
	var card := EffortSlider.new()
	card._ready()
	card.open(entry, "high", stops)
	t.check(card.custom_minimum_size.x > 0.0, "the card declares a width")
	t.check(
		card.custom_minimum_size.y > 0.0,
		"the card declares a height, or the host cannot clamp it into the window"
	)
	t.check(card.selected_variant() == "high", "the card adopts the given variant")
	card.free()
	panel.free()


## A model with no variants must not open a slider, because there would be
## nothing to slide.
func test_no_card_is_opened_for_a_model_without_variants(t) -> void:
	var panel := PromptPanel.new()
	panel._ready()
	var plain: Array = [{
		"id": "m", "modelID": "m", "providerID": "openrouter", "name": "Plain",
		"variants": [], "time": {"released": 1},
	}]
	panel.set_models(plain, "openrouter/m")
	panel._open_effort()
	t.check(not panel._effort.visible, "no card is opened without variants")
	panel.free()
