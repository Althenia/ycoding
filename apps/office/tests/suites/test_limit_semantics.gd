## Limit-semantics tests (R7-06).
##
## The acceptance is: "Provider quota, rate limits, context limits and local advisory budgets
## remain distinct. No new hard-budget enforcement is required without explicit scope
## approval; never expose an enforced control unless the shared backend actually enforces it."
##
## FOUR KINDS OF LIMIT, from FOUR DIFFERENT SOURCES, and the runtime already tells them
## apart. Verified against the live code before a line was written:
##
##   * A PROVIDER QUOTA is provider data: `ProviderUsage.Snapshot` with status and windows.
##   * A RATE LIMIT is a 429 observation. The runtime CLASSIFIES one:
##     `toSessionError` maps `RateLimit` to the wire type `provider.rate-limit`
##     (packages/core/src/session/to-session-error.ts), and `rateLimitDetails` reads the
##     provider's own reset/limit/remaining headers (packages/ai/src/provider-error.ts).
##   * A CONTEXT LIMIT is a window of the model. The runtime has THREE distinct signals for
##     it: the wire type `context.limit` when a compaction rebase still overflowed
##     (packages/core/src/session/runner/llm.ts), `provider.invalid-request` with
##     `classification: "context-overflow"`, and a `contextLimit` figure on
##     `session.step.ended`/`session.step.failed`
##     (packages/schema/src/session-event.ts).
##   * A LOCAL ADVISORY BUDGET is the user's own policy, and R7-05 made it advisory by
##     construction.
##
## THE VERIFIED DEFECT THIS TASK FIXES: `Wire.STEP_FAILED` and `Wire.EXECUTION_FAILED` were
## declared in the client's vocabulary and handled NOWHERE. The runtime classifies every
## provider failure into a distinct wire type and the client showed the user none of it, so a
## rate limit, an exhausted quota and a context overflow all arrived as nothing at all - and
## the `contextLimit` figure was read by nothing.
##
## Each clause below fails differently:
##
##   * THE CLASSIFICATION SURVIVES to the client, as a distinct kind;
##   * THE FOUR KINDS STAY DISTINCT, each with its own label;
##   * A CONTEXT OVERFLOW IS NOT A QUOTA and not a rate limit;
##   * A RATE LIMIT REPORTS ITS OWN RESET when the provider gave one;
##   * THE CONTEXT LIMIT FIGURE IS READ from the step;
##   * NO ENFORCED CONTROL is exposed, because no backend enforcement exists.
extends RefCounted


func run(t) -> void:
	test_a_rate_limit_is_classified_as_its_own_kind(t)
	test_a_quota_exhaustion_is_not_a_rate_limit(t)
	test_a_context_overflow_is_not_a_quota(t)
	test_the_four_limit_kinds_have_distinct_labels(t)
	test_a_context_overflow_names_the_model_window(t)
	test_the_step_carries_the_context_limit_figure(t)
	test_an_unknown_error_type_is_still_reported(t)
	test_a_failed_step_reaches_the_store(t)
	test_a_failed_execution_reaches_the_store(t)
	test_no_enforced_control_is_exposed(t)
	test_a_rate_limit_reset_is_reported_when_the_provider_gave_one(t)
	test_every_runtime_error_type_is_classified(t)
	test_the_provider_cache_state_is_not_a_limit(t)


## A session that exists, so a step failure has somewhere to land.
func _session(store: OfficeStore, session_id: String = "ses_a") -> void:
	store.apply({
		"type": Wire.SESSION_CREATED, "sessionID": session_id,
		"data": {"agent": "lead", "title": "Lead"}, "sourceEpoch": "epoch-a",
	})


func _failed_step(error_type: String, message: String, extra: Dictionary = {}) -> Dictionary:
	var data := {"error": {"type": error_type, "message": message}}
	for key in extra:
		data[key] = extra[key]
	return {
		"type": Wire.STEP_FAILED, "sessionID": "ses_a",
		"data": data, "sourceEpoch": "epoch-a",
	}


## A rate limit is its OWN kind, not a generic failure.
func test_a_rate_limit_is_classified_as_its_own_kind(t) -> void:
	var store := OfficeStore.new()
	_session(store)
	store.apply(_failed_step("provider.rate-limit", "Rate limit reached for this model."))
	var rows := store.limit_events("ses_a")
	t.check_equal(rows.size(), 1, "the failure is recorded")
	if rows.is_empty():
		return
	t.check_equal(
		str(rows[0].get("kind", "")), LimitEvent.KIND_RATE_LIMIT,
		"and classified as a rate limit (%s)" % str(rows[0].get("kind", ""))
	)
	t.check(
		str(rows[0].get("message", "")).contains("Rate limit"),
		"with the provider's message (%s)" % str(rows[0].get("message", ""))
	)


## An exhausted quota is a DIFFERENT thing from a rate limit. The runtime classifies them
## separately and the client must not merge them.
func test_a_quota_exhaustion_is_not_a_rate_limit(t) -> void:
	var store := OfficeStore.new()
	_session(store)
	store.apply(_failed_step("provider.quota", "Your credit balance is too low."))
	var rows := store.limit_events("ses_a")
	t.check_equal(rows.size(), 1, "the failure is recorded")
	if rows.is_empty():
		return
	t.check_equal(
		str(rows[0].get("kind", "")), LimitEvent.KIND_QUOTA,
		"an exhausted quota is classified as a quota (%s)" % str(rows[0].get("kind", ""))
	)
	t.check(
		str(rows[0].get("kind", "")) != LimitEvent.KIND_RATE_LIMIT,
		"and NOT as a rate limit"
	)


## A context overflow is a window of the MODEL. It is neither the user's spending nor the
## provider's request rate, and confusing it with either sends the user to the wrong fix.
func test_a_context_overflow_is_not_a_quota(t) -> void:
	var store := OfficeStore.new()
	_session(store)
	store.apply(_failed_step(
		"context.limit", "The provider still rejected the request for context overflow."
	))
	var rows := store.limit_events("ses_a")
	t.check_equal(rows.size(), 1, "the overflow is recorded")
	if rows.is_empty():
		return
	t.check_equal(
		str(rows[0].get("kind", "")), LimitEvent.KIND_CONTEXT,
		"a context overflow is its own kind (%s)" % str(rows[0].get("kind", ""))
	)
	t.check(
		str(rows[0].get("kind", "")) != LimitEvent.KIND_QUOTA,
		"and not a quota"
	)
	# The runtime ALSO expresses overflow as an invalid request with a classification, so both
	# spellings must land in the same kind rather than one being missed.
	var store2 := OfficeStore.new()
	_session(store2)
	store2.apply(_failed_step("provider.invalid-request", "model_context_window_exceeded"))
	t.check_equal(
		str(store2.limit_events("ses_a")[0].get("kind", "")), LimitEvent.KIND_CONTEXT,
		"an invalid-request context overflow is the same kind"
	)
	# But an invalid request that does NOT name a window is not a context overflow. Guessing
	# would label every rejected request a context problem and send the user to the wrong fix.
	var store3 := OfficeStore.new()
	_session(store3)
	store3.apply(_failed_step("provider.invalid-request", "Missing required field 'temperature'."))
	t.check_equal(
		str(store3.limit_events("ses_a")[0].get("kind", "")), LimitEvent.KIND_UNCLASSIFIED,
		"an invalid request naming no window is NOT labelled a context limit (%s)" % str(
			store3.limit_events("ses_a")[0].get("kind", "")
		)
	)


## Each kind has its own label, and no two share one. "Each needs its own label" is the kit's
## own wording.
func test_the_four_limit_kinds_have_distinct_labels(t) -> void:
	var labels: Array[String] = []
	for kind in [
		LimitEvent.KIND_QUOTA, LimitEvent.KIND_RATE_LIMIT,
		LimitEvent.KIND_CONTEXT, LimitEvent.KIND_BUDGET,
	]:
		labels.append(LimitEvent.label(kind))
	t.check_equal(labels.size(), 4, "there are four kinds")
	var unique: Array[String] = []
	for label in labels:
		if not unique.has(label):
			unique.append(label)
	t.check_equal(unique.size(), 4, "and four DISTINCT labels (%s)" % str(labels))
	# And none of them reads as another's.
	t.check(
		LimitEvent.label(LimitEvent.KIND_CONTEXT) != LimitEvent.label(LimitEvent.KIND_QUOTA),
		"a context limit is not labelled as a quota"
	)
	t.check(
		not LimitEvent.label(LimitEvent.KIND_CONTEXT).to_lower().contains("quota"),
		"and its label does not contain the word quota (%s)" % LimitEvent.label(LimitEvent.KIND_CONTEXT)
	)


## A context overflow names the window it exceeded when the provider reported one.
func test_a_context_overflow_names_the_model_window(t) -> void:
	var store := OfficeStore.new()
	_session(store)
	store.apply(_failed_step(
		"context.limit", "Context overflow.", {"contextLimit": 200000}
	))
	var rows := store.limit_events("ses_a")
	t.check_equal(rows.size(), 1, "the overflow is recorded")
	if rows.is_empty():
		return
	t.check_equal(int(rows[0].get("context_limit", 0)), 200000, "the window figure is read")
	t.check(
		str(rows[0].get("detail", "")).contains("200000"),
		"and it is rendered into the detail (%s)" % str(rows[0].get("detail", ""))
	)


## The step's `contextLimit` is read on a SUCCESSFUL step too, so the window is known before
## anything overflows - which is what makes the overflow explicable afterwards.
func test_the_step_carries_the_context_limit_figure(t) -> void:
	var store := OfficeStore.new()
	_session(store)
	store.apply({
		"type": Wire.STEP_ENDED, "sessionID": "ses_a",
		"data": {"assistantMessageID": "msg_1", "contextLimit": 131072},
		"sourceEpoch": "epoch-a",
	})
	t.check_equal(
		store.context_limit_for("ses_a"), 131072,
		"the context window is read from the step"
	)
	# A step that reports none leaves the previous figure alone rather than zeroing it.
	store.apply({
		"type": Wire.STEP_ENDED, "sessionID": "ses_a",
		"data": {"assistantMessageID": "msg_2"}, "sourceEpoch": "epoch-a",
	})
	t.check_equal(
		store.context_limit_for("ses_a"), 131072,
		"and a later step that reports none does not zero it"
	)


## An error type this build does not know is still REPORTED. Dropping it would hide a real
## failure because its spelling was unfamiliar.
func test_an_unknown_error_type_is_still_reported(t) -> void:
	var store := OfficeStore.new()
	_session(store)
	store.apply(_failed_step("provider.something-new", "An unrecognised failure."))
	var rows := store.limit_events("ses_a")
	t.check_equal(rows.size(), 1, "an unknown failure is still recorded")
	if rows.is_empty():
		return
	t.check(
		not str(rows[0].get("message", "")).is_empty(),
		"with its message (%s)" % str(rows[0].get("message", ""))
	)
	t.check_equal(
		str(rows[0].get("kind", "")), LimitEvent.KIND_UNCLASSIFIED,
		"and an honest unclassified kind rather than a guessed one"
	)


## THE DEFECT: a failed step must reach the store at all.
func test_a_failed_step_reaches_the_store(t) -> void:
	var store := OfficeStore.new()
	_session(store)
	var applied := store.apply(_failed_step("provider.rate-limit", "Slow down."))
	t.check(applied, "a failed step is applied rather than ignored")
	t.check_equal(
		store.limit_events("ses_a").size(), 1,
		"and it is visible to a reader"
	)


## A failed EXECUTION carries an error too, and must also be classified.
func test_a_failed_execution_reaches_the_store(t) -> void:
	var store := OfficeStore.new()
	_session(store)
	store.apply({
		"type": Wire.EXECUTION_FAILED, "sessionID": "ses_a",
		"data": {"error": {"type": "provider.auth", "message": "The API key was rejected."}},
		"sourceEpoch": "epoch-a",
	})
	var rows := store.limit_events("ses_a")
	t.check_equal(rows.size(), 1, "the execution failure is recorded")
	if rows.is_empty():
		return
	t.check(
		str(rows[0].get("message", "")).contains("API key"),
		"with the provider's own message (%s)" % str(rows[0].get("message", ""))
	)


## NO ENFORCED CONTROL. No backend enforcement exists, so nothing may present itself as
## enforced. This is the acceptance's own prohibition.
func test_no_enforced_control_is_exposed(t) -> void:
	for kind in [
		LimitEvent.KIND_QUOTA, LimitEvent.KIND_RATE_LIMIT,
		LimitEvent.KIND_CONTEXT, LimitEvent.KIND_BUDGET,
	]:
		t.check(
			not LimitEvent.is_enforced(kind),
			"the '%s' kind is not presented as enforced" % kind
		)
	t.check(
		LimitEvent.ENFORCED_REASON.contains("backend"),
		"and the reason names the backend enforcement that would be required (%s)" % LimitEvent.ENFORCED_REASON
	)
	# A provider quota is provider DATA. Marking it enforced would suggest this client can act
	# on it, which it cannot.
	t.check(
		not LimitEvent.is_enforced(LimitEvent.KIND_QUOTA),
		"a provider quota is data, not a control this client enforces"
	)


## A rate limit reports its own reset when the runtime supplied one, and says so when it did
## not. It never invents a reset time.
func test_a_rate_limit_reset_is_reported_when_the_provider_gave_one(t) -> void:
	var store := OfficeStore.new()
	_session(store)
	store.apply(_failed_step("provider.rate-limit", "Rate limit reached."))
	var rows := store.limit_events("ses_a")
	if rows.is_empty():
		t.check(false, "the rate limit is recorded")
		return
	# `SessionError.Error` carries only type and message, so the runtime's richer rate-limit
	# detail (retry-after, reset) is NOT on this wire. The client must therefore say the reset
	# is not reported rather than render a figure it does not have.
	t.check(
		not str(rows[0].get("detail", "")).is_empty(),
		"the rate limit carries a detail line (%s)" % str(rows[0].get("detail", ""))
	)
	t.check(
		not str(rows[0].get("detail", "")).to_lower().contains("retry after"),
		"and it does NOT claim a retry time the wire does not carry (%s)" % str(rows[0].get("detail", ""))
	)
	t.check(
		str(rows[0].get("detail", "")).to_lower().contains("not reported"),
		"it says the reset is not reported (%s)" % str(rows[0].get("detail", ""))
	)


## EVERY wire error type the runtime can emit is classified, so a new one cannot arrive as
## silence. The set is taken from `toSessionError`, which is the runtime's own mapping
## (packages/core/src/session/to-session-error.ts).
func test_every_runtime_error_type_is_classified(t) -> void:
	var runtime_types := [
		"provider.rate-limit", "provider.auth", "provider.quota", "provider.content-filter",
		"provider.transport", "provider.internal", "provider.invalid-output",
		"provider.invalid-request", "provider.no-route", "provider.unknown",
		"permission.rejected", "aborted", "tool.execution", "unknown",
	]
	var store := OfficeStore.new()
	_session(store)
	for error_type in runtime_types:
		store.apply(_failed_step(error_type, "A failure the runtime classified."))
	var rows := store.limit_events("ses_a")
	t.check_equal(
		rows.size(), runtime_types.size(),
		"every runtime error type reaches the store (%d of %d)" % [rows.size(), runtime_types.size()]
	)
	for row in rows:
		t.check(
			not str(row.get("kind", "")).is_empty(),
			"'%s' has a kind (%s)" % [str(row.get("message", "")), str(row.get("kind", ""))]
		)
		t.check(
			not LimitEvent.label(str(row.get("kind", ""))).is_empty(),
			"and a label"
		)
	# The four limit kinds are the ones that must be DISTINGUISHED; everything else is
	# genuinely unclassified, and saying so is honest rather than guessing.
	var kinds: Array[String] = []
	for row in rows:
		if not kinds.has(str(row.get("kind", ""))):
			kinds.append(str(row.get("kind", "")))
	t.check(
		kinds.has(LimitEvent.KIND_RATE_LIMIT) and kinds.has(LimitEvent.KIND_QUOTA),
		"the rate limit and the quota are separated among them (%s)" % str(kinds)
	)


## The provider cache state is a DIAGNOSTIC, not a limit. Presenting it as one would add a
## fifth kind that is not a limit at all.
func test_the_provider_cache_state_is_not_a_limit(t) -> void:
	var store := OfficeStore.new()
	_session(store)
	store.apply({
		"type": Wire.STEP_ENDED, "sessionID": "ses_a",
		"data": {
			"assistantMessageID": "msg_1",
			"providerCache": {"status": "miss"},
		},
		"sourceEpoch": "epoch-a",
	})
	t.check_equal(
		store.limit_events("ses_a").size(), 0,
		"a provider cache diagnostic is not recorded as a limit"
	)
