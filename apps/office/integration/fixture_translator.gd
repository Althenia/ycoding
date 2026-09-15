## Fixture record -> real wire event translation.
##
## The shipped fixtures use five client-internal labels that do NOT exist on the
## YCoding wire. This translator converts each record into the real shape the
## service emits, so DemoTransport and the live path converge on one reducer.
## A fixture label reaching OfficeStore.apply() directly is a defect.
##
## Verified real vocabulary: contracts/wire-audit.json -> actual_event_vocabulary
class_name FixtureTranslator
extends RefCounted

## Fixture-only labels.
const FIXTURE_CONNECTION := "connection.changed"
const FIXTURE_OBSERVED := "session.observed"
const FIXTURE_ACTIVITY := "activity.changed"
const FIXTURE_INTERACTION := "interaction.created"
const FIXTURE_SETTLED := "session.settled"

## Fixture activity -> real event type.
const ACTIVITY_EVENTS := {
	"idle": "",
	"reading": Wire.TEXT_STARTED,
	"typing": Wire.STEP_STARTED,
	"testing": Wire.TOOL_CALLED,
	"reviewing": Wire.STEP_STARTED,
	"processing": Wire.EXECUTION_STARTED,
	"waiting": Wire.SESSION_STATUS,
}

## Fixture settlement -> real terminal event type.
const SETTLED_EVENTS := {
	"succeeded": Wire.EXECUTION_SUCCEEDED,
	"failed": Wire.EXECUTION_FAILED,
	"cancelled": Wire.EXECUTION_INTERRUPTED,
	"inactive": Wire.EXECUTION_SUCCEEDED,
}


## Returns an Array of real wire events (possibly empty when the fixture record
## carries no wire equivalent, e.g. a synthetic idle transition).
static func translate(record: Dictionary) -> Array[Dictionary]:
	var kind := str(record.get("kind", ""))
	var at_ms := int(record.get("at_ms", 0))
	var epoch := str(record.get("source_epoch", ""))
	var session_id: Variant = record.get("session_id")
	var payload: Dictionary = record.get("payload", {})
	match kind:
		FIXTURE_CONNECTION:
			return [_connection(payload, at_ms, epoch, record)]
		FIXTURE_OBSERVED:
			return [_observed(session_id, payload, at_ms, epoch)]
		FIXTURE_ACTIVITY:
			return _activity(session_id, payload, at_ms, epoch)
		FIXTURE_INTERACTION:
			return [_interaction(session_id, payload, at_ms, epoch)]
		FIXTURE_SETTLED:
			return [_settled(session_id, payload, at_ms, epoch)]
	return []


static func _base(
	type: String, session_id: String, data: Dictionary, at_ms: int, epoch: String, record: Dictionary
) -> Dictionary:
	return {
		"type": type,
		"sessionID": session_id,
		"data": data,
		"sourceEpoch": epoch,
		"_fixture_at_ms": at_ms,
		"_fixture_id": str(record.get("event_id", "")),
		"_synthetic": true,
	}


## connection.changed has no wire equivalent. The fixture's `live` means the
## synthetic connection is ready, NOT that mode became LIVE. The store therefore
## receives only a `server.connected` marker carrying the epoch.
static func _connection(
	payload: Dictionary, at_ms: int, epoch: String, record: Dictionary
) -> Dictionary:
	var state := str(payload.get("state", "syncing"))
	var type: String = Wire.CONNECTED if state == "live" else Wire.SESSION_STATUS
	if type == Wire.SESSION_STATUS:
		# Represent non-live transport states as a no-session status frame.
		var event := _base(type, "", {"status": {"type": Wire.STATUS_IDLE}}, at_ms, epoch, record)
		event["_transport_state"] = state
		return event
	return _base(type, "", {}, at_ms, epoch, record)


## session.observed -> session.created + an explicit status, both real events.
##
## The real `session.created` also carries `location` and `model`. The fixture has
## no server, so these are SYNTHETIC stand-ins, flagged with `synthetic: true` so
## the UI can label them rather than passing them off as real placement. They use
## the repository's own workspace so the demo path is recognisable, and a model
## that genuinely exists in this project's config.
const DEMO_DIRECTORY := "~/Workspace/Project/ycoding"
const DEMO_MODEL_REF := "openrouter/deepseek/deepseek-v4.1-flash#high"

static func _observed(session_id: Variant, payload: Dictionary, at_ms: int, epoch: String) -> Dictionary:
	# JSON null must normalize to an empty parent, never the literal "<null>".
	var parent: Variant = payload.get("parent_session_id")
	var data := {
		"sessionID": str(session_id),
		"parentID": "" if parent == null else str(parent),
		"agent": str(payload.get("agent_id", "agent")),
		"title": str(payload.get("display_role", "")),
		"location": {"directory": DEMO_DIRECTORY},
		"model": {"ref": DEMO_MODEL_REF},
		"synthetic": true,
	}
	return _base("session.created", str(session_id), data, at_ms, epoch, {"event_id": "observed:%s" % str(session_id)})


## activity.changed -> the real event family that would produce that activity.
static func _activity(session_id: Variant, payload: Dictionary, at_ms: int, epoch: String) -> Array[Dictionary]:
	var activity := str(payload.get("activity", "idle"))
	var type := str(ACTIVITY_EVENTS.get(activity, ""))
	if type.is_empty():
		return []
	if type == Wire.SESSION_STATUS:
		return [_base(type, str(session_id), {"status": {"type": Wire.STATUS_RETRY}}, at_ms, epoch, {"event_id": "activity"})]
	if type == Wire.TOOL_CALLED:
		return [_base(type, str(session_id), {"tool": "shell"}, at_ms, epoch, {"event_id": "activity"})]
	return [_base(type, str(session_id), {}, at_ms, epoch, {"event_id": "activity"})]


## interaction.created -> session.task.updated with the matching change kind.
static func _interaction(session_id: Variant, payload: Dictionary, at_ms: int, epoch: String) -> Dictionary:
	var kind := str(payload.get("interaction_kind", "inform"))
	var change: Dictionary = {}
	match kind:
		"delegation":
			change = {
				"type": Wire.CHANGE_LAUNCHED,
				"parentID": str(payload.get("from_session_id", "")),
				"inputID": str(payload.get("to_session_id", "")),
				"toolCallID": str(payload.get("interaction_id", "")),
				"description": str(payload.get("summary", "")),
				"prompt": str(payload.get("details", "")),
			}
		"question":
			change = {
				"type": Wire.CHANGE_QUESTION_ASKED,
				"question": {
					"id": str(payload.get("interaction_id", "")),
					"text": str(payload.get("summary", "")),
					"data": {"details": str(payload.get("details", ""))},
				},
			}
		"answer":
			change = {
				"type": Wire.CHANGE_QUESTION_ANSWERED,
				"answer":
				{
					"questionID": str(payload.get("interaction_id", "")),
					"text": str(payload.get("summary", "")),
				},
			}
		"report":
			change = {
				"type": Wire.CHANGE_COMPLETED,
				"excerpt": str(payload.get("summary", "")),
			}
		"review":
			change = {"type": Wire.CHANGE_PROGRESSED, "progress": {"text": str(payload.get("summary", ""))}}
		_:
			change = {"type": Wire.CHANGE_PROGRESSED, "progress": {"text": str(payload.get("summary", ""))}}
	var data := {
		"sessionID": str(session_id),
		"change": change,
		"_interaction_id": str(payload.get("interaction_id", "")),
		"_details": str(payload.get("details", "")),
		"_summary": str(payload.get("summary", "")),
	}
	return _base(Wire.TASK_UPDATED, str(session_id), data, at_ms, epoch, {"event_id": "interaction"})


## session.settled -> the real terminal execution event.
static func _settled(session_id: Variant, payload: Dictionary, at_ms: int, epoch: String) -> Dictionary:
	var status := str(payload.get("status", "inactive"))
	var type := str(SETTLED_EVENTS.get(status, Wire.EXECUTION_SUCCEEDED))
	return _base(type, str(session_id), {}, at_ms, epoch, {"event_id": "settled"})
