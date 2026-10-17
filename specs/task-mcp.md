# Task MCP interface

The opt-in `ycoding mcp serve` command exposes `list_tasks`, `start_task`, `get_status`, `get_result`, and `cancel_task`. This is an SDK-managed Streamable HTTP surface separate from the main YCoding HttpApi; it does not add or change generated Client operations.

The CLI discovers the existing local service and adapts its generated Client to Core's task gateway. Core owns OAuth verification, MCP transport, and the durable ownership/admission index. The index records identity, prompt digest, deterministic Session ID, creation time, admission phase, and cancellation intent. Session execution and transcript remain authoritative in the existing runtime. No prompt bodies, credentials, or duplicate transcript are stored in the index.

The OAuth resource, trusted issuer, subject, repository, agent, and model are fixed by the local operator. Every MCP request requires a signature-verified RS256 access token matching the issuer, subject, exact resource audience, validity interval, and `ycoding:tasks` scope. Metadata is public. A task ID is accepted only if present in that configuration's index; Session IDs are namespaced by configuration identity and request ID. Session placement is checked before backend controls and reads.

Admission is serialized, capacity-bounded, idempotent by request ID plus exact prompt digest, and asynchronous after the durable index entry. Task worktrees are unique children of the configured canonical workspace root. Backend worktree creation must return that exact path. Task startup never changes autonomy or bypasses local permissions. Unknown tasks and invalid arguments are tool errors, and backend failures use sanitized messages.

Execution status derives from durable lifecycle events plus live/pending work. Idle alone is never success. Cancellation during setup prevents prompt admission; cancellation during/after admission requests interruption. Pending durable input remains visible as `cancelling` until resolved. Preparation is never replayed after process loss, and uncertain admission is reconciled by reading Session state, not sending the prompt again.

Read limits: 50 tasks per page, 1000 retained task records per index, 128 KiB request bodies, 64 KiB UTF-8 prompts, 20 snapshot messages, and 32 KiB assistant-text results. The complete operator contract and external setup requirements are specified in [Task MCP gateway](../docs/task-mcp.md).
