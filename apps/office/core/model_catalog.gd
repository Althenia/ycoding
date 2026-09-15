## Model reference and catalogue presentation logic.
##
## A model reference has three separate fields on the wire: `Model.Ref` is
## `{ id, providerID, variant? }`. `session.switchModel` sends those fields
## directly. The single string `provider/id#variant` is only a config-file and
## CLI convenience form (`Model.Ref.parse`), so it never becomes a user-facing
## label: display text is composed from fields by `display_label`.
##
## The server orders models by `time.released` descending (`catalog.ts`), which
## is the ordering `group_by_provider` reproduces inside each provider group.
## Variant stops come from the model entry's own `variants`; there is no global
## variant list, and a stop the model does not declare is never offered.
class_name ModelCatalog
extends RefCounted

## Display names for the provider IDs in `Provider.ID`. Unknown IDs fall back to
## a title-cased form of the raw id.
const PROVIDER_LABELS := {
	"opencode": "OpenCode",
	"anthropic": "Anthropic",
	"openai": "OpenAI",
	"google": "Google",
	"google-vertex": "Google Vertex",
	"github-copilot": "GitHub Copilot",
	"amazon-bedrock": "Amazon Bedrock",
	"azure": "Azure",
	"openrouter": "OpenRouter",
	"mistral": "Mistral",
	"gitlab": "GitLab",
}

## Marks an entry as belonging to the synthetic demo set. Server entries never
## carry it, so `is_demo_catalog` can identify demo data without guessing.
const SYNTHETIC_FIELD := "synthetic"


## Parse the config/CLI string form into `{providerID, id, variant}`.
##
## Only the FIRST `/` separates provider from id, because model IDs themselves
## contain slashes (`openrouter/deepseek/deepseek-v4.1-flash`). `variant` is ""
## when absent. Returns {} for any malformed input rather than coercing it.
static func parse_ref(text: String) -> Dictionary:
	var provider_end := text.find("/")
	if provider_end <= 0:
		return {}
	var provider_id := text.substr(0, provider_end)
	var variant_start := text.find("#", provider_end + 1)
	var id := text.substr(provider_end + 1, -1 if variant_start == -1 else variant_start - provider_end - 1)
	var variant := "" if variant_start == -1 else text.substr(variant_start + 1)
	if id.is_empty() or provider_id.contains("#"):
		return {}
	if variant_start != -1 and (variant.is_empty() or variant.contains("#")):
		return {}
	return {"providerID": provider_id, "id": id, "variant": variant}


## Format `{providerID, id, variant}` back to the config string form, omitting
## the `#variant` suffix when the variant is empty.
static func format_ref(ref: Dictionary) -> String:
	var provider_id := str(ref.get("providerID", ""))
	var id := str(ref.get("id", ""))
	var variant := str(ref.get("variant", ""))
	if variant.is_empty():
		return "%s/%s" % [provider_id, id]
	return "%s/%s#%s" % [provider_id, id, variant]


## The model's own label. Prefers the server-provided `name`, which is the
## human name, and falls back to the raw id only when no name is present.
static func model_label(entry: Dictionary) -> String:
	var name := str(entry.get("name", ""))
	if not name.is_empty():
		return name
	return str(entry.get("id", ""))


## The composer pill label, composed from fields: "GPT-5.6 Luna Medium".
## Uses `name` when present and falls back to `id`. Appends the variant label
## only when `variant` is non-empty. Never renders the "provider/id#variant"
## form — that is a config/transport string, not a user-facing label.
static func display_label(entry: Dictionary, variant: String) -> String:
	var base := model_label(entry)
	var suffix := variant_label(variant)
	if suffix.is_empty():
		return base
	return "%s %s" % [base, suffix]


## Human label for a variant id, e.g. "max" -> "Max". "" for an empty id.
static func variant_label(variant_id: String) -> String:
	if variant_id.strip_edges().is_empty():
		return ""
	return _title_words(variant_id)


## The variant stops for a model entry, in the order the entry declares them.
## A model that declares no variants offers no stops.
static func variant_stops(entry: Dictionary) -> Array[String]:
	var stops: Array[String] = []
	var variants = entry.get("variants", [])
	if not (variants is Array):
		return stops
	for variant in variants:
		if not (variant is Dictionary):
			continue
		var id := str((variant as Dictionary).get("id", ""))
		if not id.is_empty():
			stops.append(id)
	return stops


## The index of `variant` within `variant_stops(entry)`, or -1 when the entry
## does not declare it.
static func variant_index(entry: Dictionary, variant: String) -> int:
	return variant_stops(entry).find(variant)


## Group entries by provider, newest-first inside each group by `time.released`
## (the server's own ordering), with groups sorted by provider id.
static func group_by_provider(models: Array) -> Array:
	var by_provider: Dictionary = {}
	for model in models:
		if not (model is Dictionary):
			continue
		var entry: Dictionary = model
		var provider_id := str(entry.get("providerID", ""))
		var group: Array = by_provider.get(provider_id, [])
		group.append(entry)
		by_provider[provider_id] = group
	var provider_ids: Array = by_provider.keys()
	provider_ids.sort()
	var groups: Array = []
	for provider_id in provider_ids:
		var group: Array = by_provider[provider_id]
		group.sort_custom(_newest_first)
		groups.append({"provider": str(provider_id), "models": group})
	return groups


## A clear display name for a provider id, e.g. "openrouter" -> "OpenRouter".
## Used for popover group headers, not for inline model display.
static func provider_label(provider_id: String) -> String:
	if provider_id.is_empty():
		return ""
	return PROVIDER_LABELS.get(provider_id, _title_words(provider_id))


## The DEMO catalogue: a small, explicitly synthetic set used when no server is
## reachable.
##
## This set is fabricated, not server data. It must be labelled as synthetic
## wherever it is shown; every entry carries `synthetic: true` so `is_demo_catalog`
## can prove it. All other fields stay wire-shaped so demo and live entries flow
## through one presentation path.
static func demo_catalog() -> Array:
	return [
		{
			"id": "deepseek/deepseek-v4.1-flash",
			"modelID": "deepseek/deepseek-v4.1-flash",
			"providerID": "openrouter",
			"name": "DeepSeek V4.1 Flash",
			"variants": [{"id": "low"}, {"id": "high"}, {"id": "max"}],
			"status": "active",
			"enabled": true,
			"limit": {"context": 131072, "output": 32768},
			"cost": [],
			"family": "deepseek",
			"time": {"released": 400},
			SYNTHETIC_FIELD: true,
		},
		{
			"id": "deepseek/deepseek-v4-pro",
			"modelID": "deepseek/deepseek-v4-pro",
			"providerID": "openrouter",
			"name": "DeepSeek V4 Pro",
			"variants": [],
			"status": "active",
			"enabled": true,
			"limit": {"context": 131072, "output": 32768},
			"cost": [],
			"family": "deepseek",
			"time": {"released": 300},
			SYNTHETIC_FIELD: true,
		},
		{
			"id": "claude-sonnet-4",
			"modelID": "claude-sonnet-4",
			"providerID": "anthropic",
			"name": "Claude Sonnet 4",
			"variants": [{"id": "low"}, {"id": "medium"}, {"id": "high"}],
			"status": "active",
			"enabled": true,
			"limit": {"context": 200000, "output": 64000},
			"cost": [],
			"family": "claude",
			"time": {"released": 500},
			SYNTHETIC_FIELD: true,
		},
		{
			"id": "gpt-5.6-luna",
			"modelID": "gpt-5.6-luna",
			"providerID": "openai",
			"name": "GPT-5.6 Luna",
			"variants": [
				{"id": "low"},
				{"id": "medium"},
				{"id": "high"},
				{"id": "xhigh"},
				{"id": "max"},
			],
			"status": "active",
			"enabled": true,
			"limit": {"context": 400000, "output": 128000},
			"cost": [],
			"family": "gpt",
			"time": {"released": 600},
			SYNTHETIC_FIELD: true,
		},
	]


## True when `catalog` is the synthetic demo set rather than server data. A
## catalogue is demo only if it is non-empty and every entry is marked synthetic,
## so a mixed or live catalogue is never labelled as demo.
static func is_demo_catalog(catalog: Array) -> bool:
	if catalog.is_empty():
		return false
	for model in catalog:
		if not (model is Dictionary):
			return false
		if not bool((model as Dictionary).get(SYNTHETIC_FIELD, false)):
			return false
	return true


## Order two entries newest-first by release time, then by id so the result is
## deterministic when two models share a release date.
static func _newest_first(a: Dictionary, b: Dictionary) -> bool:
	var a_released := _released(a)
	var b_released := _released(b)
	if a_released != b_released:
		return a_released > b_released
	return str(a.get("id", "")) < str(b.get("id", ""))


static func _released(entry: Dictionary) -> int:
	var time = entry.get("time", {})
	if not (time is Dictionary):
		return 0
	return int((time as Dictionary).get("released", 0))


## Title-cases a raw id, treating `-` and `_` as word separators, so an unknown
## provider or variant still reads sensibly.
static func _title_words(text: String) -> String:
	return text.replace("-", " ").replace("_", " ").capitalize()
