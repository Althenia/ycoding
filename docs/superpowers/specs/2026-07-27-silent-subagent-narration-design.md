# Silent subagent narration design

Status: approved

## Goal

The parent agent does not proactively narrate subagent bookkeeping. It reports subagent status only when the user explicitly asks for status.

## Current cause

The parent model currently receives multiple model-facing cues that invite narration:

- the subagent tool description emphasizes background execution and completion notification;
- the immediate tool result tells the model that work continues in the background;
- every parent turn receives a volatile TeamView containing child states such as running, completed, and failed.

The TeamView is required for orchestration decisions, but its current framing does not tell the model to keep that state internal.

## Behavior

- The parent may use TeamView data to coordinate work, avoid duplicate launches, answer child questions, and consume completed results.
- The parent does not volunteer counts or summaries such as running, completed, failed, or total.
- The parent does not announce that a child is running in the background merely because the launch tool returned.
- The parent does not announce completion or failure as standalone bookkeeping.
- When the user explicitly asks for subagent status, the parent gives an accurate status summary from current durable orchestration state.
- Final answers may include substantive results produced by subagents, but not implementation bookkeeping unless the user asked for it.
- A subagent failure that prevents the requested outcome is reported as a task blocker or incomplete result, not as routine background-status narration.

## Explicit status request

An explicit request includes direct language such as:

- “What are the subagents doing?”
- “Show subagent status.”
- “How many completed or failed?”
- “Which agents are still running?”

A general request for progress on the user task is not automatically a request for orchestration bookkeeping. The parent should summarize task progress, not internal child counts, unless the counts are specifically requested.

## Implementation boundary

The change belongs in model-facing orchestration text, not in the durable state model or TUI:

- subagent tool description and immediate launch result;
- TeamView preamble or accompanying instruction;
- targeted tests for generated model context.

The durable TeamView schema, terminal states, notifications, sidebar, and subagent TUI remain unchanged.

## Recommended wording policy

Model-facing text should state that orchestration data is internal and must not be surfaced unless the user explicitly requests subagent status. It should still permit reporting a blocking failure when the requested task cannot be completed.

The immediate launch result should be concise and operational, for example: the child was launched and no polling is required. It should not instruct the model to notify the user when the child finishes.

## Tests

Regression coverage must prove:

1. the subagent tool description includes the silence rule;
2. the launch result does not instruct proactive user notification;
3. TeamView context explicitly marks its status data as internal unless requested;
4. durable TeamView JSON remains available to the model;
5. no Schema, persistence, notification, or TUI contract changes are introduced.

## Non-goals

- Removing TeamView from model context.
- Disabling durable subagent notifications or TUI status.
- Hiding a failure that blocks task completion.
- Changing subagent execution, scheduling, progress steering, or persistence.
