# Session-owned PTY contract

Status: **implemented for the supported profile below**. Schema, Core, Protocol, Server, generated Clients, and Session navigation to the TUI inspector are implemented. Validation covers macOS PTYs, live HTTP/WebSocket lifecycle, and in-memory TUI rendering; native Warp/iTerm automation and a cross-platform terminal compatibility matrix are not supported or verified.

## Ownership and lifecycle

- Every PTY has one owning Session ID in addition to its Location. Create, list, read, mutation, termination, ticket, and WebSocket operations carry or verify that Session identity.
- A Location owns at most eight running PTYs. A PTY defaults to a 30-minute runtime and cannot request more than two hours.
- Geometry is explicit and bounded to 500 columns by 200 rows. Opening, closing, or passively resizing an inspector does not resize the child PTY.
- Closing an inspector detaches it. It does not terminate the process. Termination remains an explicit PTY remove operation.
- The Session command palette opens a picker filtered to that Session's PTYs. Only deliberate selection opens the inspector; navigation does not interrupt Session execution.
- Process exit records `exit` or `timeout`. Service shutdown sends an `end` frame with reason `service_shutdown`, closes attached WebSockets with code 1012, and kills only processes owned by that PTY service.

## Exclusive input control

Control state is `agent`, `user`, or `paused` and carries a monotonically increasing writer fence.

- Agent writes require the current generation, Session, `agent` owner, and fence.
- User input requires an explicit `take` transition and a control ticket scoped to the Session, PTY, generation, access mode, Location, and fence. The inspector keeps input disabled until that control connection is open and its captured replay has been applied, including during reconnect.
- Read-only tickets can receive output but cannot write. A stale attachment returns no write acknowledgement and the Server closes its WebSocket.
- Returning or closing user control transitions to `paused`. Agent control resumes only through a separate explicit `agent` transition from `paused`.
- Resize and other state-dependent mutations require the current writer identity and fence. The TUI offers fit-to-pane only while synchronized user control is active.

These controls prevent simultaneous agent/user writers; they are not a filesystem or process sandbox. Owned PTYs do not imply native terminal-application automation or isolation from files and environment already granted to the process.

## Bounded output and reconnect

Core retains at most 2 MiB of output bytes per PTY. Input frames are limited to 64 KiB, retained exited PTYs remain subject to the existing count bound, and each PTY accepts at most eight output attachments.

Each process generation has monotonically increasing byte offsets. Attach returns:

- generation;
- requested/available start offset;
- captured end offset;
- an explicit gap flag; and
- replay bytes only when the requested boundary is contiguous.

The WebSocket sends tagged control and data frames. Replay metadata is sent before replay chunks. Every data chunk is paired with generation and start/end offsets. Tagged envelopes prevent arbitrary terminal NUL bytes from being interpreted as control data.

The TUI keeps its native `EmbeddedTerminalRenderable` emulator resident during a reconnect. It applies only contiguous chunks for the same generation. Prefix eviction, generation mismatch, malformed frames, length mismatch, or out-of-order offsets mark the screen unsynchronized and disable state-dependent input. It does not reconstruct state from flattened text, replay commands, or claim restoration from an emulator snapshot.

## Terminal containment and supported profile

The supported implementation profile is macOS with `@opentui/core` 0.5.10's embedded emulator and the repository's existing PTY adapter. Output is interpreted inside the embedded terminal renderable; it is never forwarded as raw host-terminal escape output. In read-only mode the renderable cannot take focus or emit input/terminal-query responses. Child bell, title, clipboard, and focus sequences therefore do not ring, rename, copy to, or focus the host terminal.

The reusable inspector displays ownership, process state, geometry, synchronization state, bounded native scrollback, explicit selection copy, user control, paused handback, fit resize, and close-view. It does not auto-open or move another editor's focus. Search across discarded history, serialized emulator restore, graphics protocols, native Warp/iTerm control, and strict host/process isolation are not implemented.

## Public operations

Existing PTY operation names and paths remain, with required Session ownership added to their inputs. `pty.control` at `POST /api/pty/:ptyID/control` performs fenced control transitions. `pty.connectToken` requires explicit `inspect` or `control` access and generation; control also requires the current fence. `pty.connect` requires a single-use ticket and matching Session/access/generation/offset/fence query.

Generated Clients must be regenerated from the assembled Server `HttpApi`; generated files are not edited manually.
