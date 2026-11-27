use super::{
    Error, edit,
    format::{Concept, sha256},
    okf::Source,
};
use yaml_rust2::Yaml;

pub const TYPE: &str = "Experience";
pub const CUE: &str = "x-ycoding-cue";
pub const LESSON: &str = "x-ycoding-lesson";
pub const APPLICABILITY: &str = "x-ycoding-applicability";
pub const OUTCOME: &str = "x-ycoding-outcome";
pub const CONFIDENCE: &str = "x-ycoding-confidence";
pub const HARNESS_CHANGE: &str = "x-ycoding-harness-change";

const CUE_LIMIT: usize = 240;
const LESSON_LIMIT: usize = 600;
const APPLICABILITY_LIMIT: usize = 240;
const REFERENCE_LIMIT: usize = 300;
const EVIDENCE_LIMIT: usize = 8;
const BODY_LIMIT: usize = 4096;
const ROLE_PREFIXES: [&str; 6] = ["user:", "assistant:", "system:", "human:", "tool:", "ai:"];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Outcome {
    Success,
    Failure,
}
impl Outcome {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Success => "success",
            Self::Failure => "failure",
        }
    }
    fn label(self) -> &'static str {
        match self {
            Self::Success => "Success",
            Self::Failure => "Failure",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Evidence {
    pub resource: String,
    pub title: String,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Experience {
    pub cue: String,
    pub lesson: String,
    pub applicability: String,
    pub outcome: Outcome,
    pub confidence: f64,
    pub evidence: Vec<Evidence>,
    pub harness_change: Option<String>,
    pub tags: Vec<String>,
}

pub fn is(type_name: &str) -> bool {
    type_name.trim().eq_ignore_ascii_case(TYPE)
}

fn clip(text: &str, limit: usize) -> String {
    text.chars().take(limit).collect()
}

pub fn id(experience: &Experience) -> String {
    let slug = experience
        .cue
        .to_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect::<String>()
        .split('-')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("-");
    let slug = clip(&slug, 40);
    let digest = sha256(&experience.cue);
    let parts = [
        slug.trim_end_matches('-'),
        &digest[..6],
        experience.outcome.as_str(),
    ];
    format!(
        "experiences/{}",
        parts
            .iter()
            .filter(|part| !part.is_empty())
            .copied()
            .collect::<Vec<_>>()
            .join("-")
    )
}

pub fn render(experience: &Experience) -> String {
    let mut tags = vec!["experience".to_owned()];
    for tag in &experience.tags {
        if !tags.contains(tag) {
            tags.push(tag.clone());
        }
    }
    let mut lines = vec![
        "---".to_owned(),
        format!("type: {TYPE}"),
        format!(
            "title: {}",
            edit::quote(&format!(
                "{}: {}",
                experience.outcome.label(),
                clip(&experience.cue, 80)
            ))
        ),
        format!(
            "description: {}",
            edit::quote(&clip(&experience.lesson, 240))
        ),
        format!(
            "tags: [{}]",
            tags.iter()
                .map(|tag| edit::quote(tag))
                .collect::<Vec<_>>()
                .join(", ")
        ),
    ];
    if !experience.evidence.is_empty() {
        lines.push("sources:".into());
        for (index, item) in experience.evidence.iter().enumerate() {
            lines.push(format!("  - id: e{}", index + 1));
            lines.push(format!("    resource: {}", edit::quote(&item.resource)));
            lines.push(format!("    title: {}", edit::quote(&item.title)));
        }
    }
    lines.extend([
        format!("{CUE}: {}", edit::quote(&experience.cue)),
        format!("{LESSON}: {}", edit::quote(&experience.lesson)),
        format!(
            "{APPLICABILITY}: {}",
            edit::quote(&experience.applicability)
        ),
        format!("{OUTCOME}: {}", experience.outcome.as_str()),
        format!(
            "{CONFIDENCE}: {}",
            edit::quote(&experience.confidence.to_string())
        ),
    ]);
    if let Some(change) = &experience.harness_change {
        lines.push(format!("{HARNESS_CHANGE}: {}", edit::quote(change)));
    }
    lines.push("---".into());
    let citations = (1..=experience.evidence.len())
        .map(|number| format!("[^e{number}]"))
        .collect::<String>();
    lines.extend([
        String::new(),
        "# Cue".into(),
        String::new(),
        experience.cue.clone(),
        String::new(),
        "# Lesson".into(),
        String::new(),
        format!("{}{citations}", experience.lesson),
        String::new(),
        "# Evidence".into(),
        String::new(),
    ]);
    lines.extend(experience.evidence.iter().enumerate().map(|(index, item)| {
        format!(
            "[^e{}]: {}",
            index + 1,
            if item.title.trim().is_empty() {
                &item.resource
            } else {
                &item.title
            }
        )
    }));
    lines.push(String::new());
    lines.join("\n")
}

fn single_line(yaml: &Yaml, key: &str, limit: usize, reason: &'static str) -> Result<(), Error> {
    match &yaml[key] {
        Yaml::String(text)
            if !text.trim().is_empty()
                && !text.contains(['\n', '\r'])
                && text.chars().count() <= limit =>
        {
            Ok(())
        }
        _ => Err(Error::Rejected(reason)),
    }
}

fn confidence(value: &Yaml) -> Result<(), Error> {
    let parsed = match value {
        Yaml::Real(text) | Yaml::String(text) => text.trim().parse::<f64>().ok(),
        Yaml::Integer(number) => Some(*number as f64),
        _ => None,
    };
    match parsed {
        Some(number) if number.is_finite() && (0.0..=1.0).contains(&number) => Ok(()),
        _ => Err(Error::Rejected("experience-confidence-invalid")),
    }
}

fn reference(text: &str) -> bool {
    !text.is_empty()
        && text.chars().count() <= REFERENCE_LIMIT
        && !text.chars().any(char::is_whitespace)
}

fn evidence_resource(resource: &str) -> bool {
    if !reference(resource) {
        return false;
    }
    match resource.split_once("://") {
        Some((scheme, rest)) => {
            !rest.is_empty()
                && !scheme.eq_ignore_ascii_case("file")
                && scheme.starts_with(|c: char| c.is_ascii_alphabetic())
                && scheme
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '.' | '-'))
        }
        None => resource.starts_with('/') && resource.ends_with(".md"),
    }
}

fn evidence(sources: &[Source]) -> Result<(), Error> {
    if sources.is_empty() {
        return Err(Error::Rejected("experience-evidence-missing"));
    }
    if sources.len() > EVIDENCE_LIMIT
        || !sources
            .iter()
            .all(|source| evidence_resource(&source.resource))
    {
        return Err(Error::Rejected("experience-evidence-invalid"));
    }
    Ok(())
}

fn transcript(body: &str) -> Result<(), Error> {
    if body.len() > BODY_LIMIT {
        return Err(Error::Rejected("experience-body-too-long"));
    }
    let turns = body
        .lines()
        .map(|line| line.trim_start().to_lowercase())
        .filter(|line| ROLE_PREFIXES.iter().any(|role| line.starts_with(role)))
        .count();
    if turns >= 2 {
        return Err(Error::Rejected("experience-transcript"));
    }
    Ok(())
}

pub fn validate(concept: &Concept) -> Result<(), Error> {
    let yaml = &concept.doc.yaml;
    single_line(yaml, CUE, CUE_LIMIT, "experience-cue-invalid")?;
    single_line(yaml, LESSON, LESSON_LIMIT, "experience-lesson-invalid")?;
    single_line(
        yaml,
        APPLICABILITY,
        APPLICABILITY_LIMIT,
        "experience-applicability-invalid",
    )?;
    if !matches!(yaml[OUTCOME].as_str(), Some("success" | "failure")) {
        return Err(Error::Rejected("experience-outcome-invalid"));
    }
    confidence(&yaml[CONFIDENCE])?;
    match &yaml[HARNESS_CHANGE] {
        Yaml::BadValue | Yaml::Null => {}
        Yaml::String(text) if reference(text) => {}
        _ => return Err(Error::Rejected("experience-harness-change-invalid")),
    }
    evidence(&concept.summary.meta.sources)?;
    transcript(&concept.body)
}
