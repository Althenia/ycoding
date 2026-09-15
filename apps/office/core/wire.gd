## Real YCoding wire vocabulary, verified in `contracts/wire-audit.json`.
##
## These names come from the live service (`packages/schema/src/session-event.ts`
## and `event-manifest.ts`), not from the handoff fixtures. Fixture labels are
## client-internal and are translated by DemoTransport before they reach the
## store, so demo and live share one reducer.
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
const REASONING_STARTED := "session.reasoning.started"
const INPUT_ADMITTED := "session.input.admitted"
const INPUT_PROMOTED := "session.input.promoted"
const FILE_CHANGE := "session.file-change.recorded"

## `SessionOrchestration.Change` tagged-union members.
const CHANGE_LAUNCHED := "launched"
const CHANGE_STARTED := "started"
const CHANGE_PROGRESSED := "progressed"
const CHANGE_QUESTION_ASKED := "question_asked"
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
