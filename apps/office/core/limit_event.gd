## A limit the runtime reported, classified by what KIND of limit it is.
##
## FOUR KINDS OF LIMIT COME FROM FOUR DIFFERENT SOURCES, and the kit requires that "each
## needs its own label":
##
##   QUOTA     - provider data. The account's spending or credit limit, from
##               `ProviderUsage.Snapshot`. The runtime reports an exhausted one as the wire
##               type `provider.quota` (packages/core/src/session/to-session-error.ts).
##   RATE      - a request-rate constraint, reported as `provider.rate-limit` and carrying
##               the provider's own reset/limit/remaining headers where it sent them
##               (packages/ai/src/provider-error.ts).
##   CONTEXT   - the MODEL's own window. The runtime says this three ways and all three mean
##               the same thing: `context.limit` when a compaction rebase still overflowed
##               (packages/core/src/session/runner/llm.ts), `provider.invalid-request` with
##               `classification: "context-overflow"`, and a `contextLimit` figure on the
##               step. Confusing it with a quota sends the user to the wrong fix: a context
##               overflow is not something to pay for.
##   BUDGET    - the USER's own warning policy, which R7-05 made advisory by construction.
##
## WHY THIS CLASS EXISTS AT ALL: the client's `Wire.STEP_FAILED` and `Wire.EXECUTION_FAILED`
## were declared and handled nowhere. The runtime classifies every provider failure into a
## distinct wire type, and the user saw none of it - so a rate limit, an exhausted quota and
## a context overflow all arrived as nothing.
##
## NOTHING HERE IS ENFORCED, and nothing here may present itself as enforced. No backend
## admission control exists, so `is_enforced` is false for every kind and the reason says
## what enforcement would actually require.
class_name LimitEvent
extends RefCounted

## The four kinds.
const KIND_QUOTA := "quota"
const KIND_RATE_LIMIT := "rate-limit"
const KIND_CONTEXT := "context-limit"
const KIND_BUDGET := "budget"
## A failure whose kind this build does not recognise. Reported honestly as unclassified
## rather than guessed into one of the four, because a wrong label sends the user to the
## wrong fix.
const KIND_UNCLASSIFIED := "unclassified"

## One label per kind. No two share one, and none reads as another's.
const LABELS := {
	KIND_QUOTA: "Provider quota exhausted",
	KIND_RATE_LIMIT: "Provider rate limit",
	KIND_CONTEXT: "Model context limit",
	KIND_BUDGET: "Your advisory budget",
	KIND_UNCLASSIFIED: "Unclassified provider failure",
}

## Why no kind is enforced. Stated rather than implied, so a reader is not left wondering
## whether a control is merely unimplemented.
const ENFORCED_REASON := (
	"None of these is enforced here: enforcing a limit would require admission and " +
	"continuation enforcement in the shared backend, applying to the TUI and every " +
	"concurrent session. This client reports what the runtime said and stops nothing."
)

## The wire error types the runtime emits, mapped to the kind they name. Taken from
## `toSessionError` (packages/core/src/session/to-session-error.ts) and the overflow case in
## the runner, not invented here.
const WIRE_KINDS := {
	"provider.quota": KIND_QUOTA,
	"provider.rate-limit": KIND_RATE_LIMIT,
	"context.limit": KIND_CONTEXT,
}


## The label for a kind.
static func label(kind: String) -> String:
	return str(LABELS.get(kind, LABELS[KIND_UNCLASSIFIED]))


## Whether any kind is enforced. Never: enforcement lives in the backend and does not exist.
static func is_enforced(_kind: String) -> bool:
	return false


## Classify a wire error into a limit kind.
##
## The classification is the runtime's own: a `provider.invalid-request` is a context
## overflow only when the runtime said so, either by its type or by naming a context window
## in its message. Guessing from a message alone would label unrelated bad requests as
## context problems.
static func classify(error: Dictionary) -> String:
	var error_type := str(error.get("type", ""))
	if WIRE_KINDS.has(error_type):
		return str(WIRE_KINDS[error_type])
	if error_type == "provider.invalid-request":
		return KIND_CONTEXT if _names_context_window(str(error.get("message", ""))) else KIND_UNCLASSIFIED
	return KIND_UNCLASSIFIED


## Whether a message names a context-window failure. These are the provider codes and phrases
## the runtime itself matches (`isContextOverflow`).
static func _names_context_window(message: String) -> bool:
	var text := message.to_lower()
	for phrase in [
		"context_length_exceeded", "model_context_window_exceeded", "context window",
		"context length", "context overflow", "too many tokens",
	]:
		if text.contains(phrase):
			return true
	return false


## The detail line for a failure: what the runtime said, plus the figure that explains it
## where one was supplied. Nothing is invented - a rate limit with no retry hint states none.
static func detail(error: Dictionary, kind: String, context_limit: int) -> String:
	var parts: Array[String] = []
	if kind == KIND_CONTEXT and context_limit > 0:
		parts.append("model context window %d tokens" % context_limit)
	# `SessionError.Error` is `{type, message}` only (packages/schema/src/session-error.ts).
	# The runtime's richer rate-limit detail - retry-after, reset, limit, remaining - lives in
	# its HTTP context and is NOT on this wire, so no reset is claimed here. Reading a field
	# the schema does not carry would render an invented figure the moment one appeared.
	if kind == KIND_RATE_LIMIT:
		parts.append("the provider's own reset is not reported here")
	return "  ·  ".join(parts)
