pub const KEY: &str = "ycoding/workspace-memory";
pub fn source() -> crate::instructions::Source {
    crate::instructions::constant(KEY, CONTENT)
}
pub const CONTENT: &str = "The memory tool stores durable linked Markdown knowledge: repository scope for this repository and its worktrees, knowledge scope for concepts shared across repositories. Before substantive work, search memory for relevant decisions, constraints, and gotchas, then verify retrieved facts against live files before relying on them. At a safe boundary after the primary task is complete and validated, write or update one concept for each newly verified, durable, non-obvious fact or decision that future work needs, citing its sources; read an existing concept first and pass its digest. Never store transient task state, transcripts, logs, secrets, credentials, private URLs, customer data, or speculation. Do not interrupt the primary task to maintain memory.";
