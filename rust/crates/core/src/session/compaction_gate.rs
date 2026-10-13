use super::{
    compaction_policy::{Advisory, Resolved},
    context_pressure::{Usage, estimated_input_tokens},
};
use ycoding_ai::{llm, openai_responses};
use ycoding_schema::session_message;

pub fn target_input_tokens(context_window_tokens: i64, policy: &Resolved) -> i64 {
    let consider = match policy.advisory {
        Advisory::Disabled => 70,
        Advisory::Thresholds {
            consider_percent, ..
        } => consider_percent,
    };
    context_window_tokens * consider / 100
}

pub fn estimated_provider_input_tokens(request: &llm::Request) -> i64 {
    if !request.model.route.id.contains("responses")
        && request.model.route.id != "ai-sdk:@ai-sdk/github-copilot"
    {
        return estimated_input_tokens(Usage {
            system: &request.system,
            tools: &request.tools,
            messages: &request.messages,
        });
    }
    let resolved = request.resolved();
    let pruned = openai_responses::prune_messages(&resolved);
    estimated_input_tokens(Usage {
        system: &resolved.system,
        tools: &resolved.tools,
        messages: &pruned,
    })
}

pub fn can_reduce(
    request: &llm::Request,
    history: &[session_message::Info],
    target_max_input_tokens: i64,
) -> bool {
    let last_user = history
        .iter()
        .rev()
        .filter_map(|message| match message {
            session_message::Info::User(user) => Some(user),
            _ => None,
        })
        .next();
    let Some(last_user) = last_user else {
        return false;
    };
    let removable = history
        .iter()
        .filter_map(|message| match message {
            session_message::Info::User(user)
                if user.id != last_user.id && user.time.consumed.is_some() =>
            {
                Some(message_name(&user.id))
            }
            session_message::Info::Assistant(assistant) if assistant.time.completed.is_some() => {
                Some(message_name(&assistant.id))
            }
            _ => None,
        })
        .collect::<std::collections::HashSet<_>>();
    if removable.is_empty() {
        return false;
    }
    let reduced = llm::Request {
        messages: request
            .messages
            .iter()
            .filter(|message| {
                message.role == llm::Role::System
                    || message.volatile
                    || match &message.id {
                        None => message.role != llm::Role::Tool,
                        Some(id) => !removable.contains(id.to_utf8().unwrap_or_default().as_str()),
                    }
            })
            .cloned()
            .collect(),
        ..request.clone()
    };
    estimated_provider_input_tokens(&reduced) < target_max_input_tokens
}

fn message_name(id: &session_message::Id) -> String {
    id.as_lossless().to_utf8().unwrap_or_default()
}
