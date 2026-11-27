use super::{
    Error, edit,
    format::{self, Concept},
    okf::{self, Diagnostic, Level, Status, diagnostic},
};
use chrono::{DateTime, Utc};
use std::collections::BTreeSet;
use yaml_rust2::Yaml;

pub fn producer() -> String {
    format!("ycoding/{}", env!("CARGO_PKG_VERSION"))
}

pub struct Authoring<'a> {
    pub now: DateTime<Utc>,
    pub allow_human_actor: bool,
    pub before: Option<&'a Concept>,
    pub others: &'a [Concept],
}
pub struct Draft {
    pub content: String,
    pub duplicate_of: Option<String>,
    pub advice: Vec<Diagnostic>,
}

pub fn prepare(id: &str, content: &str, authoring: &Authoring<'_>) -> Result<Draft, Error> {
    format::require_id(id)?;
    let proposed = format::parse(id, content, authoring.now)?;
    if let Some(reason) = credential(content) {
        return Err(Error::Rejected(reason));
    }
    if super::experience::is(&proposed.summary.meta.type_) {
        super::experience::validate(&proposed)?;
    }
    guard_trust(&proposed, authoring)?;
    let content = stamp(content, &proposed, authoring)?;
    let duplicate_of = match authoring.before {
        Some(_) => None,
        None => duplicate(&proposed, authoring.others),
    };
    let finished = format::parse(id, &content, authoring.now)?;
    let mut advice = super::templates::advise(&finished);
    advice.extend(exposure(&content));
    Ok(Draft {
        content,
        duplicate_of,
        advice,
    })
}

fn guard_trust(proposed: &Concept, authoring: &Authoring<'_>) -> Result<(), Error> {
    let known = authoring
        .before
        .map(|before| before.summary.meta.verified.clone())
        .unwrap_or_default();
    for event in &proposed.summary.meta.verified {
        if known.contains(event) {
            continue;
        }
        if !(authoring.allow_human_actor && okf::is_human(&event.by) && event.at <= authoring.now) {
            return Err(Error::Rejected("verified-requires-evidence"));
        }
    }
    let previous_by = authoring
        .before
        .and_then(|before| before.summary.meta.generated.as_ref())
        .map(|generated| generated.by.as_str());
    let claimed = proposed
        .summary
        .meta
        .generated
        .as_ref()
        .map(|generated| generated.by.as_str())
        .into_iter()
        .chain(
            proposed
                .summary
                .meta
                .verified
                .iter()
                .map(|event| event.by.as_str()),
        )
        .filter(|by| okf::claims_human(by));
    for by in claimed {
        let existing = previous_by == Some(by)
            || authoring.before.is_some_and(|before| {
                before
                    .summary
                    .meta
                    .verified
                    .iter()
                    .any(|event| event.by == by)
            });
        if !existing && !authoring.allow_human_actor {
            return Err(Error::Rejected("human-actor-unconfirmed"));
        }
        if !okf::is_human(by) {
            return Err(Error::Rejected("human-actor-malformed"));
        }
    }
    Ok(())
}

fn without_stamps(concept: &Concept) -> Yaml {
    match &concept.doc.yaml {
        Yaml::Hash(map) => Yaml::Hash(
            map.iter()
                .filter(|(key, _)| !matches!(key.as_str(), Some("generated" | "verified")))
                .map(|(key, value)| (key.clone(), value.clone()))
                .collect(),
        ),
        other => other.clone(),
    }
}
fn same_meaning(left: &Concept, right: &Concept) -> bool {
    without_stamps(left) == without_stamps(right)
        && okf::normalize(&left.body) == okf::normalize(&right.body)
}

fn stamp(content: &str, proposed: &Concept, authoring: &Authoring<'_>) -> Result<String, Error> {
    let human_authored = authoring.allow_human_actor
        && proposed
            .summary
            .meta
            .generated
            .as_ref()
            .is_some_and(|generated| okf::is_human(&generated.by));
    if human_authored {
        let at = proposed
            .summary
            .meta
            .generated
            .as_ref()
            .and_then(|generated| generated.at);
        return match at {
            Some(_) => Ok(content.into()),
            None => set_generated(
                content,
                &proposed
                    .summary
                    .meta
                    .generated
                    .as_ref()
                    .map(|generated| generated.by.clone())
                    .unwrap_or_default(),
                authoring.now,
            ),
        };
    }
    let preserved = authoring
        .before
        .filter(|before| same_meaning(before, proposed));
    match preserved {
        Some(before) => match edit::key_text(&before.content, "generated") {
            Some(text) => edit::set_key(content, "generated", &text).ok_or(Error::InvalidYaml),
            None => edit::remove_key(content, "generated").ok_or(Error::InvalidYaml),
        },
        None => set_generated(content, &producer(), authoring.now),
    }
}
fn set_generated(content: &str, by: &str, now: DateTime<Utc>) -> Result<String, Error> {
    edit::set_key(
        content,
        "generated",
        &format!(
            "generated: {{ by: {}, at: {} }}",
            edit::quote(by),
            edit::timestamp(now)
        ),
    )
    .ok_or(Error::InvalidYaml)
}

fn duplicate(proposed: &Concept, others: &[Concept]) -> Option<String> {
    let meta = &proposed.summary.meta;
    let title = meta.title.as_deref().map(okf::normalize);
    let tokens = format::words(&proposed.body).ok()?;
    others
        .iter()
        .filter(|other| other.summary.meta.status.current())
        .find(|other| {
            let theirs = &other.summary.meta;
            let same_title = title.is_some()
                && theirs.title.as_deref().map(okf::normalize) == title
                && theirs.type_.eq_ignore_ascii_case(&meta.type_);
            same_title || {
                let other_tokens = format::words(&other.body).unwrap_or_default();
                let union = tokens.union(&other_tokens).count();
                tokens.len() >= 8
                    && union > 0
                    && tokens.intersection(&other_tokens).count() * 100 >= union * 90
            }
        })
        .map(|other| other.summary.id.clone())
}

pub fn deprecate(content: &str, replacement: Option<&str>) -> Result<String, Error> {
    let marked =
        edit::set_key(content, "status", "status: deprecated").ok_or(Error::InvalidYaml)?;
    match replacement {
        Some(id) => edit::set_key(
            &marked,
            "superseded_by",
            &format!("superseded_by: {}", edit::quote(&format!("/{id}.md"))),
        ),
        None => edit::remove_key(&marked, "superseded_by"),
    }
    .ok_or(Error::InvalidYaml)
}

pub fn supersession_chain(start: &str, concepts: &[Concept]) -> BTreeSet<String> {
    let mut seen = BTreeSet::new();
    let mut at = start.to_owned();
    while seen.insert(at.clone()) {
        let next = concepts
            .iter()
            .find(|concept| concept.summary.id == at)
            .filter(|concept| concept.summary.meta.status == Status::Deprecated)
            .and_then(|concept| concept.summary.meta.superseded_by.as_deref())
            .and_then(|target| {
                let paths = concepts
                    .iter()
                    .map(|c| format!("{}.md", c.summary.id))
                    .collect::<BTreeSet<_>>();
                okf::View {
                    paths: &paths,
                    legacy_root_fallback: false,
                }
                .concept_for(&format!("{at}.md"), target, true)
            });
        match next {
            Some(next) => at = next,
            None => break,
        }
    }
    seen
}

fn credential(content: &str) -> Option<&'static str> {
    let boundary = |c: char| !(c.is_ascii_alphanumeric() || c == '_');
    let run = |prefix: &str, minimum: usize, accepts: fn(char) -> bool| {
        content.match_indices(prefix).any(|(at, _)| {
            let before = content[..at].chars().next_back();
            before.is_none_or(boundary)
                && content[at + prefix.len()..]
                    .chars()
                    .take_while(|c| accepts(*c))
                    .count()
                    >= minimum
        })
    };
    let token = |c: char| c.is_ascii_alphanumeric() || matches!(c, '_' | '-');
    if content.contains("-----BEGIN") && content.contains("PRIVATE KEY-----") {
        Some("credential-private-key")
    } else if run("ghp_", 30, token)
        || run("gho_", 30, token)
        || run("ghs_", 30, token)
        || run("github_pat_", 30, token)
        || run("sk-", 24, token)
        || run("xoxb-", 20, token)
        || run("xoxp-", 20, token)
        || run("AIza", 30, token)
        || run("AKIA", 16, |c| c.is_ascii_uppercase() || c.is_ascii_digit())
    {
        Some("credential-token")
    } else if content.lines().any(|line| {
        let lower = line.to_lowercase();
        lower
            .find("authorization:")
            .map(|at| lower[at + 14..].trim_start())
            .is_some_and(|rest| {
                rest.strip_prefix("bearer ")
                    .is_some_and(|token| token.chars().take_while(|c| token_char(*c)).count() >= 20)
            })
    }) {
        Some("credential-authorization-header")
    } else {
        None
    }
}
fn token_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '=' | '/' | '+')
}

fn exposure(content: &str) -> Vec<Diagnostic> {
    let mut advice = Vec::new();
    let local = ["/Users/", "/home/", "C:\\Users\\"]
        .iter()
        .any(|prefix| content.contains(prefix));
    if local {
        advice.push(diagnostic(
            Level::Advice,
            "Y310",
            "remove machine-local absolute paths; cite repo:/// paths instead",
            None,
        ));
    }
    let private = [
        "://localhost",
        "://127.0.0.1",
        "://10.",
        "://192.168.",
        ".internal/",
        ".local/",
    ]
    .iter()
    .any(|marker| content.contains(marker));
    if private {
        advice.push(diagnostic(
            Level::Advice,
            "Y311",
            "remove private or machine-local URLs from durable memory",
            None,
        ));
    }
    advice
}
