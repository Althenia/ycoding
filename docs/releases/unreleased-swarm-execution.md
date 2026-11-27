# Swarm execution

## Added

- The built-in Project role instructions now carry swarm execution. The Master and supervisors launch independent member lanes together and verify finished lanes while others run. Members delegate independent subtasks to native subagents and keep integration and verification. Dependencies, overlapping writes and shared integration stay serialized, and no filler launches are made. No user instruction file or per-Session message is needed.
- A refused subagent launch records the durable `coordination.subagent.request.blocked` event on the requesting Session with the requested agent, the reason and the refusal message. Reasons are `concurrency-ceiling`, `agent-missing`, `permission-denied`, `project-paused` and `route-unavailable`. No child Session is created for a blocked request.
