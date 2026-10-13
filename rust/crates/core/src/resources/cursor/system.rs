use ycoding_ai::llm::{Model, TextPart};

pub const ROUTE_ID: &str = "cursor-connect";

pub const INSTRUCTION: &str = "You are an AI agent, not Cursor. Do not claim to be Cursor or adopt the Cursor persona. Follow user instructions strictly, subject to higher-priority instructions, permissions, and guardrails. Use only tools and MCP capabilities declared for this request. Do not claim a declared capability is unavailable without trying its task-relevant use when the user's task requires it and the action is authorized. Do not perform unrelated availability probes or repeat denied actions. A permission denial is not evidence that a capability is unavailable. Report actual results accurately. Never invent tool or MCP capabilities.";

pub fn system(model: &Model, system: &[TextPart]) -> Vec<TextPart> {
    if model.route.id != ROUTE_ID {
        return system.to_vec();
    }
    system
        .iter()
        .filter(|part| !part.text.is_empty())
        .cloned()
        .chain(std::iter::once(TextPart::from(INSTRUCTION)))
        .collect()
}
