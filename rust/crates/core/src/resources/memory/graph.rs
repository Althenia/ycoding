use super::{
    Concept, Error, Scope, Service, State, Warning, atomic, create_root, format::sha256, indexes,
    json_lossless, json_string, lock, scan, warning,
};
use std::{collections::BTreeSet, path::PathBuf};

pub struct Node<'a> {
    pub id: String,
    pub concept: &'a Concept,
}
#[derive(Debug)]
pub struct Rendered {
    pub nodes: usize,
    pub edges: usize,
    pub warnings: Vec<Warning>,
    pub html: String,
}
#[derive(Debug)]
pub struct Export {
    pub path: PathBuf,
    pub digest: String,
    pub nodes: usize,
    pub edges: usize,
    pub warnings: Vec<Warning>,
}
impl Service {
    pub async fn graph(&self, scope: Scope) -> Result<Export, Error> {
        let state = self.operate(scope)?;
        create_root(&state.root)?;
        let _lock = lock(&state.root).await?;
        let repository = scan(&state)?;
        let knowledge = if scope == Scope::Repository {
            Some(scan(&State {
                root: state.knowledge_root.clone(),
                ..state.clone()
            })?)
        } else {
            None
        };
        let nodes = repository
            .concepts
            .iter()
            .map(|concept| Node {
                id: if scope == Scope::Knowledge {
                    format!("knowledge/{}", concept.summary.id)
                } else {
                    format!(
                        "repository/{}/{}",
                        state
                            .repository
                            .as_ref()
                            .map(|r| r.id.as_str())
                            .unwrap_or(""),
                        concept.summary.id
                    )
                },
                concept,
            })
            .chain(
                knowledge
                    .iter()
                    .flat_map(|bundle| bundle.concepts.iter())
                    .map(|concept| Node {
                        id: format!("knowledge/{}", concept.summary.id),
                        concept,
                    }),
            )
            .collect::<Vec<_>>();
        let rendered = render(&nodes);
        let path = state.root.join("graph.html");
        atomic(&state.root, &path, &rendered.html)?;
        let index_failure = if indexes(&state, &repository.concepts).is_err() {
            vec![warning("", "index-out-of-date")]
        } else {
            Vec::new()
        };
        Ok(Export {
            path,
            digest: sha256(&rendered.html),
            nodes: rendered.nodes,
            edges: rendered.edges,
            warnings: repository
                .warnings
                .into_iter()
                .chain(knowledge.into_iter().flat_map(|b| b.warnings))
                .chain(rendered.warnings)
                .chain(index_failure)
                .collect(),
        })
    }
}
pub fn render(nodes: &[Node<'_>]) -> Rendered {
    let ids = nodes.iter().map(|n| n.id.as_str()).collect::<BTreeSet<_>>();
    let mut edges = Vec::<(&str, String)>::new();
    let mut warnings = Vec::new();
    for node in nodes {
        for link in &node.concept.links {
            let lower = link.to_ascii_lowercase();
            if lower.starts_with("http:")
                || lower.starts_with("https:")
                || lower.starts_with("mailto:")
                || lower.starts_with("repo:")
                || link.starts_with('#')
            {
                continue;
            }
            let scheme = link.split_once(':').is_some_and(|(scheme, _)| {
                scheme
                    .as_bytes()
                    .first()
                    .is_some_and(u8::is_ascii_alphabetic)
                    && scheme
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'+' | b'.' | b'-'))
            });
            if scheme || link.starts_with("//") {
                warnings.push(warning(&node.concept.summary.id, "unsafe-link"));
                continue;
            }
            let Some(decoded) = decode(link.split(['?', '#']).next().unwrap_or("")) else {
                warnings.push(warning(&node.concept.summary.id, "unsafe-link"));
                continue;
            };
            if decoded.contains('\\') {
                warnings.push(warning(&node.concept.summary.id, "unsafe-link"));
                continue;
            }
            let path = if let Some(path) = decoded.strip_prefix('/') {
                path.into()
            } else {
                format!(
                    "{}/{}",
                    node.id.rsplit_once('/').map(|(p, _)| p).unwrap_or("."),
                    decoded
                )
            };
            let target = normalize(&path);
            let target = target.strip_suffix(".md").unwrap_or(&target);
            if target == ".." || target.starts_with("../") {
                warnings.push(warning(&node.concept.summary.id, "unsafe-link"));
                continue;
            }
            if !ids.contains(target) {
                warnings.push(warning(&node.concept.summary.id, "dangling-link"));
                continue;
            }
            if !edges
                .iter()
                .any(|(source, existing)| *source == node.id && existing == target)
            {
                edges.push((&node.id, target.into()));
            }
        }
    }
    let data = format!(
        "{{\"nodes\":[{}],\"edges\":[{}],\"warnings\":[{}]}}",
        nodes
            .iter()
            .map(|node| {
                let c = &node.concept.summary;
                let mut data = format!(
                    "{{\"id\":{},\"type\":{},\"digest\":{}",
                    json_string(&node.id),
                    json_lossless(&c.type_),
                    json_string(&c.digest)
                );
                if let Some(title) = &c.title {
                    data.push_str(&format!(",\"title\":{}", json_lossless(title)));
                }
                if let Some(description) = &c.description {
                    data.push_str(&format!(",\"description\":{}", json_lossless(description)));
                }
                if let Some(tags) = &c.tags {
                    data.push_str(&format!(
                        ",\"tags\":[{}]",
                        tags.iter().map(json_lossless).collect::<Vec<_>>().join(",")
                    ));
                }
                data.push_str(&format!(
                    ",\"body\":{}}}",
                    json_string(&node.concept.content)
                ));
                data
            })
            .collect::<Vec<_>>()
            .join(","),
        edges
            .iter()
            .map(|(source, target)| format!(
                "{{\"source\":{},\"target\":{}}}",
                json_string(source),
                json_string(target)
            ))
            .collect::<Vec<_>>()
            .join(","),
        warnings
            .iter()
            .map(|w| format!(
                "{{\"id\":{},\"code\":{}}}",
                json_string(&w.id),
                json_string(&w.code)
            ))
            .collect::<Vec<_>>()
            .join(",")
    );
    let data = data
        .chars()
        .map(|ch| {
            if matches!(ch, '<' | '>' | '&' | '\u{2028}' | '\u{2029}') {
                format!("\\u{:04x}", ch as u32)
            } else {
                ch.to_string()
            }
        })
        .collect::<String>();
    Rendered {
        nodes: nodes.len(),
        edges: edges.len(),
        warnings,
        html: include_str!("page.html").replace("__YCODING_KNOWLEDGE_DATA__", &data),
    }
}
fn decode(value: &str) -> Option<String> {
    let bytes = value.as_bytes();
    let mut output = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let digits = bytes.get(i + 1..i + 3)?;
            output.push(
                (digits[0] as char).to_digit(16)? as u8 * 16
                    + (digits[1] as char).to_digit(16)? as u8,
            );
            i += 3;
            continue;
        }
        output.push(bytes[i]);
        i += 1;
    }
    String::from_utf8(output).ok()
}
fn normalize(value: &str) -> String {
    let mut parts = Vec::new();
    for part in value.split('/') {
        if part.is_empty() || part == "." {
            continue;
        }
        if part == ".." && parts.last().is_some_and(|part| *part != "..") {
            parts.pop();
            continue;
        }
        parts.push(part);
    }
    if parts.is_empty() {
        return ".".into();
    }
    format!(
        "{}{}",
        if value.starts_with('/') { "/" } else { "" },
        parts.join("/")
    )
}
