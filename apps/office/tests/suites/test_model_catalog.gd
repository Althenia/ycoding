## Model reference and catalogue contract tests.
##
## These pin the two places a model selector can lie to the user:
##
##   1. the config string form `provider/id#variant` splits on the FIRST slash
##      only, because model IDs themselves contain slashes, and malformed text
##      is rejected rather than silently coerced;
##   2. a displayed label is composed from the wire fields, never echoed from
##      that config string, and a variant stop is offered only when the model
##      itself declares it.
extends RefCounted


func run(t) -> void:
	test_parse_ref_round_trips(t)
	test_parse_ref_splits_on_first_slash_only(t)
	test_parse_ref_rejects_malformed_input(t)
	test_variant_stops_are_declared_by_the_model(t)
	test_variant_index_locates_declared_stops(t)
	test_group_by_provider_assigns_every_model_once(t)
	test_demo_catalog_is_synthetic_and_wire_shaped(t)
	test_provider_and_variant_labels(t)
	test_display_label_composes_from_fields(t)
	test_the_synthetic_catalogue_is_identifiable(t)


## The config string form is what config files and the CLI carry. A value that
## survives parse -> format unchanged is the round-trip a real config needs.
func test_parse_ref_round_trips(t) -> void:
	var examples := [
		"openrouter/deepseek/deepseek-v4.1-flash#max",
		"anthropic/claude-sonnet-4#high",
		"openrouter/deepseek/deepseek-v4-pro",
	]
	for text in examples:
		var ref := ModelCatalog.parse_ref(text)
		t.check(not ref.is_empty(), "parses %s" % text)
		t.check(
			ModelCatalog.format_ref(ref) == text,
			"%s round-trips through format_ref" % text
		)
	var flash := ModelCatalog.parse_ref("openrouter/deepseek/deepseek-v4.1-flash#max")
	t.check(flash.get("providerID", "") == "openrouter", "provider is the first segment")
	t.check(
		flash.get("id", "") == "deepseek/deepseek-v4.1-flash",
		"the id keeps its own slashes"
	)
	t.check(flash.get("variant", "") == "max", "the variant follows the #")
	var plain := ModelCatalog.parse_ref("openrouter/deepseek/deepseek-v4-pro")
	t.check(plain.get("variant", "") == "", "an absent variant parses as empty")


## Only the FIRST slash separates provider from id. Splitting on the last slash
## would turn the model id into `flash` and lose the provider path.
func test_parse_ref_splits_on_first_slash_only(t) -> void:
	var ref := ModelCatalog.parse_ref("openrouter/deepseek/deepseek-v4.1-flash")
	t.check(ref.get("providerID", "") == "openrouter", "provider is openrouter")
	t.check(
		ref.get("id", "") == "deepseek/deepseek-v4.1-flash",
		"the id is the whole remainder after the first slash"
	)
	t.check(
		not str(ref.get("id", "")).contains("openrouter"),
		"the provider prefix does not leak into the id"
	)
	var deep := ModelCatalog.parse_ref("openrouter/a/b/c/d")
	t.check(deep.get("providerID", "") == "openrouter", "deep id keeps its provider")
	t.check(deep.get("id", "") == "a/b/c/d", "every later slash stays in the id")


## Malformed config text must be rejected, not coerced into a plausible ref.
func test_parse_ref_rejects_malformed_input(t) -> void:
	var malformed := [
		"",
		"no-slash-at-all",
		"/leading-slash",
		"openrouter/",
		"openrouter/#max",
		"open#router/model",
		"openrouter/model#",
		"openrouter/model#a#b",
	]
	for text in malformed:
		t.check(
			ModelCatalog.parse_ref(text).is_empty(),
			"rejects malformed ref '%s'" % text
		)


## A model offers exactly the variant stops it declares. `medium` must never
## appear for the deepseek flash entry, which does not declare it.
func test_variant_stops_are_declared_by_the_model(t) -> void:
	var flash := _demo_entry("deepseek/deepseek-v4.1-flash")
	t.check(not flash.is_empty(), "the deepseek flash entry exists")
	var stops := ModelCatalog.variant_stops(flash)
	t.check(stops == ["low", "high", "max"], "the flash stops are low, high, max")
	t.check(not stops.has("medium"), "the flash entry does not offer medium")
	t.check(stops.size() == 3, "no extra stop is invented")
	var luna := _demo_entry("gpt-5.6-luna")
	t.check(
		ModelCatalog.variant_stops(luna).has("medium"),
		"a model that declares medium still offers it"
	)
	var pro := _demo_entry("deepseek/deepseek-v4-pro")
	t.check(
		ModelCatalog.variant_stops(pro).is_empty(),
		"a model with no variants offers no stops"
	)


func test_variant_index_locates_declared_stops(t) -> void:
	var flash := _demo_entry("deepseek/deepseek-v4.1-flash")
	t.check(ModelCatalog.variant_index(flash, "low") == 0, "low is the first stop")
	t.check(ModelCatalog.variant_index(flash, "high") == 1, "high is the second stop")
	t.check(ModelCatalog.variant_index(flash, "max") == 2, "max is the third stop")
	t.check(ModelCatalog.variant_index(flash, "medium") == -1, "medium is not a stop")
	t.check(ModelCatalog.variant_index(flash, "") == -1, "an empty variant is not a stop")


## Grouping must partition the catalogue: every provider present, every model in
## exactly one group, groups ordered by provider id, models newest-first.
func test_group_by_provider_assigns_every_model_once(t) -> void:
	var catalog := ModelCatalog.demo_catalog()
	var groups := ModelCatalog.group_by_provider(catalog)
	t.check(groups.size() == 3, "three providers are present")
	var seen := {}
	var total := 0
	var last_provider := ""
	for group in groups:
		var provider := str(group.get("provider", ""))
		var models: Array = group.get("models", [])
		t.check(not provider.is_empty(), "every group names its provider")
		t.check(not models.is_empty(), "group %s is not empty" % provider)
		t.check(provider > last_provider, "groups are sorted by provider id")
		last_provider = provider
		for model in models:
			var entry: Dictionary = model
			t.check(
				str(entry.get("providerID", "")) == provider,
				"every model in group %s belongs to it" % provider
			)
			var key := "%s/%s" % [provider, entry.get("id", "")]
			t.check(not seen.has(key), "model %s lands in exactly one group" % key)
			seen[key] = true
			total += 1
	t.check(total == catalog.size(), "every model is represented once")
	var openrouter := _group_for(groups, "openrouter")
	t.check(not openrouter.is_empty(), "the openrouter group exists")
	t.check(openrouter.size() == 2, "openrouter has two models")
	t.check(
		str(openrouter[0].get("id", "")) == "deepseek/deepseek-v4.1-flash",
		"the newest openrouter model sorts first"
	)


## The demo set is fabricated, and the UI must be able to prove that. Every
## entry stays wire-shaped so demo and live share one presentation path.
func test_demo_catalog_is_synthetic_and_wire_shaped(t) -> void:
	var catalog := ModelCatalog.demo_catalog()
	t.check(not catalog.is_empty(), "the demo catalogue is non-empty")
	t.check(ModelCatalog.is_demo_catalog(catalog), "the demo catalogue is identified as demo")
	t.check(not ModelCatalog.is_demo_catalog([]), "an empty catalogue is not labelled demo")
	var providers := {}
	for model in catalog:
		var entry: Dictionary = model
		var text := str(ModelCatalog.format_ref({
			"providerID": entry.get("providerID", ""),
			"id": entry.get("id", ""),
			"variant": "",
		}))
		var parsed := ModelCatalog.parse_ref(text)
		t.check(not parsed.is_empty(), "demo entry %s parses as a valid ref" % text)
		t.check(
			parsed.get("providerID", "") == entry.get("providerID", ""),
			"demo entry %s keeps its provider" % text
		)
		t.check(
			parsed.get("id", "") == entry.get("id", ""),
			"demo entry %s keeps its id" % text
		)
		providers[str(entry.get("providerID", ""))] = true
	t.check(providers.has("openrouter"), "the demo set covers openrouter")
	t.check(providers.has("anthropic"), "the demo set covers anthropic")
	t.check(providers.has("openai"), "the demo set covers openai")
	var live_entry := {
		"id": "claude-opus-4",
		"modelID": "claude-opus-4",
		"providerID": "anthropic",
		"name": "Claude Opus 4",
		"variants": [],
		"status": "active",
		"enabled": true,
		"limit": {"context": 200000, "output": 64000},
		"cost": [],
		"time": {"released": 900},
	}
	t.check(
		not ModelCatalog.is_demo_catalog([live_entry]),
		"a hand-built server entry is not demo data"
	)
	var mixed: Array = catalog.duplicate()
	mixed.append(live_entry)
	t.check(
		not ModelCatalog.is_demo_catalog(mixed),
		"a mixed catalogue is never labelled demo"
	)


func test_provider_and_variant_labels(t) -> void:
	t.check(ModelCatalog.provider_label("openrouter") == "OpenRouter", "openrouter label")
	t.check(ModelCatalog.provider_label("openai") == "OpenAI", "openai label")
	t.check(ModelCatalog.provider_label("anthropic") == "Anthropic", "anthropic label")
	t.check(
		ModelCatalog.provider_label("google-vertex") == "Google Vertex",
		"google-vertex label"
	)
	t.check(
		ModelCatalog.provider_label("github-copilot") == "GitHub Copilot",
		"github-copilot label"
	)
	t.check(ModelCatalog.provider_label("acme") == "Acme", "an unknown provider still reads")
	t.check(ModelCatalog.provider_label("") == "", "an empty provider has no label")
	t.check(ModelCatalog.variant_label("max") == "Max", "max label")
	t.check(ModelCatalog.variant_label("low") == "Low", "low label")
	t.check(ModelCatalog.variant_label("medium") == "Medium", "medium label")
	t.check(ModelCatalog.variant_label("") == "", "an empty variant has no label")


## A user-facing label is composed from fields. Echoing the config string would
## show `openrouter/deepseek/...#max`, which is not a label.
func test_display_label_composes_from_fields(t) -> void:
	var flash := _demo_entry("deepseek/deepseek-v4.1-flash")
	t.check(
		ModelCatalog.display_label(flash, "max") == "DeepSeek V4.1 Flash Max",
		"the label composes the name and the variant"
	)
	var with_variant := ModelCatalog.display_label(flash, "max")
	t.check(not with_variant.contains("/"), "the label never contains a slash")
	t.check(not with_variant.contains("#"), "the label never contains a hash")
	var without_variant := ModelCatalog.display_label(flash, "")
	t.check(
		without_variant == "DeepSeek V4.1 Flash",
		"an empty variant is omitted cleanly"
	)
	t.check(
		without_variant == without_variant.strip_edges(),
		"an omitted variant leaves no trailing space"
	)
	t.check(
		ModelCatalog.display_label(flash, "medium") == "DeepSeek V4.1 Flash Medium",
		"a stop the model lacks still renders from its own id"
	)
	var unnamed := {"id": "mystery-model", "providerID": "openrouter", "variants": []}
	t.check(
		ModelCatalog.display_label(unnamed, "") == "mystery-model",
		"a missing name falls back to the id"
	)
	t.check(
		ModelCatalog.model_label(flash) == "DeepSeek V4.1 Flash",
		"model_label prefers the server name"
	)
	t.check(
		ModelCatalog.model_label(unnamed) == "mystery-model",
		"model_label falls back to the id"
	)


## The grouping output for one provider, so a test can look a group up by name
## instead of depending on its sort position.
func _group_for(groups: Array, provider_id: String) -> Array:
	for group in groups:
		var entry: Dictionary = group
		if str(entry.get("provider", "")) == provider_id:
			return entry.get("models", [])
	return []


## The demo entry for an id, so tests exercise the shipped demo set rather than
## a parallel fixture that could drift from it.
func _demo_entry(id: String) -> Dictionary:
	for model in ModelCatalog.demo_catalog():
		var entry: Dictionary = model
		if str(entry.get("id", "")) == id:
			return entry
	return {}


## A fabricated catalogue must never be presented as the runtime's own. The pill
## is the one place a user reads which model is in use, so the synthetic set is
## marked there; this pins the predicate the pill relies on.
func test_the_synthetic_catalogue_is_identifiable(t) -> void:
	var demo := ModelCatalog.demo_catalog()
	t.check(demo.size() > 0, "the demo catalogue is not empty")
	t.check(
		ModelCatalog.is_demo_catalog(demo),
		"the synthetic catalogue identifies itself"
	)
	# A real catalogue has no synthetic marker, so the same call must not claim
	# otherwise.
	var real := [{"id": "real-id", "providerID": "openrouter", "name": "Real"}]
	t.check(
		not ModelCatalog.is_demo_catalog(real),
		"a real catalogue is not marked synthetic"
	)
	t.check(not ModelCatalog.is_demo_catalog([]), "an empty catalogue is not synthetic")
