## Real YCoding wire vocabulary, verified against the live Schema owners
## (`packages/schema/src/session-event.ts`, `event-manifest.ts` and the other
## `*-event.ts` inventories) and the live Protocol route groups
## (`packages/protocol/src/groups/`).
##
## These names come from the live service, not from the handoff fixtures. Fixture
## labels are client-internal and are translated by DemoTransport before they
## reach the store, so demo and live share one reducer.
class_name Wire
extends RefCounted

const CONNECTED := "server.connected"
const SESSION_CREATED := "session.created"
const SESSION_STATUS := "session.status"
const EXECUTION_STARTED := "session.execution.started"
const EXECUTION_SUCCEEDED := "session.execution.succeeded"
const EXECUTION_FAILED := "session.execution.failed"
const EXECUTION_INTERRUPTED := "session.execution.interrupted"
const TASK_UPDATED := "session.task.updated"
const STEP_STARTED := "session.step.started"
const STEP_ENDED := "session.step.ended"
const STEP_FAILED := "session.step.failed"
const TOOL_CALLED := "session.tool.called"
const TOOL_SUCCESS := "session.tool.success"
const TOOL_FAILED := "session.tool.failed"
const TEXT_STARTED := "session.text.started"
const TEXT_DELTA := "session.text.delta"
const TEXT_ENDED := "session.text.ended"
const REASONING_STARTED := "session.reasoning.started"
const REASONING_DELTA := "session.reasoning.delta"
const REASONING_ENDED := "session.reasoning.ended"
const INPUT_ADMITTED := "session.input.admitted"
const INPUT_PROMOTED := "session.input.promoted"
const FILE_CHANGE := "session.file-change.recorded"
## A shell the runtime ran for this session. `started` opens it and `ended` settles
## it with the captured output (packages/schema/src/session-event.ts, Shell).
const SHELL_STARTED := "session.shell.started"
const SHELL_ENDED := "session.shell.ended"
## Context compaction. An agent consolidating its context is genuinely retreading
## what it has already seen, which is what the focus station depicts.
## `started`/`admitted` begin it and `ended` finishes it.
const COMPACTION_STARTED := "session.compaction.started"
const COMPACTION_ADMITTED := "session.compaction.admitted"
const COMPACTION_ENDED := "session.compaction.ended"
const COMPACTION_FAILED := "session.compaction.failed"

## A session that is over. `deleted` and `archived` retire it; `unarchived`
## brings it back, so the office must treat all three as real transitions.
const SESSION_DELETED := "session.deleted"
const SESSION_ARCHIVED := "session.archived"
const SESSION_UNARCHIVED := "session.unarchived"

## `SessionOrchestration.Change` tagged-union members.
const CHANGE_LAUNCHED := "launched"
const CHANGE_STARTED := "started"
const CHANGE_PROGRESSED := "progressed"
const CHANGE_QUESTION_ASKED := "question_asked"

## Human attention that is not a question. Both are EPHEMERAL wire events rather
## than durable history: the runtime asks, the client answers, and the durable
## record is the effect, not the ask. A session blocked on one of these is showing
## the user nothing unless the client subscribes to them.
const PERMISSION_ASKED := "permission.v2.asked"
const GUARDRAIL_ASKED := "guardrail.asked"
const CHANGE_QUESTION_ANSWERED := "question_answered"
const CHANGE_COMPLETED := "completed"
const CHANGE_FAILED := "failed"
const CHANGE_CANCELLED := "cancelled"
const CHANGE_LOST := "lost"

## Session runtime status carried by the ephemeral `session.status` event.
const STATUS_IDLE := "idle"
const STATUS_BUSY := "busy"
const STATUS_RETRY := "retry"

## Events whose arrival means the session is executing right now.
const EXECUTING_EVENTS := [
	EXECUTION_STARTED,
	STEP_STARTED,
	TEXT_STARTED,
	REASONING_STARTED,
	TOOL_CALLED,
	INPUT_PROMOTED,
]

## Events that end an execution drain.
const SETTLING_EVENTS := [EXECUTION_SUCCEEDED, EXECUTION_FAILED, EXECUTION_INTERRUPTED]
