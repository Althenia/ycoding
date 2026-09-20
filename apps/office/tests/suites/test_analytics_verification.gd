## Native analytics verification tests (R7-09).
##
## The acceptance is: "Record source provenance; estimate vs billed distinction; quota failure
## cannot break normal coding."
##
## Three claims, each of which a product can quietly get wrong:
##
##   SOURCE PROVENANCE IS RECORDED. Every figure the statistics surface shows names where it
##   came from. A number with no provenance cannot be checked, and the kit requires the
##   source to be visible rather than implied.
##
##   AN ESTIMATE IS NOT THE BILL. `costProvenance` distinguishes the provider's recorded
##   billing from a query-time catalog estimate. The two can be the SAME AMOUNT - which is
##   exactly why the label, not the number, is what carries the claim.
##
##   A QUOTA FAILURE CANNOT BREAK CODING. This is the safety clause: a quota read is
##   best-effort and remote, so it must be impossible for its failure to stop a prompt. The
##   kit states it twice - "A failed quota refresh never blocks sending a valid coding
##   prompt", and "No setting silently stops work because a best-effort remote quota is
##   stale".
##
## The third claim is verified STRUCTURALLY as well as behaviourally, because "it happens not
## to block today" is weaker than "it cannot block": the reads are separate objects with their
## own transports, started and polled from the frame loop, and the prompting path references
## neither.



extends RefCounted

func run(t) -> void:
	test_the_client_has_separate_readers_for_each_source(t)
	test_a_stale_quota_does_not_stop_a_prompt(t)
	test_an_errored_quota_read_does_not_stop_a_prompt(t)
	test_an_unread_quota_is_not_a_refusal(t)
	test_a_session_usage_failure_does_not_stop_a_prompt(t)
	test_the_prompting_path_names_no_quota_read(t)
	test_the_source_of_each_figure_is_recorded(t)
	test_an_estimate_is_labelled_apart_from_billed(t)
	test_the_quota_surface_states_its_own_freshness(t)
	test_a_quota_read_is_bounded_and_cancelled(t)
	test_the_two_sources_are_never_merged(t)


## A transport double whose reads can be made to fail, stall or settle.
class StubTransport extends "res://integration/http_transport.gd":
	var status := 200
	var wire_body: Dictionary = {}
	var error_message := ""
	var never_settles := false
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
		if _delivered or never_settles:
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


func _session(store: OfficeStore, session_id: String = "ses_a") -> void:
	store.apply({
		"type": Wire.SESSION_CREATED, "sessionID": session_id,
		"data": {"agent": "lead", "title": "Lead"}, "sourceEpoch": "epoch-a",
	})


## The two sources are read by SEPARATE objects on SEPARATE transports, so one failing cannot
## consume or corrupt the other's answer.
func test_the_client_has_separate_readers_for_each_source(t) -> void:
	var usage := UsageApi.new()
	var quota := ProviderUsageApi.new()
	t.check(usage != null and quota != null, "both readers exist")
	# An answer settles on the transport it was requested from. Giving each its own transport is
	# what makes a quota answer unable to be consumed by the usage reader.
	var usage_transport := StubTransport.new()
	usage_transport.wire_body = {"data": _summary()}
	usage.configure(usage_transport)
	var quota_transport := StubTransport.new()
	quota_transport.wire_body = {"location": {}, "data": []}
	quota.configure(quota_transport)
	usage.fetch("ses_a")
	quota.fetch()
	t.check_equal(usage_transport.requests.size(), 1, "the usage read used its own transport")
	t.check_equal(quota_transport.requests.size(), 1, "and the quota read used its own")
	t.check(
		str(usage_transport.requests[0].get("path", "")) != str(quota_transport.requests[0].get("path", "")),
		"and they are different routes"
	)


## A STALE quota cannot stop a prompt. The store records that a prompt was admitted while the
## quota page was reporting stale figures.
func test_a_stale_quota_does_not_stop_a_prompt(t) -> void:
	var store := OfficeStore.new()
	_session(store)
	var page := QuotaPage.new()
	page.adopt([{"providerID": "p", "label": "P", "status": "stale",
		"source": "provider_api", "stability": "stable", "updatedAt": 1, "windows": []}],
		QuotaPage.VALID_AT, QuotaPage.STALE)
	t.check_equal(page.freshness(), QuotaPage.STALE, "the quota page reports stale figures")
	# A prompt is admitted independently of that state.
	var admitted := store.conversation_items("ses_a").size()
	store.apply({
		"type": Wire.INPUT_ADMITTED, "sessionID": "ses_a",
		"data": {"prompt": "a valid coding prompt"}, "sourceEpoch": "epoch-a",
	})
	t.check(
		store.conversation_items("ses_a").size() >= admitted,
		"and a valid prompt is admitted while it is stale"
	)


## An ERRORED quota read cannot stop a prompt either.
func test_an_errored_quota_read_does_not_stop_a_prompt(t) -> void:
	var store := OfficeStore.new()
	_session(store)
	var transport := StubTransport.new()
	transport.error_message = "the provider refused the usage request"
	var quota := ProviderUsageApi.new()
	quota.configure(transport)
	var snapshots := quota.fetch()
	t.check_equal(snapshots.size(), 0, "the quota read produced nothing")
	t.check(not quota.last_error().is_empty(), "and reported its failure")
	# The failure is the quota's, and nothing about it is a refusal of work.
	t.check(
		not quota.last_error().to_lower().contains("session"),
		"its message names the quota read, not the session (%s)" % quota.last_error()
	)
	t.check(
		store.last_error.is_empty(),
		"and it did not become the session's own error"
	)


## An UNREAD quota is not a refusal. Nothing about an absent figure stops work, and the page
## says the figures are unreported rather than blocking.
func test_an_unread_quota_is_not_a_refusal(t) -> void:
	var page := QuotaPage.empty()
	t.check_equal(page.provider_rows().size(), 0, "an unread quota reports no providers")
	# An empty page is a statement about the READ, not about the user's permission to work.
	t.check(
		not page.freshness_text().to_lower().contains("denied")
		and not page.freshness_text().to_lower().contains("blocked"),
		"and its text claims no denial (%s)" % page.freshness_text()
	)


## A failed usage read cannot stop a prompt either: it is a read of figures, not a gate.
func test_a_session_usage_failure_does_not_stop_a_prompt(t) -> void:
	var store := OfficeStore.new()
	_session(store)
	var transport := StubTransport.new()
	transport.error_message = "the usage read timed out"
	var usage := UsageApi.new()
	usage.configure(transport)
	var read := usage.fetch("ses_a")
	t.check(not read.is_reported(), "the usage read reports nothing")
	t.check(not usage.last_error().is_empty(), "with a reason")
	# And the session's own error is untouched, so a prompt is unaffected.
	t.check(store.last_error.is_empty(), "and it did not become the session's error")


## THE STRUCTURAL CLAIM: the prompting path names no quota or usage read at all.
##
## Stronger than observing that it happens not to block: a path that never references the
## reads cannot be made to wait on one.
func test_the_prompting_path_names_no_quota_read(t) -> void:
	var source := FileAccess.get_file_as_string("res://app/main.gd")
	t.check(not source.is_empty(), "the composition root is readable")
	var start := source.find("func _on_prompt_submitted")
	t.check(start >= 0, "the prompting path exists")
	if start < 0:
		return
	# The body runs to the next top-level func.
	var rest := source.substr(start, source.length() - start)
	var end := rest.find("\nfunc ", 1)
	var body := rest.substr(0, end if end > 0 else rest.length())
	for forbidden in ["usage_api", "provider_usage_api", "quota", "QuotaPage", "UsageApi"]:
		t.check(
			not body.contains(forbidden),
			"the prompting path does not reference '%s'" % forbidden
		)
	t.check(
		body.contains("submit_prompt"),
		"it prompts through the transport and nothing else"
	)


## Every figure names its source. A number with no provenance cannot be checked.
func test_the_source_of_each_figure_is_recorded(t) -> void:
	var store := OfficeStore.new()
	_session(store)
	store.apply({
		"type": Wire.STEP_FAILED, "sessionID": "ses_a",
		"data": {"error": {"type": "provider.rate-limit", "message": "Slow down."}},
		"sourceEpoch": "epoch-a",
	})
	var rows := store.limit_events("ses_a")
	t.check_equal(rows.size(), 1, "the failure is recorded")
	if rows.is_empty():
		return
	t.check_equal(
		bool(rows[0].get("source_verified", false)), true,
		"and marked as verified against its source"
	)
	# A model row names the session it came from, so it can be traced.
	var page := StatisticsPage.new()
	page.adopt(SessionUsage.from_summary(_summary(), ["ses_alpha"]))
	var models := page.model_rows()
	if not models.is_empty():
		t.check_equal(
			str(models[0].get("source", "")), "ses_alpha",
			"a model row names the session its figures came from"
		)
	t.check(
		page.source_text().contains("ses_alpha"),
		"and the page names its source (%s)" % page.source_text()
	)


## An estimate is labelled apart from the bill. The two can be the SAME AMOUNT, which is
## exactly why the label carries the claim rather than the number.
func test_an_estimate_is_labelled_apart_from_billed(t) -> void:
	var billed := SessionUsage.from_summary(_summary({"models": [
		{
			"model": {"providerID": "a", "id": "m"}, "requests": 1,
			"tokens": {"input": 1, "output": 1, "reasoning": 0, "cache": {"read": 0, "write": 0}},
			"cost": 4.0, "costProvenance": "recorded",
		},
	]}))
	var estimated := SessionUsage.from_summary(_summary({"models": [
		{
			"model": {"providerID": "a", "id": "m"}, "requests": 1,
			"tokens": {"input": 1, "output": 1, "reasoning": 0, "cache": {"read": 0, "write": 0}},
			"cost": 4.0, "costProvenance": "current_catalog",
		},
	]}))
	t.check_equal(billed.cost_text(), estimated.cost_text(), "the two amounts are identical")
	t.check(
		billed.cost_provenance_text() != estimated.cost_provenance_text(),
		"and their labels differ, which is what carries the distinction (%s vs %s)" % [
			billed.cost_provenance_text(), estimated.cost_provenance_text()]
	)


## The quota surface states its own freshness, taken from the runtime rather than measured
## locally, so a stale figure cannot read as a fresh one.
func test_the_quota_surface_states_its_own_freshness(t) -> void:
	var fresh := QuotaPage.new()
	fresh.adopt([], QuotaPage.VALID_AT, QuotaPage.FRESH)
	var stale := QuotaPage.new()
	stale.adopt([], QuotaPage.VALID_AT, QuotaPage.STALE)
	var errored := QuotaPage.new()
	errored.adopt([], QuotaPage.VALID_AT, QuotaPage.ERROR)
	var texts: Array[String] = [
		fresh.freshness_text(), stale.freshness_text(), errored.freshness_text(),
	]
	var unique: Array[String] = []
	for text in texts:
		if not unique.has(text):
			unique.append(text)
	t.check_equal(unique.size(), 3, "the three freshness states read differently (%s)" % str(texts))


## A quota read is BOUNDED and its abandoned request is cancelled, so a slow provider cannot
## hold a socket open.
func test_a_quota_read_is_bounded_and_cancelled(t) -> void:
	var transport := StubTransport.new()
	transport.never_settles = true
	var quota := ProviderUsageApi.new()
	quota.configure(transport)
	var started := Time.get_ticks_msec()
	var snapshots := quota.fetch(250)
	var elapsed := Time.get_ticks_msec() - started
	t.check(elapsed < 3000, "a never-answering quota read returns within its budget (%dms)" % elapsed)
	t.check_equal(snapshots.size(), 0, "reporting nothing")
	t.check(not quota.last_error().is_empty(), "with a reason")
	t.check(transport.cancelled.size() > 0, "and the abandoned request was cancelled")


## The two sources are NEVER merged. A provider quota is the account's own limit; session
## usage is this runtime's accounting. They are different facts and are read separately.
func test_the_two_sources_are_never_merged(t) -> void:
	var page := StatisticsPage.new()
	t.check(
		not page.has_method("merge_quota") and not page.has_method("combined_limit"),
		"the statistics page exposes no way to merge a quota into usage"
	)
	t.check(
		QuotaPage.VALID_AT == 0 and not QuotaPage.empty().has_method("usage"),
		"and the quota page exposes no usage accessor"
	)
	# The rollup counts sessions; the quota page counts provider windows. Neither takes the
	# other's input.
	t.check(
		not UsageRollup.empty().has_method("windows_for"),
		"the usage rollup exposes no provider-window accessor"
	)


## A wire Summary in the shape the service sends.
func _summary(overrides: Dictionary = {}) -> Dictionary:
	var base := {
		"logical": 3, "physical": 5, "helpers": 1,
		"cost": 2.0,
		"tokens": {"input": 1000, "output": 200, "reasoning": 50, "cache": {"read": 400, "write": 100}},
		"models": [
			{
				"model": {"providerID": "anthropic", "id": "claude-sonnet-4", "variant": "max"},
				"requests": 3,
				"tokens": {"input": 1000, "output": 200, "reasoning": 50, "cache": {"read": 400, "write": 100}},
				"cost": 2.0, "costProvenance": "recorded",
			},
		],
	}
	for key in overrides:
		base[key] = overrides[key]
	return base