use super::{
    Applicability, Basis, Change, Component, Error, Experience, Experiences, Pending, Strategy,
    Task, VersionId,
};
use crate::resources::memory::{
    self, Scope, Search, experience as stored,
    okf::{self, Parsed},
};
use std::sync::Arc;

const PREFIX: &str = "experiences/";
const OBSERVED: &str = "observed";
const ASSUMED: &str = "assumed";
const QUERY_CHARS: usize = 900;
const EVIDENCE_LIMIT: usize = 8;
const REFERENCE_LIMIT: usize = 300;
const NO_EVIDENCE: &str = "harness://assumed";
const EVIDENCE_SCHEME: &str = "harness://evidence/";

pub struct MemoryExperiences {
    service: Arc<memory::Service>,
    scope: Scope,
}

impl MemoryExperiences {
    pub fn new(service: Arc<memory::Service>, scope: Scope) -> Self {
        Self { service, scope }
    }

    async fn store(&self, experience: Experience) -> Result<(), Error> {
        let id = format!("{PREFIX}{}", experience.id);
        let digest = self
            .service
            .read(self.scope, &id)
            .ok()
            .map(|read| read.digest);
        self.service
            .record_experience(self.scope, &id, &to_memory(&experience), digest.as_deref())
            .await
            .map(|_| ())
            .map_err(|error| match error {
                memory::Error::Rejected(_)
                | memory::Error::InvalidConcept
                | memory::Error::InvalidYaml => Error::Invalid(error.to_string()),
                memory::Error::StaleContent => Error::Conflict(error.to_string()),
                _ => Error::Unavailable(error.to_string()),
            })
    }

    fn find(&self, task: &Task, limit: usize) -> Result<Vec<Experience>, Error> {
        let query = task
            .text
            .trim()
            .chars()
            .take(QUERY_CHARS)
            .collect::<String>();
        if query.is_empty() || limit == 0 {
            return Ok(Vec::new());
        }
        let found = match self.service.search(
            self.scope,
            Search {
                query: &query,
                limit: Some(limit.min(50)),
                type_: Some(stored::TYPE),
                tag: None,
            },
        ) {
            Ok(found) => found,
            Err(
                memory::Error::Disabled | memory::Error::NotFound | memory::Error::InvalidConcept,
            ) => return Ok(Vec::new()),
            Err(error) => return Err(Error::Unavailable(error.to_string())),
        };
        let mut recalled = Vec::new();
        for hit in found.hits {
            let Some(id) = hit.summary.id.strip_prefix(PREFIX) else {
                continue;
            };
            let Ok(read) = self.service.read(self.scope, &hit.summary.id) else {
                continue;
            };
            if let Some(experience) = from_memory(id, &read.content)
                && applies(&experience.applicability, task)
            {
                recalled.push(experience);
            }
        }
        Ok(recalled)
    }
}

impl Experiences for MemoryExperiences {
    fn record(&self, experience: Experience) -> Pending<'_, ()> {
        Box::pin(self.store(experience))
    }

    fn recall(&self, task: &Task, limit: usize) -> Pending<'_, Vec<Experience>> {
        let task = task.clone();
        Box::pin(async move { self.find(&task, limit) })
    }
}

fn applies(applicability: &Applicability, task: &Task) -> bool {
    (applicability.agents.is_empty() || applicability.agents.contains(&task.agent))
        && (applicability.domains.is_empty()
            || task.domains.is_empty()
            || applicability
                .domains
                .iter()
                .any(|domain| task.domains.contains(domain)))
}

fn line(text: &str, limit: usize) -> String {
    text.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(limit)
        .collect()
}

fn describe(applicability: &Applicability) -> String {
    let mut parts = Vec::new();
    let mut part = |label: &str, values: Vec<String>| {
        if !values.is_empty() {
            parts.push(format!("{label}: {}", values.join(", ")));
        }
    };
    part(
        "domains",
        applicability.domains.iter().map(|v| line(v, 40)).collect(),
    );
    part(
        "components",
        applicability
            .components
            .iter()
            .map(|component| component.as_str().to_owned())
            .collect(),
    );
    part(
        "agents",
        applicability.agents.iter().map(|v| line(v, 40)).collect(),
    );
    if parts.is_empty() {
        "general".into()
    } else {
        line(&parts.join(" | "), 240)
    }
}

fn parse_applicability(text: &str) -> Applicability {
    let mut applicability = Applicability::default();
    for part in text.split(" | ") {
        let Some((label, values)) = part.split_once(": ") else {
            continue;
        };
        let values = values.split(", ").map(str::to_owned).collect::<Vec<_>>();
        match label {
            "domains" => applicability.domains = values,
            "agents" => applicability.agents = values,
            "components" => {
                applicability.components = values
                    .iter()
                    .filter_map(|name| {
                        Component::ALL
                            .into_iter()
                            .find(|component| component.as_str() == name)
                    })
                    .collect();
            }
            _ => {}
        }
    }
    applicability
}

fn to_memory(experience: &Experience) -> stored::Experience {
    stored::Experience {
        cue: line(&experience.cue, 240),
        lesson: line(&experience.lesson, 600),
        applicability: describe(&experience.applicability),
        outcome: match experience.strategy {
            Strategy::Success => stored::Outcome::Success,
            Strategy::Failure => stored::Outcome::Failure,
        },
        confidence: (f64::from(experience.confidence) * 1000.0).round() / 1000.0,
        evidence: if experience.evidence.is_empty() {
            vec![stored::Evidence {
                resource: NO_EVIDENCE.into(),
                title: String::new(),
            }]
        } else {
            experience
                .evidence
                .iter()
                .take(EVIDENCE_LIMIT)
                .map(|item| stored::Evidence {
                    resource: format!(
                        "{EVIDENCE_SCHEME}{}",
                        escape(item, REFERENCE_LIMIT - EVIDENCE_SCHEME.len())
                    ),
                    title: String::new(),
                })
                .collect()
        },
        harness_change: experience.change.as_ref().map(|change| {
            let mut reference = change.version.0.clone();
            for edit in &change.edits {
                let part = format!(";{}", escape(edit, REFERENCE_LIMIT));
                if reference.len() + part.len() > REFERENCE_LIMIT {
                    break;
                }
                reference.push_str(&part);
            }
            reference
        }),
        tags: vec![
            "harness".into(),
            match experience.basis {
                Basis::Observed => OBSERVED,
                Basis::Assumed => ASSUMED,
            }
            .into(),
        ],
    }
}

fn from_memory(id: &str, content: &str) -> Option<Experience> {
    let Parsed::Concept(doc) = okf::parse(content) else {
        return None;
    };
    let text = |key: &str| doc.yaml[key].as_str().map(str::to_owned);
    let strategy = match text(stored::OUTCOME)?.as_str() {
        "success" => Strategy::Success,
        "failure" => Strategy::Failure,
        _ => return None,
    };
    let change = text(stored::HARNESS_CHANGE).map(|text| {
        let mut parts = text.split(';');
        Change {
            version: VersionId(parts.next().unwrap_or_default().to_owned()),
            edits: parts.map(unescape).collect(),
        }
    });
    Some(Experience {
        id: id.to_owned(),
        strategy,
        cue: text(stored::CUE)?,
        lesson: text(stored::LESSON)?,
        evidence: doc
            .meta
            .sources
            .iter()
            .filter(|source| source.resource != NO_EVIDENCE)
            .map(|source| {
                source
                    .resource
                    .strip_prefix(EVIDENCE_SCHEME)
                    .map_or_else(|| source.resource.clone(), unescape)
            })
            .collect(),
        confidence: text(stored::CONFIDENCE)?.parse().ok()?,
        basis: if doc.meta.tags.iter().any(|tag| tag == ASSUMED) {
            Basis::Assumed
        } else {
            Basis::Observed
        },
        applicability: parse_applicability(&text(stored::APPLICABILITY)?),
        change,
    })
}

fn escape(text: &str, limit: usize) -> String {
    let mut escaped = String::new();
    for c in text.trim().chars() {
        let mut buffer = [0; 4];
        let part = if c.is_ascii_alphanumeric() || "-_.:/#".contains(c) {
            c.to_string()
        } else {
            c.encode_utf8(&mut buffer)
                .bytes()
                .map(|byte| format!("%{byte:02X}"))
                .collect()
        };
        if escaped.len() + part.len() > limit {
            break;
        }
        escaped.push_str(&part);
    }
    escaped
}

fn unescape(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut at = 0;
    while at < bytes.len() {
        let hex = (bytes[at] == b'%')
            .then(|| text.get(at + 1..at + 3))
            .flatten()
            .and_then(|digits| u8::from_str_radix(digits, 16).ok());
        match hex {
            Some(byte) => {
                decoded.push(byte);
                at += 3;
            }
            None => {
                decoded.push(bytes[at]);
                at += 1;
            }
        }
    }
    String::from_utf8_lossy(&decoded).into_owned()
}
