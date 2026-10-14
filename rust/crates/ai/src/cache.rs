use crate::{
    json,
    llm::{Part, Request, Role},
};
use ycoding_schema::{JsonValue, LosslessString};

pub const POLICY_REVISION: &str = "provider-native/v8";
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HintType {
    Ephemeral,
    Persistent,
}
#[derive(Clone, Debug, PartialEq)]
pub struct Hint {
    pub kind: HintType,
    pub ttl_seconds: Option<f64>,
}
impl Hint {
    pub fn ephemeral(ttl_seconds: Option<f64>) -> Self {
        Self {
            kind: HintType::Ephemeral,
            ttl_seconds,
        }
    }
    pub fn one_hour(&self) -> bool {
        self.ttl_seconds.is_some_and(|seconds| seconds >= 3600.0)
    }
}
#[derive(Clone, Debug, PartialEq)]
pub enum MessageStrategy {
    LatestUser,
    LatestAssistant,
    Tail(usize),
}
#[derive(Clone, Debug, Default, PartialEq)]
pub enum Policy {
    #[default]
    Auto,
    None,
    Explicit {
        tools: bool,
        system: bool,
        messages: Option<MessageStrategy>,
        ttl_seconds: Option<f64>,
    },
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Profile {
    pub minimum_tokens: u32,
    pub extended_ttl: bool,
}
pub fn normalize_model_id(model: &str) -> String {
    let mut id = model.trim().to_lowercase();
    if let Some(rest) = id.strip_prefix("anthropic--") {
        id = rest.into();
    }
    let vendor = ["anthropic", "amazon", "meta", "mistral", "google", "openai"];
    if let Some((geo, rest)) = id.split_once('.')
        && (2..=4).contains(&geo.len())
        && geo.bytes().all(|ch| ch.is_ascii_lowercase())
        && vendor.iter().any(|vendor| {
            rest.starts_with(&format!("{vendor}.")) || rest.starts_with(&format!("{vendor}/"))
        })
    {
        id = rest.into();
    }
    if let Some(rest) = vendor.iter().find_map(|vendor| {
        id.strip_prefix(&format!("{vendor}."))
            .or_else(|| id.strip_prefix(&format!("{vendor}/")))
    }) {
        id = rest.into();
    }
    if let Some((_, rest)) = id.rsplit_once('/') {
        id = rest.into();
    }
    if let Some((rest, _)) = id.split_once('@') {
        id = rest.into();
    }
    if let Some((rest, version)) = id.rsplit_once("-v")
        && version.split_once(':').is_some_and(|(major, minor)| {
            !major.is_empty()
                && !minor.is_empty()
                && major
                    .bytes()
                    .chain(minor.bytes())
                    .all(|byte| byte.is_ascii_digit())
        })
    {
        id = rest.into();
    }
    if let Some((rest, snapshot)) = id.rsplit_once('-')
        && (6..=8).contains(&snapshot.len())
        && snapshot.bytes().all(|byte| byte.is_ascii_digit())
    {
        id = rest.into();
    }
    if let Some(rest) = id.strip_suffix("-latest") {
        id = rest.into();
    }
    id = id.replace('.', "-");
    if id == "claude-4-sonnet" {
        "claude-sonnet-4".into()
    } else {
        id
    }
}
pub fn profile(model: &str) -> Option<Profile> {
    let id = normalize_model_id(model);
    const PROFILES: &[(&str, u32, bool)] = &[
        ("claude-opus-5", 512, true),
        ("claude-sonnet-5-5", 512, true),
        ("claude-haiku-5-5", 512, true),
        ("claude-opus-5-5", 512, true),
        ("claude-fable-5", 512, true),
        ("claude-fable-5-1", 512, true),
        ("claude-mythos-5", 512, true),
        ("claude-opus-4-8", 1024, true),
        ("claude-opus-4-1", 1024, true),
        ("claude-opus-4", 1024, true),
        ("claude-sonnet-5", 1024, true),
        ("claude-sonnet-4-6", 1024, true),
        ("claude-sonnet-4-5", 1024, true),
        ("claude-sonnet-4", 1024, true),
        ("claude-3-5-sonnet", 1024, true),
        ("claude-opus-4-7", 2048, true),
        ("claude-mythos-preview", 2048, true),
        ("claude-3-5-haiku", 2048, true),
        ("claude-opus-4-6", 4096, true),
        ("claude-opus-4-5", 4096, true),
        ("claude-haiku-4-5", 4096, true),
        ("gpt-5-6", 1024, false),
        ("gpt-5", 1024, false),
        ("gpt-5-mini", 1024, false),
        ("gpt-5-nano", 1024, false),
        ("gpt-4o", 1024, false),
        ("gpt-4o-mini", 1024, false),
        ("gpt-4-1", 1024, false),
        ("gpt-4-1-mini", 1024, false),
        ("gpt-4-turbo", 1024, false),
        ("gpt-3-5-turbo", 1024, false),
        ("gpt-", 1024, false),
        ("o1", 1024, false),
        ("o3", 1024, false),
        ("o4", 1024, false),
        ("gemini-2-5-pro", 4096, false),
        ("gemini-2-5-flash", 1024, false),
        ("gemini-3-pro", 4096, false),
        ("gemini-3-flash", 1024, false),
        ("llama-4-maverick", 1024, false),
        ("llama-4-scout", 1024, false),
        ("llama-4-behemoth", 1024, false),
        ("llama-3-3", 1024, false),
        ("llama-3-2", 1024, false),
    ];
    PROFILES
        .iter()
        .filter(|(prefix, _, _)| id.starts_with(prefix))
        .max_by_key(|(prefix, _, _)| prefix.len())
        .map(|(_, minimum_tokens, extended_ttl)| Profile {
            minimum_tokens: *minimum_tokens,
            extended_ttl: *extended_ttl,
        })
}
pub fn supports_prompt_cache_breakpoints(route: &str, model: &str) -> bool {
    if ![
        "openai-chat",
        "openai-responses",
        "openai-responses-websocket",
        "openrouter",
        "openrouter-responses",
    ]
    .contains(&route)
    {
        return false;
    }
    let id = model.to_lowercase();
    if id.rsplit('/').next() == Some("gpt-daybreak-blue-latest") {
        return true;
    }
    let Some(version) = id
        .split('/')
        .find_map(|segment| segment.strip_prefix("gpt-"))
    else {
        return false;
    };
    let major: String = version.chars().take_while(char::is_ascii_digit).collect();
    let rest = &version[major.len()..];
    let minor = rest
        .strip_prefix('.')
        .unwrap_or("")
        .chars()
        .take_while(char::is_ascii_digit)
        .collect::<String>()
        .parse::<u32>()
        .unwrap_or(0);
    major
        .parse::<u32>()
        .is_ok_and(|major| major > 5 || major == 5 && minor >= 6)
}
fn gpt_options(request: &Request) -> Option<JsonValue> {
    let raw = request
        .provider_options
        .as_ref()
        .and_then(|options| json::get(options, "openai"))
        .and_then(|options| json::get(options, "promptCacheOptions"))
        .filter(|options| matches!(options, JsonValue::Object(_)))?;
    let mode = json::get(raw, "mode")
        .and_then(json::text)
        .filter(|mode| matches!(*mode, "implicit" | "explicit"));
    let ttl = json::get(raw, "ttl")
        .and_then(json::text)
        .filter(|ttl| *ttl == "30m");
    if mode.is_none() && ttl.is_none() {
        return None;
    }
    let mut result = json::empty();
    if let Some(mode) = mode {
        json::set(&mut result, "mode", json::s(mode));
    }
    if let Some(ttl) = ttl {
        json::set(&mut result, "ttl", json::s(ttl));
    }
    Some(result)
}
pub fn auto_placement_hint(request: &Request) -> Option<Hint> {
    if !["openrouter", "openrouter-responses"].contains(&request.model.route.id.as_str()) {
        return None;
    }
    match &request.cache {
        Policy::None => None,
        Policy::Auto => Some(Hint::ephemeral(None)),
        Policy::Explicit {
            tools,
            system,
            messages,
            ttl_seconds,
        } => {
            if *tools || *system || messages.is_some() {
                Some(Hint::ephemeral(*ttl_seconds))
            } else {
                None
            }
        }
    }
}
fn markable(part: &Part, gpt: bool) -> bool {
    match part {
        Part::Text(part) => json::nonblank(&part.text),
        Part::ToolResult(part) => {
            if !gpt {
                true
            } else if part.provider_executed == Some(true) {
                false
            } else {
                match &part.result { crate::llm::ToolResultValue::Content(content)=>content.iter().any(|part| matches!(part,ycoding_schema::llm::ToolContent::Text(part) if json::nonblank(&part.text))), crate::llm::ToolResultValue::Text(value)|crate::llm::ToolResultValue::Error(value)=>json::string(value).is_none_or(json::nonblank), _=>true }
            }
        }
        _ => false,
    }
}
pub fn apply(request: &mut Request) {
    let route = &request.model.route;
    let gpt = supports_prompt_cache_breakpoints(&route.id, request.model.id.as_str().unwrap_or(""));
    let inline = route.protocol.id() == "anthropic-messages"
        || [
            "ai-sdk:@ai-sdk/anthropic",
            "ai-sdk:@openrouter/ai-sdk-provider",
            "openrouter-responses",
            "ai-sdk:@openrouter/ai-sdk-provider:responses",
        ]
        .contains(&route.id.as_str())
        || (gpt && gpt_options(request).is_some());
    if !inline {
        return;
    }
    let (tools, system, strategy, ttl, auto) = match &request.cache {
        Policy::Auto => (true, true, Some(MessageStrategy::Tail(2)), None, true),
        Policy::None => (false, false, None, None, false),
        Policy::Explicit {
            tools,
            system,
            messages,
            ttl_seconds,
        } => (*tools, *system, messages.clone(), *ttl_seconds, false),
    };
    let prefix = Hint::ephemeral(
        if auto
            && profile(request.model.id.as_str().unwrap_or(""))
                .is_some_and(|profile| profile.extended_ttl)
        {
            Some(3600.0)
        } else {
            ttl
        },
    );
    let tail = Hint::ephemeral(ttl);
    let manual: Vec<_> = request
        .tools
        .iter()
        .enumerate()
        .filter_map(|(index, tool)| tool.cache.clone().map(|hint| ((0, index, 0), hint)))
        .chain(
            request
                .system
                .iter()
                .enumerate()
                .filter_map(|(index, part)| part.cache.clone().map(|hint| ((1, index, 0), hint))),
        )
        .chain(
            request
                .messages
                .iter()
                .enumerate()
                .flat_map(|(index, message)| {
                    message
                        .content
                        .iter()
                        .enumerate()
                        .filter_map(move |(part, value)| {
                            value.cache().cloned().map(|hint| ((2, index, part), hint))
                        })
                }),
        )
        .collect();
    let mut remaining = 4usize.saturating_sub(manual.len());
    let mut reserve = |position: (usize, usize, usize), hint: &Hint| {
        if gpt {
            return true;
        }
        if remaining == 0
            || manual.iter().any(|(other, value)| {
                if hint.one_hour() {
                    !value.one_hour() && *other < position
                } else {
                    value.one_hour() && *other > position
                }
            })
        {
            return false;
        }
        remaining -= 1;
        true
    };
    if tools
        && !gpt
        && let Some((index, tool)) = request.tools.iter_mut().enumerate().next_back()
        && tool.cache.is_none()
        && reserve((0, index, 0), &prefix)
    {
        tool.cache = Some(prefix.clone());
    }
    if system
        && let Some((index, part)) = request
            .system
            .iter_mut()
            .enumerate()
            .rfind(|(_, part)| json::nonblank(&part.text))
        && part.cache.is_none()
        && reserve((1, index, 0), &prefix)
    {
        part.cache = Some(prefix.clone());
    }
    let options = gpt_options(request);
    let implicit = gpt
        && options
            .as_ref()
            .and_then(|options| json::get(options, "mode"))
            .and_then(json::text)
            != Some("explicit");
    let volatile = implicit
        && options.is_some()
        && request
            .messages
            .last()
            .is_some_and(|message| message.volatile);
    if volatile {
        let patch = json::object([(
            "openai",
            json::object([(
                "promptCacheOptions",
                json::object([("mode", json::s("explicit"))]),
            )]),
        )]);
        request.provider_options = Some(json::merge(
            request.provider_options.as_ref().unwrap_or(&json::empty()),
            &patch,
        ));
    }
    let limit = if gpt {
        50usize.saturating_sub(
            usize::from(implicit && !volatile)
                + usize::from(request.system.iter().any(|part| part.cache.is_some())),
        )
    } else {
        usize::MAX
    };
    let assistant_allowed = !gpt || request.model.route.id == "openai-chat";
    let candidates: Vec<_> = request
        .messages
        .iter()
        .enumerate()
        .filter(|(_, message)| {
            !message.volatile
                && (!gpt
                    || message.role == Role::User
                    || message.role == Role::Tool
                    || assistant_allowed && message.role == Role::Assistant)
                && message.content.iter().any(|part| markable(part, gpt))
        })
        .map(|(index, _)| index)
        .collect();
    let mut selected = match strategy {
        None => Vec::new(),
        Some(MessageStrategy::LatestUser) => request
            .messages
            .iter()
            .rposition(|message| message.role == Role::User && !message.volatile)
            .into_iter()
            .collect(),
        Some(MessageStrategy::LatestAssistant) => request
            .messages
            .iter()
            .rposition(|message| message.role == Role::Assistant && !message.volatile)
            .into_iter()
            .collect(),
        Some(MessageStrategy::Tail(count)) => {
            let count = count.min(limit);
            if gpt {
                let prefix =
                    if !auto && count > 2 && count == limit && request.messages.len() > limit {
                        2
                    } else if !auto && count > 1 && request.messages.len() > limit {
                        1
                    } else {
                        0
                    };
                candidates
                    .iter()
                    .take(prefix)
                    .chain(
                        candidates
                            .iter()
                            .skip(candidates.len().saturating_sub(count - prefix)),
                    )
                    .copied()
                    .collect::<Vec<_>>()
            } else {
                let latest_assistant = request
                    .messages
                    .iter()
                    .rposition(|message| message.role == Role::Assistant);
                let mut selected = Vec::new();
                if count > 0 {
                    if let Some(last) = candidates.last() {
                        selected.push(*last);
                    }
                    if let Some(assistant) = latest_assistant
                        && let Some(previous) = candidates.iter().rfind(|index| **index < assistant)
                        && !selected.contains(previous)
                    {
                        selected.push(*previous);
                    }
                }
                for index in candidates.iter().rev() {
                    if selected.len() >= count {
                        break;
                    }
                    if !selected.contains(index) {
                        selected.push(*index);
                    }
                }
                selected.sort_unstable();
                if selected.len() > count {
                    selected.drain(..selected.len() - count);
                }
                selected
            }
        }
    };
    selected.sort_unstable();
    selected.dedup();
    for index in selected {
        let message = &mut request.messages[index];
        if message.volatile
            || gpt
                && !(message.role == Role::User
                    || message.role == Role::Tool
                    || assistant_allowed && message.role == Role::Assistant)
        {
            continue;
        }
        if let Some((part, value)) = message
            .content
            .iter_mut()
            .enumerate()
            .rfind(|(_, part)| markable(part, gpt))
            && value.cache().is_none()
            && reserve((2, index, part), &tail)
        {
            value.set_cache(Some(tail.clone()));
        }
    }
    if gpt {
        let positions: Vec<_> = request
            .messages
            .iter()
            .enumerate()
            .filter(|(_, message)| {
                matches!(message.role, Role::User | Role::Assistant | Role::Tool)
            })
            .flat_map(|(m, message)| {
                message
                    .content
                    .iter()
                    .enumerate()
                    .filter(|(_, part)| {
                        part.cache().is_some()
                            && (matches!(part, Part::Text(_)) || markable(part, true))
                    })
                    .map(move |(p, _)| (m, p))
            })
            .collect();
        if positions.len() > limit {
            let prefix = if limit > 2 {
                2
            } else if limit > 1 {
                1
            } else {
                0
            };
            let keep: Vec<_> = positions
                .iter()
                .take(prefix)
                .chain(positions.iter().skip(positions.len() - (limit - prefix)))
                .copied()
                .collect();
            for (m, p) in positions {
                if !keep.contains(&(m, p)) {
                    request.messages[m].content[p].set_cache(None);
                }
            }
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Capabilities {
    pub family: &'static str,
    pub generation: Option<u32>,
    pub minor: Option<u32>,
    pub adaptive_thinking: ThinkingMode,
    pub manual_thinking: bool,
    pub disable_thinking_max_effort: Option<&'static str>,
    pub effort: &'static [&'static str],
    pub default_only_sampling: bool,
    pub mid_conversation_system: bool,
    pub cache_minimum_tokens: Option<u32>,
    pub max_context_tokens: Option<u32>,
    pub max_output_tokens: Option<u32>,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ThinkingMode {
    Optional,
    Default,
    Required,
    Unsupported,
}
pub fn anthropic_capabilities(model: &LosslessString) -> Capabilities {
    let mut id = model.as_str().unwrap_or("").to_lowercase();
    if let Some((_, rest)) = id.rsplit_once("anthropic--") {
        id = rest.into();
    }
    if let Some(rest) = id
        .strip_prefix("anthropic/")
        .or_else(|| id.strip_prefix("anthropic."))
    {
        id = rest.into();
    }
    id = id.replace('.', "-");
    let segments: Vec<_> = id.split('-').collect();
    let parsed = (segments.first() == Some(&"claude")
        && segments
            .get(1)
            .is_some_and(|family| ["opus", "fable", "mythos", "sonnet", "haiku"].contains(family)))
    .then(|| segments.get(2).and_then(|value| value.parse::<u32>().ok()))
    .flatten();
    let family = if parsed.is_some() {
        match segments[1] {
            "opus" => "opus",
            "fable" => "fable",
            "mythos" => "mythos",
            "sonnet" => "sonnet",
            _ => "haiku",
        }
    } else {
        "unknown"
    };
    let minor = parsed.and_then(|_| segments.get(3).and_then(|value| value.parse::<u32>().ok()));
    let fifth = parsed == Some(5);
    let mut result = Capabilities {
        family,
        generation: parsed,
        minor,
        adaptive_thinking: if parsed.is_none() {
            ThinkingMode::Unsupported
        } else if fifth && ["fable", "mythos"].contains(&family) {
            ThinkingMode::Required
        } else if fifth {
            ThinkingMode::Default
        } else {
            ThinkingMode::Optional
        },
        manual_thinking: parsed.is_some() && !fifth,
        disable_thinking_max_effort: if fifth && family == "opus" {
            Some("high")
        } else {
            None
        },
        effort: if fifth {
            &["low", "medium", "high", "xhigh", "max"]
        } else {
            &[]
        },
        default_only_sampling: fifth
            || family == "opus" && parsed == Some(4) && minor.is_some_and(|minor| minor >= 7),
        mid_conversation_system: fifth && ["opus", "fable", "mythos"].contains(&family)
            || family == "opus" && parsed == Some(4) && minor == Some(8),
        cache_minimum_tokens: None,
        max_context_tokens: None,
        max_output_tokens: None,
    };
    if ["claude-opus-5", "claude-fable-5"].contains(&id.as_str()) {
        result.cache_minimum_tokens = Some(512);
        result.max_context_tokens = Some(1_000_000);
        result.max_output_tokens = Some(128_000);
    }
    result
}
