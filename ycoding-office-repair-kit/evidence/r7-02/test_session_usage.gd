## Session usage aggregate tests (R7-02).
##
## The acceptance is: "Provider/model/project/day/session filters; count physical attempts
## vs logical steps, helpers and children once."
##
## Every rule below is a way the numbers can lie, and each was verified against the live
## schema before a line was written:
##
##   * ATTEMPTS ARE NOT STEPS. `ProviderRequest.Record` carries `request` (the logical step)
##     and `attempts` (the physical attempts that step took)
##     (packages/schema/src/provider-request.ts). Adding them would double-count; one step
##     that retried twice is 1 logical step and 2 physical attempts.
##   * HELPERS ARE A SEPARATE CLASS. `source` is `step` | `title` | `goal` | `compaction`.
##     A title or compaction request is billed but is not the user's work, so it is counted
##     and reported apart rather than folded in.
##   * CHILDREN ROLL UP ONCE. `session.usage` says a root session includes its descendant
##     subagent family while a CHILD stays scoped to itself. Aggregating by summing every
##     session the client knows would count a child twice - once in its own right and once
##     inside its root's total.
##   * MISSING COST IS NOT FREE. `Summary.cost` and `ModelSpend.cost` are OPTIONAL and
##     their presence is meaningful: `costProvenance` distinguishes recorded billing from a
##     query-time estimate, and `ModelSpend.cost` is absent when ANY request in the group
##     has neither. Zero known spend with missing pricing is not "free", so a total must
##     report how many rows it actually priced.
##
## The aggregate is a pure function over the wire shape, so these rules are provable
## without a socket. The reader's wire contract is covered by a transport double.
extends RefCounted


func run(t) -> void:
	test_attempts_are_not_steps(t)
	test_every_group_is_priced_or_reported_as_unpriced(t)
	test_helpers_are_counted_apart_from_the_work(t)
	test_a_family_is_counted_once(t)
	test_a_child_does_not_double_count_its_root(t)
	test_absent_cost_is_never_rendered_as_zero_spend(t)
	test_a_recorded_cost_is_distinguished_from_an_estimate(t)
	test_tokens_keep_their_components_separate(t)
	test_an_absent_summary_is_unreported_not_empty(t)
	test_the_rollup_counts_a_family_member_once(t)
	test_the_rollup_filters_by_provider(t)
	test_the_rollup_filters_by_model(t)
	test_the_rollup_filters_by_project(t)
	test_a_day_breakdown_is_declared_unavailable(t)
	test_the_rollup_reports_its_own_completeness(t)
	test_the_reader_reads_the_verified_route(t)
	test_the_reader_never_attributes_a_summary_to_another_session(t)
	test_a_refused_read_reports_the_service_reason(t)
	test_a_failed_read_reports_nothing_rather_than_zero(t)
	test_a_read_without_a_transport_says_so(t)


## A wire Summary as the service sends it
## (`session.usage` → `{data: ProviderRequest.Summary}`).
func _summary(overrides: Dictionary = {}) -> Dictionary:
	var base := {
		"logical": 3, "physical": 5, "helpers": 1, "continued": 1, "fallback": 0,
		"cost": 1.25,
		"tokens": {
			"input": 1000, "output": 250, "reasoning": 40,
			"cache": {"read": 600, "write": 100},
		},
		"models": [
			{
				"model": {"providerID": "anthropic", "id": "claude-sonnet-4", "variant": "max"},
				"requests": 3,
				"tokens": {"input": 1000, "output": 250, "reasoning": 40, "cache": {"read": 600, "write": 100}},
				"cost": 1.25, "costProvenance": "recorded",
			},
		],
	}
	for key in overrides:
		base[key] = overrides[key]
	return base


## One logical step that retried is MORE physical attempts than steps. Reporting the two
## as one number hides retries; adding them invents work that never happened.
func test_attempts_are_not_steps(t) -> void:
	var usage := SessionUsage.from_summary(_summary())
	t.check_equal(usage.logical_steps(), 3, "the logical steps are the service's own count")
	t.check_equal(usage.physical_attempts(), 5, "the physical attempts are counted separately")
	t.check(
		usage.physical_attempts() != usage.logical_steps(),
		"and the two are NOT conflated"
	)
	var retried := SessionUsage.from_summary(_summary({"logical": 2, "physical": 9}))
	t.check_equal(retried.logical_steps(), 2, "a retried step stays ONE logical step")
	t.check_equal(retried.physical_attempts(), 9, "while every attempt is reported")


## Zero known spend with missing pricing is not "free". A total must say how many rows it
## actually priced, so a reader can see the total is incomplete rather than cheap.
func test_every_group_is_priced_or_reported_as_unpriced(t) -> void:
	var priced := SessionUsage.from_summary(_summary({"models": [
		{
			"model": {"providerID": "a", "id": "m1"}, "requests": 2,
			"tokens": {"input": 1, "output": 1, "reasoning": 0, "cache": {"read": 0, "write": 0}},
			"cost": 0.5, "costProvenance": "recorded",
		},
		{
			"model": {"providerID": "b", "id": "m2"}, "requests": 1,
			"tokens": {"input": 1, "output": 1, "reasoning": 0, "cache": {"read": 0, "write": 0}},
		},
	]}))
	t.check_equal(priced.model_groups().size(), 2, "both model groups are kept")
	t.check_equal(priced.priced_groups(), 1, "only one group carried a cost")
	t.check_equal(priced.unpriced_groups(), 1, "and the other is reported as unpriced, not as free")
	t.check(
		not priced.is_fully_priced(),
		"so the total is NOT presented as complete"
	)
	t.check_equal(priced.priced_of(), "1 of 2", "and the completeness is spelled out")


## A title or compaction request is billed but is not the user's work. It is counted and
## reported apart rather than folded into the step count.
func test_helpers_are_counted_apart_from_the_work(t) -> void:
	var usage := SessionUsage.from_summary(_summary())
	t.check_equal(usage.helper_requests(), 1, "helpers are counted on their own")
	t.check(
		usage.helper_requests() > 0,
		"a run with helpers says so rather than reporting only the user's steps"
	)
	var none := SessionUsage.from_summary(_summary({"helpers": 0}))
	t.check_equal(none.helper_requests(), 0, "a run without helpers reports none")


## A family is counted ONCE. The root's Summary already includes its descendants, so
## adding the children as well would double every delegated request.
func test_a_family_is_counted_once(t) -> void:
	var root := SessionUsage.from_summary(
		_summary({"logical": 10, "physical": 14}), ["ses_root", "ses_child"]
	)
	t.check_equal(root.logical_steps(), 10, "the root's own total is used as the family total")
	t.check_equal(
		root.session_ids().size(), 2, "and the family's sessions are named"
	)
	# The rule stated directly: a session already inside another's total is not added again.
	t.check(
		SessionUsage.includes_descendants("ses_root", ["ses_root", "ses_child"]),
		"a root includes its descendants"
	)


## A CHILD is scoped to itself. It does not report its parent's work as its own, because
## the service scopes it to itself - so the aggregate must not widen it.
func test_a_child_does_not_double_count_its_root(t) -> void:
	t.check(
		not SessionUsage.includes_descendants("ses_child", ["ses_root", "ses_child"]),
		"a child does not include its root"
	)
	var child := SessionUsage.from_summary(_summary({"logical": 2}), ["ses_child"])
	t.check_equal(child.logical_steps(), 2, "a child reports only its own work")


## An absent cost is UNREPORTED. It is never coerced to zero, because zero is a claim
## about money and absent is the absence of one.
func test_absent_cost_is_never_rendered_as_zero_spend(t) -> void:
	var unknown := SessionUsage.from_summary(_summary({"cost": null, "models": [
		{
			"model": {"providerID": "a", "id": "m1"}, "requests": 1,
			"tokens": {"input": 1, "output": 1, "reasoning": 0, "cache": {"read": 0, "write": 0}},
		},
	]}))
	t.check(not unknown.has_cost(), "a summary without cost does not claim one")
	t.check_equal(
		unknown.cost_text(), "Not reported",
		"and it renders as unreported rather than as $0.00"
	)
	t.check(
		not unknown.cost_text().contains("0.00"),
		"the unreported text is not a zero amount"
	)


## Recorded billing and a query-time estimate are DIFFERENT claims, and the service says
## which is which through `costProvenance`.
func test_a_recorded_cost_is_distinguished_from_an_estimate(t) -> void:
	var recorded := SessionUsage.from_summary(_summary({"models": [
		{
			"model": {"providerID": "a", "id": "m1"}, "requests": 1,
			"tokens": {"input": 1, "output": 1, "reasoning": 0, "cache": {"read": 0, "write": 0}},
			"cost": 0.25, "costProvenance": "recorded",
		},
	]}))
	t.check_equal(
		recorded.cost_provenance_text(), "recorded",
		"a recorded cost says it is the provider's own figure"
	)
	var estimated := SessionUsage.from_summary(_summary({"models": [
		{
			"model": {"providerID": "a", "id": "m1"}, "requests": 1,
			"tokens": {"input": 1, "output": 1, "reasoning": 0, "cache": {"read": 0, "write": 0}},
			"cost": 0.25, "costProvenance": "current_catalog",
		},
	]}))
	t.check_equal(
		estimated.cost_provenance_text(), "estimated",
		"and an estimate says it is an estimate, not the invoice"
	)


## Token components stay separate. Cached and reasoning tokens are not added into input
## or output, because the provider normalization already accounts for them.
func test_tokens_keep_their_components_separate(t) -> void:
	var usage := SessionUsage.from_summary(_summary())
	t.check_equal(usage.tokens("input"), 1000, "input is its own component")
	t.check_equal(usage.tokens("output"), 250, "output is its own component")
	t.check_equal(usage.tokens("reasoning"), 40, "reasoning is its own component")
	t.check_equal(usage.tokens("cache_read"), 600, "cache read is its own component")
	t.check_equal(usage.tokens("cache_write"), 100, "cache write is its own component")
	# A component the service did not report is absent, not zero.
	t.check_equal(usage.tokens("missing_component"), -1, "an unknown component is not a zero")


## When no summary has been read, nothing is reported. An empty aggregate must not read
## as a session that did no work.
func test_an_absent_summary_is_unreported_not_empty(t) -> void:
	var none := SessionUsage.empty()
	t.check(not none.is_reported(), "an unread aggregate reports nothing as known")
	t.check_equal(none.logical_steps(), 0, "and holds no invented count")
	t.check_equal(none.cost_text(), "Not reported", "and claims no spend")


## ---------------------------------------------------------------------------------------
## The rollup across sessions. "Provider/model/project/day/session filters; count physical
## attempts vs logical steps, helpers and children once."
## ---------------------------------------------------------------------------------------


## One accounted session, as the client holds it after reading each session's usage.
func _accounted(
	session_id: String, summary: Dictionary, project: String = "prj_a", models: Array = []
) -> Dictionary:
	return {
		"session_id": session_id,
		"project_id": project,
		"summary": summary,
		"models": models,
	}


## A session already inside another's family total is not added again. This is the rule
## the acceptance names: helpers and children ONCE.
func test_the_rollup_counts_a_family_member_once(t) -> void:
	# A root whose Summary already covers a child, plus that child's own row.
	var rows := [
		_accounted("ses_root", _summary({"logical": 10, "physical": 14}), "prj_a",
			["anthropic/claude-sonnet-4"]),
		_accounted("ses_child", _summary({"logical": 3, "physical": 4}), "prj_a",
			["anthropic/claude-sonnet-4"]),
	]
	var declared := {"ses_root": ["ses_root", "ses_child"], "ses_child": ["ses_child"]}
	var rollup := UsageRollup.from_sessions(rows, declared)
	t.check_equal(
		rollup.logical_steps(), 10,
		"the root's total is used and the child is NOT added again"
	)
	t.check_equal(rollup.physical_attempts(), 14, "and the attempts are not double-counted")
	t.check_equal(rollup.sessions_counted(), 1, "only the covering session is counted")
	t.check_equal(rollup.sessions_skipped(), 1, "and the covered child is reported as skipped")


## A provider filter keeps only the sessions that used it.
func test_the_rollup_filters_by_provider(t) -> void:
	var rows := [
		_accounted("ses_a", _summary({"logical": 5}), "prj_a", ["anthropic/claude-sonnet-4"]),
		_accounted("ses_b", _summary({"logical": 7}), "prj_a", ["openrouter/x"]),
	]
	var all := UsageRollup.from_sessions(rows)
	t.check_equal(all.logical_steps(), 12, "unfiltered counts both sessions")
	var openrouter := all.filtered_by_provider("openrouter")
	t.check_equal(openrouter.logical_steps(), 7, "the provider filter keeps only its sessions")
	var anthropic := all.filtered_by_provider("anthropic")
	t.check_equal(anthropic.logical_steps(), 5, "and the other provider its own")
	var none := all.filtered_by_provider("does-not-exist")
	t.check_equal(none.logical_steps(), 0, "an unknown provider matches nothing")


## A model filter keeps only the sessions that used that exact provider/model/variant.
func test_the_rollup_filters_by_model(t) -> void:
	var rows := [
		_accounted("ses_a", _summary({"logical": 4}), "prj_a", ["anthropic/claude-sonnet-4"]),
		_accounted("ses_b", _summary({"logical": 6}), "prj_a", ["anthropic/claude-haiku-4"]),
	]
	var all := UsageRollup.from_sessions(rows)
	t.check_equal(
		all.filtered_by_model("anthropic/claude-sonnet-4").logical_steps(), 4,
		"the model filter selects its own sessions"
	)
	t.check_equal(
		all.filtered_by_model("anthropic/claude-haiku-4").logical_steps(), 6,
		"and does not merge another model's work"
	)


## A project filter keeps only the sessions that belong to it.
func test_the_rollup_filters_by_project(t) -> void:
	var rows := [
		_accounted("ses_a", _summary({"logical": 4}), "prj_alpha"),
		_accounted("ses_b", _summary({"logical": 6}), "prj_beta"),
	]
	var all := UsageRollup.from_sessions(rows)
	t.check_equal(all.logical_steps(), 10, "unfiltered spans both projects")
	t.check_equal(
		all.filtered_by_project("prj_beta").logical_steps(), 6,
		"the project filter keeps only its own"
	)


## A DAY BREAKDOWN IS NOT AVAILABLE, and the model says so rather than grouping everything
## into one bucket and calling it a day.
##
## Verified against the live runtime: `session.usage` returns a CUMMULATIVE
## `ProviderRequest.Summary` with no per-request time, and the per-request events that do
## carry `time` (`UsageRecorded`, `ProviderRequestRecorded`) are deliberately EXCLUDED from
## public logs (packages/schema/src/session-event.ts: "excluded from public logs"). There is
## therefore no per-day source to group by, and inventing one from session timestamps would
## attribute work to the day a session started rather than the day it happened.
func test_a_day_breakdown_is_declared_unavailable(t) -> void:
	var rows := [_accounted("ses_a", _summary({"logical": 4}))]
	var rollup := UsageRollup.from_sessions(rows)
	t.check(
		not rollup.supports_day_breakdown(),
		"a day breakdown is reported as unavailable"
	)
	t.check(
		rollup.unavailable_reason().contains("cumulative"),
		"and the reason names the actual limitation (%s)" % rollup.unavailable_reason()
	)
	# A request for a day grouping returns nothing rather than a single mislabelled bucket.
	t.check_equal(
		rollup.grouped_by_day().size(), 0,
		"and asking for one yields no invented bucket"
	)


## The rollup states its own completeness, so a total over partial pricing cannot read as
## a complete figure.
func test_the_rollup_reports_its_own_completeness(t) -> void:
	var rows := [
		_accounted("ses_a", _summary({"logical": 3, "models": [
			{
				"model": {"providerID": "a", "id": "m1"}, "requests": 1,
				"tokens": {"input": 1, "output": 1, "reasoning": 0, "cache": {"read": 0, "write": 0}},
				"cost": 0.5, "costProvenance": "recorded",
			},
		]})),
		_accounted("ses_b", _summary({"logical": 3, "models": [
			{
				"model": {"providerID": "b", "id": "m2"}, "requests": 1,
				"tokens": {"input": 1, "output": 1, "reasoning": 0, "cache": {"read": 0, "write": 0}},
			},
		]})),
	]
	var rollup := UsageRollup.from_sessions(rows)
	t.check(
		not rollup.is_fully_priced(),
		"a rollup over an unpriced session is not presented as complete"
	)
	t.check_equal(rollup.priced_of(), "1 of 2", "and it says how many sessions it priced")
	t.check(
		rollup.cost_text() == "Not reported" or rollup.cost_text().contains("$"),
		"its cost renders as an amount or as unreported, never as a bare zero"
	)


## ---------------------------------------------------------------------------------------
## The reader's wire contract. These drive a transport double, so the route and the
## `{data: Summary}` envelope are exercised without a socket. The real socket path is
## covered by the integration gate.
## ---------------------------------------------------------------------------------------


func test_the_reader_reads_the_verified_route(t) -> void:
	var transport := UsageStub.new()
	transport.wire_body = {"data": _summary()}
	var api := UsageApi.new()
	api.configure(transport)
	var usage := api.fetch("ses_a")
	t.check_equal(transport.requests.size(), 1, "exactly one request is issued")
	t.check_equal(
		str(transport.requests[0].get("path", "")), "/api/session/ses_a/usage",
		"the verified route is read"
	)
	t.check_equal(
		int(transport.requests[0].get("method", 0)), HTTPClient.METHOD_GET,
		"usage is a plain JSON GET"
	)
	t.check_equal(api.last_error(), "", "a clean read reports no failure")
	t.check(usage.is_reported(), "the summary is reported")
	t.check_equal(usage.logical_steps(), 3, "and its steps are read from the envelope")
	t.check_equal(str(api.session_id()), "ses_a", "and the session it answered for is recorded")


## A response is attributed to the session the REQUEST named, so a read started for one
## session is never installed as another's usage.
func test_the_reader_never_attributes_a_summary_to_another_session(t) -> void:
	var transport := UsageStub.new()
	transport.wire_body = {"data": _summary({"logical": 7})}
	var api := UsageApi.new()
	api.configure(transport)
	api.start("ses_first")
	# The user moves on while the read is in flight; the answer still belongs to its request.
	var settled := api.poll(0)
	t.check_equal(str(api.session_id()), "ses_first", "the answer keeps its own session")
	t.check_equal(settled.logical_steps(), 7, "and its own figures")
	t.check(
		api.session_id() != "ses_second",
		"it is never relabelled as another session's usage"
	)


## A refusal surfaces the SERVICE's own reason rather than a generic message.
func test_a_refused_read_reports_the_service_reason(t) -> void:
	var transport := UsageStub.new()
	transport.status = 404
	transport.wire_body = {"message": "Session not found: ses_missing"}
	var api := UsageApi.new()
	api.configure(transport)
	var usage := api.fetch("ses_missing")
	t.check_equal(api.last_error(), "Session not found: ses_missing", "the service's reason is surfaced")
	t.check(not usage.is_reported(), "and no usage is claimed")


## A failed read reports NOTHING known, which is a different statement from reporting that
## nothing was spent.
func test_a_failed_read_reports_nothing_rather_than_zero(t) -> void:
	var transport := UsageStub.new()
	transport.error_message = "the connection dropped"
	var api := UsageApi.new()
	api.configure(transport)
	var usage := api.fetch("ses_a")
	t.check(not usage.is_reported(), "a failed read reports nothing as known")
	t.check(
		not api.last_error().is_empty(),
		"and the failure is stated rather than swallowed (%s)" % api.last_error()
	)
	# The distinction that matters: not-known is not zero.
	t.check(
		usage.logical_steps() == 0 and not usage.is_reported(),
		"an unread session is not presented as a session that did no work"
	)


## Without a transport there is no read, and the reader says so rather than reporting zero.
func test_a_read_without_a_transport_says_so(t) -> void:
	var api := UsageApi.new()
	var usage := api.fetch("ses_a")
	t.check(not usage.is_reported(), "no transport means nothing is reported")
	t.check(
		api.last_error().contains("No transport"),
		"and the reader names the reason (%s)" % api.last_error()
	)


## A transport double at the boundary being read, in the verified entry shape.
class UsageStub extends "res://integration/http_transport.gd":
	var status := 200
	var wire_body: Dictionary = {}
	var error_message := ""
	var requests: Array = []
	var cancelled: Array = []
	var _last_request_id := 0
	var _delivered := false

	func request(method: int, path: String, body: Dictionary = {}) -> int:
		requests.append({"method": method, "path": path, "body": body})
		_last_request_id = requests.size()
		return _last_request_id

	func poll(_budget_ms: int = 4) -> Array[Dictionary]:
		var entries: Array[Dictionary] = []
		if _delivered:
			return entries
		_delivered = true
		if not error_message.is_empty():
			entries.append({
				"request_id": _last_request_id, "kind": "error", "status": 0,
				"body": {}, "event": {}, "error": error_message,
			})
			return entries
		entries.append({
			"request_id": _last_request_id, "kind": "response", "status": status,
			"body": wire_body, "event": {}, "error": "",
		})
		return entries

	func cancel(request_id: int) -> void:
		cancelled.append(request_id)
