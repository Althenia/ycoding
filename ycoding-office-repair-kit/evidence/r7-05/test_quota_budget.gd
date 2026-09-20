## Local advisory budget tests (R7-05).
##
## The acceptance is: "Period/scope/threshold persistence and honest warning labels, never
## presented as provider-side limits."
##
## The kit's contract draws three DISTINCT things that a careless UI merges into one:
##
##   A PROVIDER QUOTA is provider data - the account's own limit.
##   A RATE LIMIT is a time-window constraint or a 429 observation.
##   A LOCAL BUDGET is the user's own warning or execution policy.
##
## "Each needs its own label." The decisive sentence for this task is: "No setting silently
## stops work because a best-effort remote quota is stale", and: "A budget presented as
## hard/enforced requires backend admission/continuation enforcement shared with the TUI and
## all concurrent sessions, not disabling the desktop Send button."
##
## So the shape of the answer is fixed: this is an ADVISORY budget. It warns, it never stops
## work, and it is never presented as the provider's own limit. Three properties make that
## structural rather than conventional:
##
##   * IT CANNOT ENFORCE. There is no API on this class that blocks, denies, or cancels
##     anything. `is_advisory` is true by construction and a mutation that makes it false is
##     caught.
##   * IT IS LABELLED AS THE USER'S OWN. The label names the scope and the currency, and
##     says a warning is the user's setting rather than the provider's.
##   * ITS NUMBERS ARE EXPLICIT ABOUT WHAT THEY DO NOT KNOW. A threshold compares against
##     KNOWN spend, and unknown spend means the comparison is partial rather than passing.
##
## Persistence follows the established desktop-preference pattern: versioned, atomic, and
## allow-listed fields only.
extends RefCounted


func run(t) -> void:
	test_a_budget_is_advisory_by_construction(t)
	test_a_budget_never_stops_work_through_its_own_api(t)
	test_a_budget_names_the_scope_it_is_for(t)
	test_a_budget_states_its_currency_and_period(t)
	test_a_budget_is_never_labelled_a_provider_limit(t)
	test_an_overlapping_warning_does_not_multiply_the_cost(t)
	test_a_threshold_over_unknown_spend_is_partial_not_passing(t)
	test_a_threshold_over_known_spend_warns(t)
	test_dismissal_is_remembered(t)
	test_a_budget_round_trips_through_its_store(t)
	test_a_store_refuses_an_unknown_schema_version(t)
	test_a_store_write_is_atomic(t)
	test_a_store_copies_only_declared_fields(t)
	test_an_unknown_scope_is_refused(t)
	test_a_negative_threshold_is_refused(t)


## A budget as the page builds it.
func _budget(overrides: Dictionary = {}) -> QuotaBudget:
	var base := {
		"scope": QuotaBudget.SCOPE_PROVIDER,
		"scope_id": "openrouter",
		"unit": "usd",
		"limit": 60.0,
		"period_seconds": 604800,
		"warn_at": 0.8,
	}
	for key in overrides:
		base[key] = overrides[key]
	return QuotaBudget.from_fields(base)


## An advisory budget is advisory BY CONSTRUCTION, not by a flag someone remembered to set.
func test_a_budget_is_advisory_by_construction(t) -> void:
	var budget := _budget()
	t.check(budget.is_advisory(), "a local budget is advisory")
	t.check(
		not budget.is_enforced(),
		"and it is not enforced, because nothing in the runtime enforces it"
	)
	t.check(
		QuotaBudget.ENFORCED_REASON.contains("backend"),
		"the reason names what enforcement would actually require (%s)" % QuotaBudget.ENFORCED_REASON
	)


## No API on this class stops work. A budget that could refuse a prompt through its own
## surface would be an enforced budget wearing an advisory label.
func test_a_budget_never_stops_work_through_its_own_api(t) -> void:
	var budget := _budget({"limit": 1.0, "warn_at": 0.5})
	var over := budget.evaluate(999.0, true)
	t.check(over.is_over(), "spend far past the limit is over it")
	t.check(
		over.should_warn(),
		"so it warns"
	)
	# The budget reports; it does not decide. There is no deny, block, or cancel on it.
	t.check(
		not budget.has_method("deny") and not budget.has_method("block")
		and not budget.has_method("cancel"),
		"the budget exposes no method that could refuse work"
	)
	t.check(
		budget.label().to_lower().contains("advisory") or budget.label().to_lower().contains("warning"),
		"and its own label says it is a warning (%s)" % budget.label()
	)


## A budget names the scope it applies to, and the scopes are the ones with real accounting.
func test_a_budget_names_the_scope_it_is_for(t) -> void:
	var provider := _budget({"scope": QuotaBudget.SCOPE_PROVIDER, "scope_id": "openrouter"})
	t.check_equal(provider.scope(), QuotaBudget.SCOPE_PROVIDER, "the provider scope is kept")
	t.check(provider.scope_id() == "openrouter", "and its scope id")
	t.check(
		provider.label().contains("openrouter"),
		"and the label names it (%s)" % provider.label()
	)
	var project := _budget({"scope": QuotaBudget.SCOPE_PROJECT, "scope_id": "prj_alpha"})
	t.check(
		project.label().contains("prj_alpha"),
		"a project budget names its project (%s)" % project.label()
	)
	var session := _budget({"scope": QuotaBudget.SCOPE_SESSION, "scope_id": "ses_a"})
	t.check(
		session.label().contains("ses_a"),
		"a session budget names its session (%s)" % session.label()
	)


## Currency and period are explicit. A budget in dollars is not a budget in credits, and a
## weekly period is not a daily one.
func test_a_budget_states_its_currency_and_period(t) -> void:
	var budget := _budget({"unit": "usd", "period_seconds": 86400})
	t.check_equal(budget.unit(), "usd", "the unit is stated")
	t.check_equal(budget.period_text(), "1 days", "and the period is rendered from its seconds")
	var weekly := _budget({"period_seconds": 604800})
	t.check_equal(weekly.period_text(), "7 days", "a different period renders differently")
	t.check(
		budget.label().contains("usd"),
		"the label names the currency (%s)" % budget.label()
	)


## THE LABEL NEVER CLAIMS TO BE THE PROVIDER'S LIMIT. This is the acceptance's own phrase:
## "never presented as provider-side limits".
func test_a_budget_is_never_labelled_a_provider_limit(t) -> void:
	var budget := _budget()
	var label := budget.label().to_lower()
	t.check(
		not label.contains("provider limit"),
		"the label does not claim to be a provider limit (%s)" % budget.label()
	)
	t.check(
		not label.contains("account limit"),
		"nor an account limit"
	)
	t.check(
		label.contains("your") or label.contains("advisory") or label.contains("local"),
		"and it says it is the user's own (%s)" % budget.label()
	)
	# The two surfaces are distinguishable side by side, which is the whole point.
	var quota := QuotaWindow.from_wire({
		"id": "k", "label": "Key limit", "unit": "usd", "used": 1.0, "limit": 50.0,
	})
	t.check(
		quota.label() != budget.label(),
		"a provider window and a local budget do not share a label"
	)


## Overlapping warnings may appear, but the COST is not multiplied. Two budgets that both
## warn on the same spend do not make it twice as much.
func test_an_overlapping_warning_does_not_multiply_the_cost(t) -> void:
	var provider := _budget({"scope": QuotaBudget.SCOPE_PROVIDER, "scope_id": "openrouter"})
	var project := _budget({"scope": QuotaBudget.SCOPE_PROJECT, "scope_id": "prj_alpha"})
	var spend := 55.0
	var one := provider.evaluate(spend, true)
	var two := project.evaluate(spend, true)
	t.check(one.should_warn() and two.should_warn(), "both warn on the same spend")
	# The spend each reports is the SAME spend, not a share of it and not a sum.
	t.check_equal(
		one.spend_text(), two.spend_text(),
		"and each reports the same observed spend rather than a divided or doubled share"
	)


## A threshold compared against UNKNOWN spend is PARTIAL, not passing. Reporting "under
## budget" when the spend is unread would be a claim the client cannot make.
func test_a_threshold_over_unknown_spend_is_partial_not_passing(t) -> void:
	var budget := _budget({"limit": 60.0, "warn_at": 0.8})
	var unknown := budget.evaluate(0.0, false)
	t.check(
		not unknown.is_known(),
		"an evaluation over unknown spend is marked partial"
	)
	t.check(
		not unknown.should_warn(),
		"and it does not warn, because a warning needs a known figure"
	)
	t.check(
		not unknown.is_over(),
		"and it is NOT reported as over, because nothing is known"
	)
	t.check(
		unknown.text().to_lower().contains("not reported") or unknown.text().to_lower().contains("unknown"),
		"and its text says the spend is unknown (%s)" % unknown.text()
	)


## A known spend past the threshold warns, with the figures that produced it.
func test_a_threshold_over_known_spend_warns(t) -> void:
	var budget := _budget({"limit": 60.0, "warn_at": 0.8})
	var under := budget.evaluate(10.0, true)
	t.check(under.is_known(), "a known spend is known")
	t.check(not under.should_warn(), "spend well under the threshold does not warn")
	var over := budget.evaluate(55.0, true)
	t.check(over.should_warn(), "spend past the threshold warns")
	t.check(over.text().contains("55"), "and its text carries the observed spend (%s)" % over.text())
	t.check(over.text().contains("60"), "and the budget's limit")


## A dismissal is remembered per budget, so a warning the user has seen does not nag.
func test_dismissal_is_remembered(t) -> void:
	var budget := _budget()
	t.check(not budget.is_dismissed(), "a new budget is not dismissed")
	budget.dismiss()
	t.check(budget.is_dismissed(), "and dismissing it is remembered")
	# Dismissal suppresses the WARNING, never the accounting: the figures stay readable.
	var over := budget.evaluate(999.0, true)
	t.check(
		not over.should_warn(),
		"a dismissed budget does not warn again"
	)
	t.check(
		over.text().contains("999"),
		"but its figures are still reported (%s)" % over.text()
	)


## A budget round-trips through its store, keeping what it was set to.
func test_a_budget_round_trips_through_its_store(t) -> void:
	DirAccess.remove_absolute(ProjectSettings.globalize_path("user://test_r705_budgets.cfg"))
	var store := QuotaBudgetStore.new()
	store.file_path = "user://test_r705_budgets.cfg"
	var budget := _budget({"scope": QuotaBudget.SCOPE_SESSION, "scope_id": "ses_a", "limit": 12.5})
	store.put(budget)
	budget.dismiss()
	store.put(budget)
	var error := store.save()
	t.check_equal(error, OK, "the write succeeds")
	var reloaded := QuotaBudgetStore.new()
	reloaded.file_path = "user://test_r705_budgets.cfg"
	reloaded.load()
	var back := reloaded.get_budget(QuotaBudget.SCOPE_SESSION, "ses_a")
	t.check(not back.scope().is_empty(), "the budget comes back")
	t.check_equal(back.limit(), 12.5, "with its limit")
	t.check(back.is_dismissed(), "and its dismissal")
	DirAccess.remove_absolute(ProjectSettings.globalize_path("user://test_r705_budgets.cfg"))


## A schema version this build does not know is NOT adopted: guessing at an unknown shape is
## how a preference store reads nonsense as state.
func test_a_store_refuses_an_unknown_schema_version(t) -> void:
	var path := "user://test_r705_version.cfg"
	DirAccess.remove_absolute(ProjectSettings.globalize_path(path))
	var config := ConfigFile.new()
	config.set_value(QuotaBudgetStore.SECTION, QuotaBudgetStore.VERSION_KEY, 99)
	config.set_value(QuotaBudgetStore.SECTION, QuotaBudgetStore.BUDGETS_KEY, {})
	config.save(path)
	var store := QuotaBudgetStore.new()
	store.file_path = path
	store.load()
	t.check_equal(store.budgets().size(), 0, "no budget is adopted from an unknown version")
	t.check(
		not store.last_error().is_empty(),
		"and the version gap is reported (%s)" % store.last_error()
	)
	DirAccess.remove_absolute(ProjectSettings.globalize_path(path))


## The write is atomic: it goes through a temporary file beside the target, so a failure
## cannot leave a half-written budget where the good one was.
func test_a_store_write_is_atomic(t) -> void:
	var path := "user://test_r705_atomic.cfg"
	DirAccess.remove_absolute(ProjectSettings.globalize_path(path))
	var store := QuotaBudgetStore.new()
	store.file_path = path
	store.put(_budget())
	t.check(
		QuotaBudgetStore.temp_path(path) != path,
		"a write goes through its own temporary path"
	)
	t.check_equal(store.save(), OK, "the write succeeds")
	t.check(
		not FileAccess.file_exists(QuotaBudgetStore.temp_path(path)),
		"and leaves no temporary file behind"
	)

	# Prove the write really goes THROUGH the temp path. Occupy that path with a directory: a
	# write that truly stages there cannot complete, while a write straight to the target
	# would succeed regardless. Asserting the path string alone proved nothing.
	var blocked := "user://test_r705_blocked.cfg"
	DirAccess.remove_absolute(ProjectSettings.globalize_path(blocked))
	DirAccess.remove_absolute(ProjectSettings.globalize_path(QuotaBudgetStore.temp_path(blocked))
		+ "/x")
	DirAccess.make_dir_recursive_absolute(
		ProjectSettings.globalize_path(QuotaBudgetStore.temp_path(blocked))
	)
	var staged := QuotaBudgetStore.new()
	staged.file_path = blocked
	staged.put(_budget())
	var blocked_error := staged.save()
	t.check(
		blocked_error != OK,
		"a write whose staging path is unusable does NOT succeed (%d)" % blocked_error
	)
	t.check(
		not FileAccess.file_exists(blocked),
		"and nothing was published at the target, so a failed write left no partial file"
	)
	DirAccess.remove_absolute(ProjectSettings.globalize_path(QuotaBudgetStore.temp_path(blocked)))
	DirAccess.remove_absolute(ProjectSettings.globalize_path(path))


## Only the declared fields are copied, so a credential handed over cannot reach the file.
func test_a_store_copies_only_declared_fields(t) -> void:
	var store := QuotaBudgetStore.new()
	store.put(_budget({"scope_id": "openrouter", "api_key": "should-not-be-stored"}))
	# The put itself must not carry an undeclared field through.
	var stored := store.get_budget(QuotaBudget.SCOPE_PROVIDER, "openrouter")
	t.check(
		not stored.raw().has("api_key"),
		"an undeclared field is dropped at the boundary"
	)


## A scope the accounting does not support is refused rather than accepted and ignored.
func test_an_unknown_scope_is_refused(t) -> void:
	t.check(
		not QuotaBudget.is_supported_scope("galaxy"),
		"an unknown scope is not supported"
	)
	var budget := QuotaBudget.from_fields({"scope": "galaxy", "scope_id": "x", "limit": 1.0})
	t.check(budget.scope().is_empty(), "and a budget for it is not created")
	t.check(
		not budget.last_error().is_empty(),
		"with a reason (%s)" % budget.last_error()
	)


## A negative threshold is refused: a budget of less than nothing is not a budget.
func test_a_negative_threshold_is_refused(t) -> void:
	var budget := QuotaBudget.from_fields({
		"scope": QuotaBudget.SCOPE_PROVIDER, "scope_id": "x", "unit": "usd", "limit": -5.0,
	})
	# Both halves asserted separately: an `or` would pass for either one, and a budget that
	# was created with a negative limit but kept its error would still be a budget.
	t.check(budget.limit() <= 0.0, "a negative limit is not stored (%f)" % budget.limit())
	t.check(
		not budget.last_error().is_empty(),
		"and it is refused with a reason (%s)" % budget.last_error()
	)
	t.check(
		budget.scope().is_empty(),
		"so no budget exists for that scope (%s)" % budget.scope()
	)
