use super::Configuration;
use ycoding_schema::{JsonObject, JsonValue, LosslessString};

pub(crate) struct ChatGpt {
    pub enabled: bool,
    pub profile: Option<LosslessString>,
    pub connectors: Option<JsonObject>,
}

impl Configuration {
    pub(crate) fn chatgpt_connector(&self) -> Option<ChatGpt> {
        let JsonValue::Object(account_connectors) = self.latest("account_connectors")? else {
            return None;
        };
        let JsonValue::Object(chatgpt) = account_connectors.get(&"chatgpt".into())? else {
            return None;
        };
        let JsonValue::Bool(enabled) = chatgpt.get(&"enabled".into())? else {
            return None;
        };
        let profile = match chatgpt.get(&"profile".into()) {
            None => None,
            Some(JsonValue::String(profile)) if !profile.is_empty() => Some(profile.clone()),
            _ => return None,
        };
        let connectors = match chatgpt.get(&"connectors".into()) {
            None => None,
            Some(JsonValue::Object(connectors)) if connectors.iter().all(|(_, value)| {
                matches!(value, JsonValue::String(value) if matches!(value.as_str(), Some("allow" | "deny")))
            }) => Some(connectors.clone()),
            _ => return None,
        };
        Some(ChatGpt {
            enabled: *enabled,
            profile,
            connectors,
        })
    }
}
