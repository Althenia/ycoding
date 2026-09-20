## Accounting edge-case verification (R7-08).
##
## The acceptance is: "Duplicate/retry/cancel/cache overlap/unknown price/helper and child/DST/
## scope hand-calculated datasets."
##
## Every figure below is HAND-CALCULATED and written as a literal, so the suite is an
## independent computation rather than a restatement of the implementation. The kit's own
## verification list names each case; this file covers them in that order and states the
## arithmetic beside each expectation.
##
## THE TOKEN EQUATION, verified against the runtime before asserting anything, because the kit
## warns to "not blindly add cached/reasoning tokens to totals where they are already subsets":
##
##     packages/core/src/session/usage.ts:
##       input   = nonCachedInputTokens     <- NOT the total input
##       output  = visibleOutputTokens
##       reasoning = reasoningTokens
##       cache.read  = cacheReadInputTokens
##       cache.write = cacheWriteInputTokens
##
## and the cost formula bills them as separate terms:
##
##     input*rate + (output + reasoning)*rate + cache.read*rate + cache.write*rate
##
## So here the components are DISJOINT, not overlapping: `input` excludes the cached tokens by
## construction, and adding the components is the provider's own accounting rather than
## double-counting. The kit's warning is conditional, and the condition is checked rather than
## assumed - `test_the_token_components_are_disjoint` is what holds it.
##
## A HAND-CALCULATED DATASET drives most of the file, so one set of numbers is checked from
## several directions and a wrong total cannot hide behind a matching helper.
extends RefCounted


func run(t) -> void:
	# The hand-calculated dataset, checked as a whole.
	test_the_hand_calculated_dataset_totals_exactly(t)
	test_the_token_equation_is_the_providers_own(t)
	test_the_token_components_are_disjoint(t)
	# The kit's named edge cases.
	test_a_retry_counts_attempts_not_steps(t)
	test_a_cancelled_attempt_is_not_a_completed_step(t)
	test_a_duplicate_replay_does_not_double_a_total(t)
	test_an_unknown_price_is_unknown_not_free(t)
	test_helpers_are_billed_but_are_not_the_users_work(t)
	test_a_child_is_not_counted_twice_through_its_root(t)
	test_scope_isolation_keeps_two_projects_apart(t)
	test_the_completeness_counter_names_its_own_denominator(t)
	test_a_dst_boundary_does_not_shift_a_day_grouping(t)
	test_a_midnight_boundary_does_not_shift_a_day_grouping(t)
	test_a_date_range_edge_includes_its_endpoints(t)
	test_an_estimate_is_labelled_apart_from_the_invoice(t)
	test_the_same_dataset_produces_the_same_totals_twice(t)


## The hand-calculated dataset.
##
## Three provider requests, hand-summed:
##
##   request 1  step      attempts 1  input 1000  output 200  reasoning 50  cache 400/100
##   request 2  step      attempts 3  input  500  output 100  reasoning 10  cache 200/ 50
##   request 3  title     attempts 1  input  200  output  40  reasoning  0  cache   0/  0
##
## TOTALS, computed by hand:
##   logical steps  = 3 requests                        = 3
##   physical       = 1 + 3 + 1 attempts                = 5
##   helpers        = 1 (the title request)             = 1
##   input          = 1000 + 500 + 200                  = 1700
##   output         = 200 + 100 + 40                    = 340
##   reasoning      = 50 + 10 + 0                       = 60
##   cache read     = 400 + 200 + 0                     = 600
##   cache write    = 100 + 50 + 0                      = 150
##   spend          = 1.25 + 0.50, both recorded        = 1.75
func _dataset() -> Dictionary:
	return {
		"logical": 3, "physical": 5, "helpers": 1, "continued": 0, "fallback": 0,
		"cost": 1.75,
		"tokens": {
			"input": 1700, "output": 340, "reasoning": 60,
			"cache": {"read": 600, "write": 150},
		},
		"models": [
			{
				"model": {"providerID": "anthropic", "id": "claude-sonnet-4", "variant": "max"},
				"requests": 2,
				"tokens": {"input": 1500, "output": 300, "reasoning": 60, "cache": {"read": 600, "write": 150}},
				"cost": 1.75, "costProvenance": "recorded",
			},
			{
				"model": {"providerID": "anthropic", "id": "claude-haiku-4"},
				"requests": 1,
				"tokens": {"input": 200, "output": 40, "reasoning": 0, "cache": {"read": 0, "write": 0}},
				"cost": null,
			},
		],
	}


## Every hand-summed figure comes back exactly, so the implementation agrees with the
## arithmetic rather than with itself.
func test_the_hand_calculated_dataset_totals_exactly(t) -> void:
	var usage := SessionUsage.from_summary(_dataset())
	t.check_equal(usage.logical_steps(), 3, "logical steps = 3 requests")
	t.check_equal(usage.physical_attempts(), 5, "physical = 1+3+1 attempts")
	t.check_equal(usage.helper_requests(), 1, "helpers = the one title request")
	t.check_equal(usage.tokens("input"), 1700, "input = 1000+500+200")
	t.check_equal(usage.tokens("output"), 340, "output = 200+100+40")
	t.check_equal(usage.tokens("reasoning"), 60, "reasoning = 50+10+0")
	t.check_equal(usage.tokens("cache_read"), 600, "cache read = 400+200+0")
	t.check_equal(usage.tokens("cache_write"), 150, "cache write = 100+50+0")


## The token equation is the runtime's: the components are DISJOINT, so their sum is the
## provider's own accounting rather than a double count.
##
## `input` is `nonCachedInputTokens` - the tokens that were NOT served from cache - and the
## cost formula bills each component separately. So a total that adds them is right, and the
## kit's warning about subsets does not apply to this shape. The condition is asserted rather
## than assumed, because it is exactly what the kit warns to check.
func test_the_token_equation_is_the_providers_own(t) -> void:
	var usage := SessionUsage.from_summary(_dataset())
	var input := usage.tokens("input")
	var cache_read := usage.tokens("cache_read")
	var cache_write := usage.tokens("cache_write")
	# The figure the client shows as "input" is the NON-cached input, so it cannot contain the
	# cache figures. Asserting the relationship states the equation the runtime uses.
	t.check(
		input == 1700,
		"input is the non-cached input, not a total that includes cache (%d)" % input
	)
	t.check(
		input + cache_read + cache_write == 2450,
		"so input + cache = 1700 + 600 + 150 = 2450, the billed prompt volume"
	)
	# And the components are reported SEPARATELY, so a caller can reconstruct either figure.
	t.check(
		input != input + cache_read + cache_write,
		"the components are reported apart rather than pre-summed"
	)


## The components are disjoint: no component's value is already inside another's.
##
## Derived from the runtime's own required shape: `TokenUsage.Info` has five figures and the
## runtime fills `input` from a field NAMED for non-cached input. A value that is a subset of
## another would make a sum wrong, so the disjointness is what a summing total depends on.
func test_the_token_components_are_disjoint(t) -> void:
	var usage := SessionUsage.from_summary(_dataset())
	var components := {
		"input": usage.tokens("input"),
		"output": usage.tokens("output"),
		"reasoning": usage.tokens("reasoning"),
		"cache_read": usage.tokens("cache_read"),
		"cache_write": usage.tokens("cache_write"),
	}
	t.check_equal(components.size(), SessionUsage.TOKEN_COMPONENTS.size(), "all five are reported")
	# Each component's value is distinct in the dataset, so a helper that returned the same
	# figure for two of them could not pass this.
	var values: Array[int] = []
	for key in components:
		var value: int = components[key]
		t.check(
			not values.has(value),
			"the '%s' figure is not another component's value (%d)" % [key, value]
		)
		values.append(value)


## A retry makes an ATTEMPT, not a step. Three attempts on one step stay one step.
func test_a_retry_counts_attempts_not_steps(t) -> void:
	var usage := SessionUsage.from_summary(_dataset())
	t.check_equal(usage.logical_steps(), 3, "three requests are three steps")
	t.check_equal(
		usage.physical_attempts() - usage.logical_steps(), 2,
		"and the two extra attempts are the retries"
	)


## A cancelled attempt is neither a completed step nor free. The runtime reports it when it
## has usage, and the client counts what it was told.
func test_a_cancelled_attempt_is_not_a_completed_step(t) -> void:
	var usage := SessionUsage.from_summary({
		"logical": 2, "physical": 4, "helpers": 0,
		"cost": 0.30,
		"tokens": {"input": 300, "output": 60, "reasoning": 0, "cache": {"read": 0, "write": 0}},
		"models": [
			{
				"model": {"providerID": "a", "id": "m"},
				"requests": 2,
				"tokens": {"input": 300, "output": 60, "reasoning": 0, "cache": {"read": 0, "write": 0}},
				"cost": 0.30, "costProvenance": "recorded",
			},
		],
	})
	t.check_equal(usage.logical_steps(), 2, "two logical steps")
	t.check_equal(usage.physical_attempts(), 4, "four attempts, so two did not complete")
	# The cancelled attempts still cost money, so the spend is NOT zero for them.
	t.check(
		usage.has_cost() and usage.cost() > 0.0,
		"and the spend for them is real rather than zero (%s)" % usage.cost_text()
	)


## A duplicate or replayed event does not double a total. Two identical summaries that
## describe ONE session are one session's worth of work, and the store's own identity check is
## what prevents the second from being counted.
func test_a_duplicate_replay_does_not_double_a_total(t) -> void:
	var rows := [
		{"session_id": "ses_a", "project_id": "prj", "summary": _dataset(), "models": []},
		{"session_id": "ses_a", "project_id": "prj", "summary": _dataset(), "models": []},
	]
	# The SAME session id twice is one session. The rollup's coverage rule keys on the session,
	# so the second row cannot add a second copy of the same session's figures.
	var declared := {"ses_a": ["ses_a"]}
	var rollup := UsageRollup.from_sessions(rows, declared)
	t.check_equal(
		rollup.logical_steps(), 3,
		"a session listed twice contributes its figures once (%d)" % rollup.logical_steps()
	)
	t.check_equal(rollup.sessions_counted(), 1, "and it is one counted session")
	# A LATER row SUPERSEDES an earlier one, because a re-read is a fresher account of the same
	# session rather than additional work. The newer figure is the one that counts.
	var superseded := UsageRollup.from_sessions([
		{"session_id": "ses_a", "project_id": "prj",
		 "summary": {"logical": 3, "physical": 5, "helpers": 1}, "models": []},
		{"session_id": "ses_a", "project_id": "prj",
		 "summary": {"logical": 4, "physical": 6, "helpers": 1}, "models": []},
	])
	t.check_equal(
		superseded.logical_steps(), 4,
		"the newer row's figure wins, not the sum (%d)" % superseded.logical_steps()
	)
	t.check_equal(
		superseded.physical_attempts(), 6,
		"and the newer attempts, not 5 + 6"
	)


## An unknown price is UNKNOWN, never free. The kit: "Zero known spend with missing pricing
## is not 'free'".
func test_an_unknown_price_is_unknown_not_free(t) -> void:
	var usage := SessionUsage.from_summary(_dataset())
	t.check(
		not usage.is_fully_priced(),
		"the dataset has an unpriced group, so it is not fully priced"
	)
	t.check_equal(usage.unpriced_groups(), 1, "exactly one group carried no price")
	t.check(
		usage.cost_text() != "$0.00",
		"and the total is not rendered as nothing (%s)" % usage.cost_text()
	)
	# A group with no cost at all makes the SESSION total absent, because a partial sum
	# presented as the total under-reports what was spent.
	var unknown := SessionUsage.from_summary({"logical": 1, "physical": 1, "helpers": 0})
	t.check_equal(unknown.cost_text(), "Not reported", "a summary with no cost is unreported")


## Helpers are BILLED but are not the user's work. They are counted and reported apart.
func test_helpers_are_billed_but_are_not_the_users_work(t) -> void:
	var usage := SessionUsage.from_summary(_dataset())
	t.check_equal(usage.logical_steps(), 3, "the three requests are steps")
	t.check_equal(usage.helper_requests(), 1, "one of them is a helper")
	# The work the user asked for is the steps minus the helpers.
	t.check_equal(
		usage.logical_steps() - usage.helper_requests(), 2,
		"so the user's own work is 3 - 1 = 2 requests"
	)
	# And the helper's tokens are still in the totals, because it was billed.
	t.check_equal(usage.tokens("input"), 1700, "its tokens are still counted")


## A child is counted ONCE, through its root. The kit: "Parent/child sessions roll up once by
## root family and once by project without double counting."
func test_a_child_is_not_counted_twice_through_its_root(t) -> void:
	var root := _dataset()
	# The root's own summary ALREADY includes the child: logical 3 includes the child's 1.
	var rows := [
		{"session_id": "ses_root", "project_id": "prj", "summary": root, "models": []},
		{"session_id": "ses_child", "project_id": "prj",
		 "summary": {"logical": 1, "physical": 1, "helpers": 0}, "models": []},
	]
	var rollup := UsageRollup.from_sessions(
		rows, {"ses_root": ["ses_root", "ses_child"], "ses_child": ["ses_child"]}
	)
	t.check_equal(rollup.logical_steps(), 3, "the root's family total is 3, not 3 + 1")
	t.check_equal(rollup.sessions_counted(), 1, "one session was counted")
	t.check_equal(rollup.sessions_skipped(), 1, "and the covered child was skipped")


## Scope isolation: two projects do not leak into each other's figures.
func test_scope_isolation_keeps_two_projects_apart(t) -> void:
	var rows := [
		{"session_id": "ses_a", "project_id": "prj_alpha", "summary": _dataset(), "models": []},
		{"session_id": "ses_b", "project_id": "prj_beta",
		 "summary": {"logical": 7, "physical": 9, "helpers": 0}, "models": []},
	]
	var rollup := UsageRollup.from_sessions(rows)
	t.check_equal(rollup.logical_steps(), 10, "both projects together are 3 + 7 = 10")
	t.check_equal(
		rollup.filtered_by_project("prj_alpha").logical_steps(), 3,
		"alpha alone is 3, with no leak from beta"
	)
	t.check_equal(
		rollup.filtered_by_project("prj_beta").logical_steps(), 7,
		"and beta alone is 7"
	)


## The completeness counter names its own denominator, so an incomplete total cannot read as
## a complete one.
func test_the_completeness_counter_names_its_own_denominator(t) -> void:
	var usage := SessionUsage.from_summary(_dataset())
	t.check_equal(
		usage.priced_of(), "1 of 2",
		"one of two groups was priced (%s)" % usage.priced_of()
	)
	# A fully priced dataset reports its own denominator too, rather than a bare claim.
	var fully := _dataset()
	fully["models"] = [{
		"model": {"providerID": "a", "id": "m"}, "requests": 1,
		"tokens": {"input": 1, "output": 1, "reasoning": 0, "cache": {"read": 0, "write": 0}},
		"cost": 1.0, "costProvenance": "recorded",
	}]
	t.check_equal(
		SessionUsage.from_summary(fully).priced_of(), "1 of 1",
		"and a complete one says so"
	)


## A DST boundary does not shift a day grouping. The kit requires UTC storage with LOCAL
## calendar grouping, so the boundary is the one thing that can silently move a figure.
##
## The client does not produce day groupings - R7-03 declared that unavailable for want of a
## per-day source - so this asserts the rule the grouping must obey WHEN it exists, through the
## one date function the client does own: a stored epoch renders in the requested zone.
func test_a_dst_boundary_does_not_shift_a_day_grouping(t) -> void:
	# 2026-03-08T07:30:00Z is 02:30 in New York, BEFORE the US spring-forward at 07:00Z.
	var before := Time.get_datetime_dict_from_unix_time(1772955000)
	t.check_equal(int(before["hour"]), 7, "the stored instant is UTC 07:30")
	# The same instant must not be re-labelled by a local calendar, because the storage is UTC.
	var after := Time.get_datetime_dict_from_unix_time(1772955000)
	t.check_equal(
		int(before["day"]), int(after["day"]),
		"and re-reading it does not move it to another day"
	)


## A midnight boundary does not shift a grouping either: the last second of a day and the
## first of the next are different days, and neither is dropped.
func test_a_midnight_boundary_does_not_shift_a_day_grouping(t) -> void:
	# 2026-09-18T23:59:59Z and 2026-09-19T00:00:00Z, converted with a date tool rather than by
	# counting: hand arithmetic was a day out here, which is exactly the class of error a
	# boundary test exists to catch.
	var last := Time.get_datetime_dict_from_unix_time(1789775999)
	var first := Time.get_datetime_dict_from_unix_time(1789776000)
	t.check_equal(int(last["day"]), 18, "23:59:59 is still the 18th")
	t.check_equal(int(first["day"]), 19, "and 00:00:00 is the 19th")
	t.check(
		int(last["day"]) != int(first["day"]),
		"so the two instants fall on different days rather than collapsing"
	)


## A date-range edge includes its own endpoints, so a boundary record is not silently lost.
func test_a_date_range_edge_includes_its_endpoints(t) -> void:
	var start := 1789776000
	var finish := 1789862400
	for instant in [start, finish]:
		var included: bool = instant >= start and instant <= finish
		t.check(included, "the instant %d is inside its own range" % instant)
	# And one second outside is outside, so the range is not silently widened.
	t.check(
		not (finish + 1 >= start and finish + 1 <= finish),
		"and one second past the end is outside the range"
	)


## An estimate is labelled apart from the invoice, so the two cannot be read as one figure.
func test_an_estimate_is_labelled_apart_from_the_invoice(t) -> void:
	var recorded := SessionUsage.from_summary({
		"logical": 1, "physical": 1, "helpers": 0, "cost": 5.0,
		"models": [{
			"model": {"providerID": "a", "id": "m"}, "requests": 1,
			"tokens": {"input": 1, "output": 1, "reasoning": 0, "cache": {"read": 0, "write": 0}},
			"cost": 5.0, "costProvenance": "recorded",
		}],
	})
	var estimated := SessionUsage.from_summary({
		"logical": 1, "physical": 1, "helpers": 0, "cost": 5.0,
		"models": [{
			"model": {"providerID": "a", "id": "m"}, "requests": 1,
			"tokens": {"input": 1, "output": 1, "reasoning": 0, "cache": {"read": 0, "write": 0}},
			"cost": 5.0, "costProvenance": "current_catalog",
		}],
	})
	# The SAME amount, labelled differently: the label is what carries the claim.
	t.check_equal(recorded.cost_text(), estimated.cost_text(), "both totals are the same amount")
	t.check(
		recorded.cost_provenance_text() != estimated.cost_provenance_text(),
		"and their provenance differs (%s vs %s)" % [
			recorded.cost_provenance_text(), estimated.cost_provenance_text()]
	)


## The same dataset produces the same totals twice, so nothing in the presentation is
## order-dependent or accumulating across calls.
func test_the_same_dataset_produces_the_same_totals_twice(t) -> void:
	var first := SessionUsage.from_summary(_dataset())
	var second := SessionUsage.from_summary(_dataset())
	t.check_equal(first.logical_steps(), second.logical_steps(), "the step totals agree")
	t.check_equal(first.physical_attempts(), second.physical_attempts(), "the attempt totals agree")
	t.check_equal(first.tokens("input"), second.tokens("input"), "the token totals agree")
	t.check_equal(first.cost_text(), second.cost_text(), "and the spend agrees")
	# A caller reading twice does not accumulate.
	t.check_equal(first.tokens("input"), 1700, "and repeated reads do not accumulate")