use super::{
    context_pressure::{estimate, estimate_json},
    js_pattern::Pattern,
    prompt_cache::sha256,
    summary_toon::{self, Confidence, Decision, DecisionStatus, Fact, Memory, ParseOptions},
};
use std::{future::Future, pin::Pin, sync::LazyLock};
use ycoding_schema::{JsonValue, session_message};

pub const SUMMARY_TEMPLATE: &str = "Output exactly one TOON document, and nothing else, rooted at conversation_memory.\n\nUse this exact field schema and order:\n\nconversation_memory:\n  version: 2\n  through_sequence: 0\n  objective: \"\"\n  in_progress: []\n  pending: []\n  blocked: []\n  decision: []\n  skill: []\n  requirements: []\n  acceptance_criteria: []\n  current_state: \"\"\n  facts: []\n  preferences: []\n  constraints: []\n  completed: []\n  unresolved: []\n  important_identifiers: []\n  continuation: \"\"\n\nReplace through_sequence with the exact supplied sequence. decision rows have { text, status }, where status is accepted, rejected, or superseded. facts rows have { text, confidence }, where confidence is confirmed, likely, or uncertain. Every other collection is a string array; use [] when there is no value. in_progress contains work actively underway, pending contains not-started next work, blocked contains work that cannot proceed and why, and skill contains active skill names plus any practices that must continue.\n\nKeep the memory terse and factual. Preserve still-true goals, constraints, decisions, exact facts, identifiers, paths, commands, errors, validation state, and remaining risks. Merge a supplied conversation_memory document with newer material and remove only details superseded by newer evidence. Emit no Markdown fences, prose, or commentary.";

pub const AUTHORITATIVE_STATE_PREFIX: &str = "Authoritative current Session state (JSON):";

const SOURCE_TEXT_MAX_CHARS: usize = 8_192;
const SOURCE_CAPSULE_MAX_CHARS: usize = 384;
const SKILL_TEXT_MAX_CHARS: usize = 2_048;
const SUMMARY_SCALAR_MAX_CHARS: usize = 2_048;

macro_rules! pattern {
    ($name:ident, $source:expr, $flags:expr) => {
        static $name: LazyLock<Pattern> = LazyLock::new(|| Pattern::new($source, $flags));
    };
}

pattern!(LINE_SPLIT, r"(?<=[.!?])\s+|\r?\n", "");
pattern!(SENTENCE_SPLIT, r"(?<=[.!?])\s+", "");
pattern!(OBJECTIVE_LINE, r"^objective\s*:", "i");
pattern!(REQUIREMENTS_LABEL, r"^requirements?\s*:", "i");
pattern!(
    REQUIREMENT_WORDS,
    r"\b(?:must|shall|required?|never|do not|should)\b",
    "i"
);
pattern!(CRITERIA_LABEL, r"^accept(?:ance)?[ _-]?criteria\s*:", "i");
pattern!(
    CRITERIA_WORDS,
    r"\b(?:accepted only when|acceptance criteria|expected behavior|passes?|verified?)\b",
    "i"
);
pattern!(
    PROGRESS_LABEL,
    r"^(?:progress|completed|validation|todo\s*\[in[_ -]?progress\])\s*:",
    "i"
);
pattern!(
    PROGRESS_WORDS,
    r"\b(?:in progress|implemented|investigated|confirmed|completed|passed|validated)\b",
    "i"
);
pattern!(
    PENDING_LABEL,
    r"^(?:pending|todo(?:\s*\[pending\])?|next action)\s*:",
    "i"
);
pattern!(
    PENDING_WORDS,
    r"\b(?:next|pending|remaining|awaits?|still needs?)\b",
    "i"
);
pattern!(BLOCKER_LABEL, r"^blockers?\s*:", "i");
pattern!(
    BLOCKER_WORDS,
    r"\b(?:blocked|blocker|broke|failed|error)\b",
    "i"
);
pattern!(SKILL_LABEL, r"^active skill\s*:", "i");
pattern!(
    DECISION_LABEL,
    r"^(accepted|rejected|superseded) decision\s*:",
    "i"
);
pattern!(
    DECISION_WORDS,
    r"\b(?:we |was )?(?:chose|decided|selected)\b",
    "i"
);
pattern!(
    CONSTRAINT_WORDS,
    r"\b(?:constraint|without|do not|never|must not|no external)\b",
    "i"
);
pattern!(
    COMPLETED_WORDS,
    r"\b(?:completed|passed|confirmed|validated)\b",
    "i"
);
pattern!(
    UNRESOLVED_WORDS,
    r"\b(?:unresolved|unknown|unclear|question)\b",
    "i"
);
pattern!(NEXT_WORD, r"\bnext\b", "i");
pattern!(TICKET, r"\b[A-Z][A-Z0-9]+-\d+\b", "g");
pattern!(PATH, r#"(?:^|\s)(\/(?:[^\s"'`,]+\/?)+)"#, "g");
pattern!(WHITESPACE, r"\s+", "g");
pattern!(WORD, r"[a-z0-9_-]+", "g");
pattern!(DATA_URL, r"data:[^;\s]+;base64,[A-Za-z0-9+/=\s]+", "gi");
pattern!(DATA_PREFIX, r"^data:[^;]+;base64,", "i");
pattern!(BASE64_BODY, r"^[A-Za-z0-9+/=\s]+$", "");
pattern!(
    CONTINUE_SESSION,
    r"^continue (?:the )?(?:current )?session",
    ""
);
pattern!(USE_CHECKPOINT, r"^use the checkpoint", "");

#[derive(Clone, Debug, PartialEq)]
pub struct Source {
    pub message_id: session_message::Id,
    pub terminal_seq: i64,
    pub digest: String,
    pub prompt: String,
    pub extract: String,
    pub capsule: String,
}

impl Source {
    pub fn new(
        message_id: session_message::Id,
        terminal_seq: i64,
        kind: &str,
        message: Option<&session_message::Info>,
        payload: &JsonValue,
    ) -> Self {
        let extract = source_text(message, payload);
        let prompt = format!(
            "{{\"sequence\":{terminal_seq},\"kind\":{},\"content\":{}}}",
            json_string(kind),
            json_string(&extract)
        );
        let capsule = source_capsule(terminal_seq, kind, &extract);
        Self {
            message_id,
            terminal_seq,
            digest: super::context_manifest::payload_digest(payload),
            prompt,
            extract,
            capsule,
        }
    }
}

pub struct Settings<'a> {
    pub max_calls: i64,
    pub max_bytes: usize,
    pub max_input_tokens: i64,
    pub accepts: &'a (dyn Fn(&str, i64) -> bool + Sync),
    pub required_texts: Vec<String>,
    pub required_skills: Vec<String>,
    pub previous: Option<Memory>,
}

pub type Generate<'a> =
    &'a (dyn Fn(String) -> Pin<Box<dyn Future<Output = Option<String>> + Send + 'a>> + Sync);

pub async fn generate(
    source: &[Source],
    settings: &Settings<'_>,
    attempt: Option<Generate<'_>>,
) -> Option<String> {
    let last = source.last()?.terminal_seq;
    let mut cursor = 0;
    let mut memory = settings.previous.clone().map(without_skills);
    let mut summary = memory.as_ref().map(summary_toon::encode);
    let mut calls = 0;
    while cursor < source.len() {
        let prefix = fit_prefix(
            source,
            cursor,
            summary.as_deref(),
            settings.max_input_tokens,
        );
        if prefix.count == 0 {
            let remaining = extracts(&source[cursor..]);
            let candidate = fallback_checkpoint(&remaining, last, settings, memory.as_ref());
            return finalize(source, settings, &candidate);
        }
        let batch = extracts(&source[cursor..cursor + prefix.count]);
        let fallback = fallback_checkpoint(&batch, prefix.through, settings, memory.as_ref());
        let Some(attempt) = attempt.filter(|_| calls < settings.max_calls) else {
            memory = parsed_memory(&fallback, prefix.through).or(memory);
            summary = Some(memory.as_ref().map_or(fallback, summary_toon::encode));
            cursor += prefix.count;
            continue;
        };
        calls += 1;
        let Some(generated) = attempt(summary_prompt(
            summary.as_deref(),
            &prefix.text,
            prefix.through,
        ))
        .await
        else {
            return local(source, settings, memory.as_ref());
        };
        let next = parsed_memory(&generated, prefix.through)
            .or_else(|| parsed_memory(&fallback, prefix.through));
        memory = match next {
            Some(next) => Some(merge_memory(memory.as_ref(), next, prefix.through)),
            None => memory,
        };
        summary = Some(memory.as_ref().map_or(fallback, summary_toon::encode));
        cursor += prefix.count;
    }
    let candidate = summary
        .unwrap_or_else(|| fallback_checkpoint(&[], last, settings, settings.previous.as_ref()));
    finalize(source, settings, &candidate)
}

pub fn local(
    source: &[Source],
    settings: &Settings<'_>,
    memory: Option<&Memory>,
) -> Option<String> {
    let last = source.last()?.terminal_seq;
    let candidate = fallback_checkpoint(&extracts(source), last, settings, memory);
    finalize(source, settings, &candidate)
}

pub fn finalize(source: &[Source], settings: &Settings<'_>, candidate: &str) -> Option<String> {
    let through = source.last()?.terminal_seq;
    if let Ok(parsed) = summary_toon::parse(
        candidate,
        &ParseOptions {
            through_sequence: through,
        },
    ) && let Some(repaired) = validate_checkpoint(source, settings, Some(&parsed), through)
    {
        return Some(repaired);
    }
    validate_checkpoint(source, settings, settings.previous.as_ref(), through)
}

pub fn checkpoint_memory(seq: i64, message: &session_message::Info) -> Option<Memory> {
    let session_message::Info::Synthetic(synthetic) = message else {
        return None;
    };
    if !synthetic
        .id
        .as_lossless()
        .to_utf8()
        .unwrap_or_default()
        .starts_with("msg_compaction_")
    {
        return None;
    }
    let text = synthetic.text.to_utf8().ok()?;
    let start = text.find("<summary>\n")? + "<summary>\n".len();
    let end = text[start..].rfind("\n</summary>")? + start;
    summary_toon::parse(
        &text[start..end],
        &ParseOptions {
            through_sequence: seq,
        },
    )
    .ok()
}

pub fn skill_text(
    name: &str,
    id: &str,
    activated_by: &str,
    message: &str,
    content: &str,
) -> String {
    bounded_text(
        &[
            format!("Active skill: {name} ({id})."),
            format!("Active because: activated by {activated_by} at message {message}."),
            "Current practices and routing boundaries:".into(),
            content.to_string(),
        ]
        .join("\n"),
        SKILL_TEXT_MAX_CHARS,
    )
}

pub fn supersedes_authority(existing: &str, incoming: &str) -> bool {
    existing.starts_with(AUTHORITATIVE_STATE_PREFIX)
        && incoming.starts_with(AUTHORITATIVE_STATE_PREFIX)
}

fn extracts(source: &[Source]) -> Vec<String> {
    source.iter().map(|entry| entry.extract.clone()).collect()
}

fn without_skills(memory: Memory) -> Memory {
    Memory {
        skill: Vec::new(),
        ..memory
    }
}

fn parsed_memory(text: &str, through: i64) -> Option<Memory> {
    summary_toon::parse(
        text,
        &ParseOptions {
            through_sequence: through,
        },
    )
    .ok()
}

fn validate_checkpoint(
    source: &[Source],
    settings: &Settings<'_>,
    memory: Option<&Memory>,
    through: i64,
) -> Option<String> {
    let refreshed = memory.map(|memory| {
        summary_toon::retain_required_texts(
            without_skills(memory.clone()),
            &settings.required_texts,
            Some(&supersedes_authority),
        )
    });
    let continuity =
        retain_local_continuity(&extracts(source), through, settings, refreshed.as_ref());
    let required = summary_toon::retain_required_texts(
        continuity,
        &settings.required_texts,
        Some(&supersedes_authority),
    );
    let coverage = source
        .iter()
        .map(|entry| Fact {
            text: entry.capsule.clone(),
            confidence: Confidence::Confirmed,
        })
        .collect::<Vec<_>>();
    let mut skills = Vec::<String>::new();
    for skill in &settings.required_skills {
        if !skills.contains(skill) {
            skills.push(skill.clone());
        }
    }
    let mut facts = required
        .facts
        .iter()
        .filter(|fact| !coverage.iter().any(|item| item.text == fact.text))
        .cloned()
        .collect::<Vec<_>>();
    facts.extend(coverage);
    let encoded = summary_toon::encode(&Memory {
        facts,
        skill: skills,
        ..required
    });
    let parsed = summary_toon::parse(
        &encoded,
        &ParseOptions {
            through_sequence: through,
        },
    )
    .ok()?;
    let canonical = summary_toon::encode(&parsed);
    (settings.accepts)(&canonical, through).then_some(canonical)
}

struct Prefix {
    count: usize,
    text: String,
    through: i64,
}

fn fit_prefix(
    source: &[Source],
    cursor: usize,
    previous: Option<&str>,
    max_input_tokens: i64,
) -> Prefix {
    let remaining = &source[cursor..];
    let join = |count: usize| {
        remaining[..count]
            .iter()
            .map(|entry| entry.prompt.as_str())
            .collect::<Vec<_>>()
            .join("\n\n")
    };
    let through = |count: usize| {
        count
            .checked_sub(1)
            .map_or(0, |index| remaining[index].terminal_seq)
    };
    let mut lower = 0usize;
    let mut upper = remaining.len();
    while lower < upper {
        let middle = (lower + upper).div_ceil(2);
        if summary_input_tokens(previous, &join(middle), through(middle)) <= max_input_tokens {
            lower = middle;
        } else {
            upper = middle - 1;
        }
    }
    Prefix {
        count: lower,
        text: join(lower),
        through: through(lower),
    }
}

fn summary_prompt(previous: Option<&str>, material: &str, through: i64) -> String {
    [
        match previous {
            Some(previous) => format!(
                "Update the conversation memory below with the new material.\n<previous-conversation-memory>\n{previous}\n</previous-conversation-memory>"
            ),
            None => "Create a conversation memory from the conversation history.".into(),
        },
        format!("The new material covers message sequences up to and including {through}."),
        "The following is the conversation material:".into(),
        material.to_string(),
    ]
    .join("\n\n")
}

fn summary_input_tokens(previous: Option<&str>, material: &str, through: i64) -> i64 {
    estimate(&format!(
        "{SUMMARY_TEMPLATE}\n\n{}",
        summary_prompt(previous, material, through)
    ))
}

fn fallback_checkpoint(
    source: &[String],
    through: i64,
    settings: &Settings<'_>,
    previous: Option<&Memory>,
) -> String {
    let memory = retain_local_continuity(source, through, settings, previous);
    let minimal = summary_toon::encode(&memory);
    if minimal.len() > settings.max_bytes || !(settings.accepts)(&minimal, through) {
        return minimal;
    }
    let newest = source
        .iter()
        .rev()
        .find(|value| !value.trim().is_empty())
        .cloned()
        .unwrap_or_default();
    let characters = newest.chars().collect::<Vec<_>>();
    let current_state = |tail: &str| {
        [memory.current_state.as_str(), tail]
            .into_iter()
            .filter(|part| !part.is_empty())
            .collect::<Vec<_>>()
            .join("\n")
    };
    let tail = |count: usize| {
        characters[characters.len() - count..]
            .iter()
            .collect::<String>()
    };
    let mut lower = 0usize;
    let mut upper = characters.len();
    while lower < upper {
        let middle = (lower + upper).div_ceil(2);
        let encoded = summary_toon::encode(&Memory {
            current_state: current_state(&tail(middle)),
            ..memory.clone()
        });
        if encoded.len() <= settings.max_bytes && (settings.accepts)(&encoded, through) {
            lower = middle;
        } else {
            upper = middle - 1;
        }
    }
    summary_toon::encode(&Memory {
        current_state: current_state(&tail(lower)),
        ..memory
    })
}

fn units(text: &str) -> usize {
    text.encode_utf16().count()
}

fn last_matching(lines: &[String], keep: impl Fn(&str) -> bool) -> Option<&String> {
    lines.iter().rev().find(|line| keep(line))
}

fn last_n(lines: &[String], count: usize, keep: impl Fn(&str) -> bool) -> Vec<String> {
    let matched = lines
        .iter()
        .filter(|line| keep(line))
        .cloned()
        .collect::<Vec<_>>();
    matched[matched.len().saturating_sub(count)..].to_vec()
}

fn append(values: &mut Vec<String>, value: &str) {
    if !values.iter().any(|existing| existing == value) {
        values.push(value.to_string());
    }
}

enum Include {
    Objective(String),
    CurrentState(String),
    Requirement(String),
    Criterion(String),
    Pending(String),
    Decision(Decision),
    Blocked(String),
    Skill(String),
    InProgress(String),
    Constraint(String),
    Completed(String),
    Unresolved(String),
    Identifier(String),
    Continuation(String),
}

impl Include {
    fn apply(&self, memory: &Memory) -> Memory {
        let mut next = memory.clone();
        match self {
            Self::Objective(text) => {
                next.objective = merge_meaningful_scalar(&memory.objective, text)
            }
            Self::CurrentState(text) => {
                next.current_state = merge_scalar(&memory.current_state, text)
            }
            Self::Requirement(text) => append(&mut next.requirements, text),
            Self::Criterion(text) => append(&mut next.acceptance_criteria, text),
            Self::Pending(text) => append(&mut next.pending, text),
            Self::Decision(decision) => {
                if !memory.decision.contains(decision) {
                    next.decision.push(decision.clone());
                }
            }
            Self::Blocked(text) => append(&mut next.blocked, text),
            Self::Skill(text) => append(&mut next.skill, text),
            Self::InProgress(text) => append(&mut next.in_progress, text),
            Self::Constraint(text) => append(&mut next.constraints, text),
            Self::Completed(text) => append(&mut next.completed, text),
            Self::Unresolved(text) => append(&mut next.unresolved, text),
            Self::Identifier(text) => append(&mut next.important_identifiers, text),
            Self::Continuation(text) => next.continuation = text.clone(),
        }
        next
    }
}

fn retain_local_continuity(
    source: &[String],
    through: i64,
    settings: &Settings<'_>,
    previous: Option<&Memory>,
) -> Memory {
    let mut lines = Vec::<String>::new();
    for line in source
        .iter()
        .flat_map(|text| LINE_SPLIT.split(text))
        .map(|line| line.trim().to_string())
    {
        if !line.is_empty() && units(&line) <= 512 && !lines.contains(&line) {
            lines.push(line);
        }
    }
    let objective = last_matching(&lines, |line| OBJECTIVE_LINE.is_match(line))
        .or_else(|| lines.first())
        .cloned();
    let current_state = last_matching(&lines, |line| line != "…").cloned();
    let requirements = last_n(&lines, 8, |line| {
        REQUIREMENTS_LABEL.is_match(line) || REQUIREMENT_WORDS.is_match(line)
    });
    let criteria = last_n(&lines, 8, |line| {
        CRITERIA_LABEL.is_match(line) || CRITERIA_WORDS.is_match(line)
    });
    let progress = last_n(&lines, 8, |line| {
        PROGRESS_LABEL.is_match(line) || PROGRESS_WORDS.is_match(line)
    });
    let pending = last_n(&lines, 8, |line| {
        PENDING_LABEL.is_match(line) || PENDING_WORDS.is_match(line)
    });
    let blockers = last_n(&lines, 8, |line| {
        BLOCKER_LABEL.is_match(line) || BLOCKER_WORDS.is_match(line)
    });
    let skills = last_n(&lines, 4, |line| SKILL_LABEL.is_match(line));
    let decisions = {
        let decisions = lines
            .iter()
            .filter_map(|line| {
                let labelled = DECISION_LABEL
                    .captures(line)
                    .and_then(|captures| captures.get(1).cloned().flatten())
                    .map(|status| status.to_lowercase());
                let inferred = DECISION_WORDS
                    .is_match(line)
                    .then(|| "accepted".to_string());
                let status = DecisionStatus::parse(&labelled.or(inferred)?)?;
                Some(Decision {
                    text: line.clone(),
                    status,
                })
            })
            .collect::<Vec<_>>();
        decisions[decisions.len().saturating_sub(8)..].to_vec()
    };
    let constraints = last_n(&lines, 8, |line| CONSTRAINT_WORDS.is_match(line));
    let completed = last_n(&lines, 8, |line| COMPLETED_WORDS.is_match(line));
    let unresolved = last_n(&lines, 8, |line| UNRESOLVED_WORDS.is_match(line));
    let identifiers = {
        let mut found = Vec::<String>::new();
        for text in source {
            let values = TICKET.find_all(text).into_iter().chain(
                PATH.find_all(text)
                    .into_iter()
                    .map(|value| value.trim().to_string()),
            );
            for value in values {
                if !found.contains(&value) {
                    found.push(value);
                }
            }
        }
        found[found.len().saturating_sub(16)..].to_vec()
    };
    let continuation = last_matching(&pending, |text| NEXT_WORD.is_match(text))
        .or_else(|| pending.last())
        .cloned();
    let mut candidates = Vec::<Include>::new();
    candidates.extend(objective.map(Include::Objective));
    candidates.extend(current_state.map(Include::CurrentState));
    candidates.extend(requirements.into_iter().map(Include::Requirement));
    candidates.extend(criteria.into_iter().map(Include::Criterion));
    candidates.extend(pending.iter().cloned().map(Include::Pending));
    candidates.extend(decisions.into_iter().map(Include::Decision));
    candidates.extend(blockers.into_iter().map(Include::Blocked));
    candidates.extend(skills.into_iter().map(Include::Skill));
    candidates.extend(progress.into_iter().map(Include::InProgress));
    candidates.extend(constraints.into_iter().map(Include::Constraint));
    candidates.extend(completed.into_iter().map(Include::Completed));
    candidates.extend(unresolved.into_iter().map(Include::Unresolved));
    candidates.extend(identifiers.into_iter().map(Include::Identifier));
    candidates.extend(continuation.map(Include::Continuation));
    let initial = previous
        .map(|memory| Memory {
            through_sequence: through,
            ..memory.clone()
        })
        .filter(|memory| summary_toon::encode(memory).len() <= settings.max_bytes)
        .unwrap_or_else(|| empty_checkpoint(through));
    candidates.iter().fold(initial, |memory, include| {
        let candidate = include.apply(&memory);
        let encoded = summary_toon::encode(&candidate);
        if encoded.len() <= settings.max_bytes && (settings.accepts)(&encoded, through) {
            candidate
        } else {
            memory
        }
    })
}

fn empty_checkpoint(through: i64) -> Memory {
    Memory {
        through_sequence: through,
        objective: "Continue the current session from the retained state.".into(),
        in_progress: Vec::new(),
        pending: Vec::new(),
        blocked: Vec::new(),
        decision: Vec::new(),
        skill: Vec::new(),
        requirements: Vec::new(),
        acceptance_criteria: Vec::new(),
        current_state: String::new(),
        facts: Vec::new(),
        preferences: Vec::new(),
        constraints: Vec::new(),
        completed: Vec::new(),
        unresolved: Vec::new(),
        important_identifiers: Vec::new(),
        continuation:
            "Use the checkpoint and later messages; ask the user if omitted detail is required."
                .into(),
    }
}

fn merge_memory(previous: Option<&Memory>, current: Memory, through: i64) -> Memory {
    let Some(previous) = previous else {
        return Memory {
            through_sequence: through,
            skill: Vec::new(),
            ..current
        };
    };
    let strings = |left: &[String], right: &[String]| {
        let mut merged = Vec::<String>::new();
        for value in left.iter().chain(right) {
            if !merged.contains(value) {
                merged.push(value.clone());
            }
        }
        merged
    };
    let mut facts = Vec::<Fact>::new();
    for fact in previous.facts.iter().chain(&current.facts) {
        if !facts.iter().any(|existing| existing.text == fact.text) {
            facts.push(fact.clone());
        }
    }
    let all_decisions = previous
        .decision
        .iter()
        .chain(&current.decision)
        .collect::<Vec<_>>();
    let decisions = all_decisions
        .iter()
        .enumerate()
        .filter(|(index, decision)| {
            all_decisions
                .iter()
                .rposition(|candidate| candidate.text == decision.text)
                == Some(*index)
        })
        .map(|(_, decision)| (*decision).clone())
        .collect();
    Memory {
        through_sequence: through,
        objective: merge_meaningful_scalar(&previous.objective, &current.objective),
        requirements: strings(&previous.requirements, &current.requirements),
        acceptance_criteria: strings(&previous.acceptance_criteria, &current.acceptance_criteria),
        in_progress: strings(&previous.in_progress, &current.in_progress),
        current_state: merge_scalar(&previous.current_state, &current.current_state),
        facts,
        decision: decisions,
        preferences: strings(&previous.preferences, &current.preferences),
        constraints: strings(&previous.constraints, &current.constraints),
        completed: strings(&previous.completed, &current.completed),
        pending: strings(&previous.pending, &current.pending),
        blocked: strings(&previous.blocked, &current.blocked),
        skill: Vec::new(),
        unresolved: strings(&previous.unresolved, &current.unresolved),
        important_identifiers: strings(
            &previous.important_identifiers,
            &current.important_identifiers,
        ),
        continuation: if useful_scalar(&current.continuation) {
            current.continuation
        } else {
            previous.continuation.clone()
        },
    }
}

fn merge_scalar(previous: &str, current: &str) -> String {
    if previous.trim().is_empty() {
        return current.to_string();
    }
    if current.trim().is_empty() || previous == current {
        return previous.to_string();
    }
    format!("{previous}\n{current}")
}

fn merge_meaningful_scalar(previous: &str, current: &str) -> String {
    if !useful_scalar(previous) {
        return current.to_string();
    }
    if !useful_scalar(current) {
        return previous.to_string();
    }
    bounded_text(&merge_scalar(previous, current), SUMMARY_SCALAR_MAX_CHARS)
}

fn useful_scalar(value: &str) -> bool {
    let normalized = value.trim().to_lowercase();
    !normalized.is_empty()
        && normalized != "…"
        && !CONTINUE_SESSION.is_match(&normalized)
        && !USE_CHECKPOINT.is_match(&normalized)
}

fn source_text(message: Option<&session_message::Info>, payload: &JsonValue) -> String {
    let Some(message) = message else {
        return bounded_text(
            &semantic_values(payload, None, 0).join("\n"),
            SOURCE_TEXT_MAX_CHARS,
        );
    };
    match message {
        session_message::Info::Skill(skill) => format!(
            "Skill activation: {} ({}).",
            lossless(&skill.name),
            lossless(&skill.skill)
        ),
        session_message::Info::User(user) => {
            bounded_text(&lossless(&user.text), SOURCE_TEXT_MAX_CHARS)
        }
        session_message::Info::Synthetic(synthetic) => {
            bounded_text(&lossless(&synthetic.text), SOURCE_TEXT_MAX_CHARS)
        }
        session_message::Info::System(system) => {
            bounded_text(&lossless(&system.text), SOURCE_TEXT_MAX_CHARS)
        }
        session_message::Info::Assistant(assistant) => bounded_text(
            &assistant
                .content
                .iter()
                .flat_map(assistant_values)
                .collect::<Vec<_>>()
                .join("\n"),
            SOURCE_TEXT_MAX_CHARS,
        ),
        session_message::Info::Shell(shell) => {
            let mut lines = vec![
                format!("Command: {}", lossless(&shell.command)),
                format!("Status: {}", shell.status.as_str()),
            ];
            if let Some(exit) = shell.exit {
                lines.push(format!("Exit: {}", number(exit)));
            }
            bounded_text(&lines.join("\n"), SOURCE_TEXT_MAX_CHARS)
        }
        _ => bounded_text(
            &semantic_values(payload, None, 0).join("\n"),
            SOURCE_TEXT_MAX_CHARS,
        ),
    }
}

fn assistant_values(part: &session_message::AssistantContent) -> Vec<String> {
    let tool = match part {
        session_message::AssistantContent::Text(text) => return vec![lossless(&text.text)],
        session_message::AssistantContent::Reasoning(reasoning) => {
            return vec![lossless(&reasoning.text)];
        }
        session_message::AssistantContent::Tool(tool) => tool,
    };
    let (status, input, rest) = match &tool.state {
        session_message::ToolState::Streaming(state) => (
            "streaming",
            semantic_values(&JsonValue::String(state.input.clone()), None, 0),
            Vec::new(),
        ),
        session_message::ToolState::Running(state) => (
            "running",
            semantic_values(&JsonValue::Object(state.input.clone()), None, 0),
            tool_content(&state.content, &state.structured, None, None),
        ),
        session_message::ToolState::Completed(state) => (
            "completed",
            semantic_values(&JsonValue::Object(state.input.clone()), None, 0),
            tool_content(
                &state.content,
                &state.structured,
                state.result.as_ref(),
                None,
            ),
        ),
        session_message::ToolState::Error(state) => (
            "error",
            semantic_values(&JsonValue::Object(state.input.clone()), None, 0),
            tool_content(
                &state.content,
                &state.structured,
                state.result.as_ref(),
                Some(&state.error),
            ),
        ),
    };
    let mut values = vec![format!("Tool {}: {status}.", lossless(&tool.name))];
    values.extend(input);
    values.extend(rest);
    values
}

fn tool_content(
    content: &[ycoding_schema::llm::ToolContent],
    structured: &ycoding_schema::JsonObject,
    result: Option<&JsonValue>,
    error: Option<&ycoding_schema::session_error::Error>,
) -> Vec<String> {
    let mut values = content
        .iter()
        .map(|content| match content {
            ycoding_schema::llm::ToolContent::Text(text) => lossless(&text.text),
            ycoding_schema::llm::ToolContent::File(file) => format!(
                "Artifact {}",
                file.name
                    .as_ref()
                    .map_or_else(|| lossless(&file.uri), lossless)
            ),
        })
        .collect::<Vec<_>>();
    values.extend(semantic_values(
        &JsonValue::Object(structured.clone()),
        None,
        0,
    ));
    if let Some(result) = result {
        values.extend(semantic_values(result, None, 0));
    }
    if let Some(error) = error {
        values.push(lossless(&error.message));
    }
    values
}

fn semantic_values(value: &JsonValue, key: Option<&str>, depth: usize) -> Vec<String> {
    if depth > 3 {
        return Vec::new();
    }
    match value {
        JsonValue::Null => Vec::new(),
        JsonValue::String(text) => {
            let text = lossless(text);
            if looks_binary(&text)
                || matches!(key, Some("state" | "providerState" | "providerResultState"))
            {
                return Vec::new();
            }
            let bounded = bounded_text(&text, 2_048);
            if bounded.trim().is_empty() {
                return Vec::new();
            }
            vec![key.map_or_else(|| bounded.clone(), |key| format!("{key}: {bounded}"))]
        }
        JsonValue::Number(value) => {
            key.map_or_else(Vec::new, |key| vec![format!("{key}: {}", number(*value))])
        }
        JsonValue::Bool(value) => key.map_or_else(Vec::new, |key| vec![format!("{key}: {value}")]),
        JsonValue::Array(items) => items
            .iter()
            .flat_map(|item| semantic_values(item, key, depth + 1))
            .take(24)
            .collect(),
        JsonValue::Object(object) => object
            .iter()
            .filter(|(name, _)| {
                !matches!(
                    name.as_str(),
                    Some(
                        "metadata"
                            | "tokens"
                            | "diagnostics"
                            | "time"
                            | "providerState"
                            | "providerResultState"
                    )
                )
            })
            .flat_map(|(name, item)| semantic_values(item, Some(&lossless(name)), depth + 1))
            .take(32)
            .collect(),
    }
}

fn looks_binary(value: &str) -> bool {
    DATA_PREFIX.is_match(value) || (units(value) > 1_024 && BASE64_BODY.is_match(value))
}

pub fn bounded_text(value: &str, max_characters: usize) -> String {
    let sanitized = DATA_URL
        .replace_all(value, "[binary omitted]")
        .replace('\0', "");
    let sanitized = sanitized.trim();
    let characters = sanitized.chars().collect::<Vec<_>>();
    if characters.len() <= max_characters {
        return sanitized.to_string();
    }
    if max_characters <= 3 {
        return characters[..max_characters].iter().collect();
    }
    let content = max_characters - 3;
    let head = (content as f64 * 0.75).floor() as usize;
    let tail = content - head;
    format!(
        "{}\n…\n{}",
        characters[..head].iter().collect::<String>(),
        characters[characters.len() - tail..]
            .iter()
            .collect::<String>()
    )
}

fn source_capsule(terminal_seq: i64, kind: &str, extract: &str) -> String {
    let normalized = WHITESPACE.replace_all(extract, " ");
    let prefix = format!("[source sequence={terminal_seq} kind={kind}]");
    let budget = SOURCE_CAPSULE_MAX_CHARS - prefix.chars().count() - 1;
    let digest = format!("sha256={}", sha256(&normalized));
    let content = if normalized.chars().count() > budget {
        format!(
            "{} {digest}",
            bounded_text(
                &salient_source_text(&normalized),
                budget - digest.chars().count() - 1
            )
        )
    } else if normalized.is_empty() {
        "No textual payload.".to_string()
    } else {
        normalized
    };
    format!("{prefix} {content}")
}

fn salient_source_text(value: &str) -> String {
    let mut sentences = Vec::<String>::new();
    for sentence in SENTENCE_SPLIT.split(value).iter().map(|part| part.trim()) {
        if !sentence.is_empty() && !sentences.iter().any(|existing| existing == sentence) {
            sentences.push(sentence.to_string());
        }
    }
    let kept = sentences
        .into_iter()
        .filter(|sentence| {
            let words = WORD.find_all(&sentence.to_lowercase());
            let mut distinct = words.clone();
            distinct.sort();
            distinct.dedup();
            words.len() < 8 || distinct.len() as f64 / words.len() as f64 >= 0.25
        })
        .collect::<Vec<_>>()
        .join(" ");
    if kept.is_empty() {
        "Repetitive source payload omitted.".into()
    } else {
        kept
    }
}

fn lossless(value: &ycoding_schema::LosslessString) -> String {
    value.to_utf8().unwrap_or_default()
}

fn number(value: f64) -> String {
    if value.fract() == 0.0 && value.abs() < 1e21 {
        format!("{}", value as i64)
    } else {
        value.to_string()
    }
}

fn json_string(value: &str) -> String {
    ycoding_schema::stringify_json(&JsonValue::String(value.into()))
}

pub fn input_tokens(messages: &[session_message::Info]) -> i64 {
    use ycoding_schema::DomainEncode;
    estimate_json(&JsonValue::Array(
        messages.iter().map(DomainEncode::encode).collect(),
    ))
}
