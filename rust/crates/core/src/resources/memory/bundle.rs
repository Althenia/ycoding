use super::{
    Concept, Error, GENERATED_INDEX, Scope, State, Warning, atomic, collapse, create_root, entries,
    okf, parse, read_bounded, read_content, safe_path, text_value, warning,
};
use crate::resources::filesystem::{self, Hooks};
use chrono::{DateTime, Utc};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::Path,
};

pub(super) struct Bundle {
    pub concepts: Vec<Concept>,
    pub warnings: Vec<Warning>,
    pub bytes: usize,
    pub count: usize,
    pub paths: BTreeSet<String>,
    pub findings: Vec<(String, okf::Diagnostic)>,
    pub edges: BTreeMap<String, BTreeSet<String>>,
    pub version: Option<String>,
}

pub(super) fn scan(state: &State, now: DateTime<Utc>) -> Result<Bundle, Error> {
    let mut bundle = Bundle {
        concepts: Vec::new(),
        warnings: Vec::new(),
        bytes: 0,
        count: 0,
        paths: BTreeSet::new(),
        findings: Vec::new(),
        edges: BTreeMap::new(),
        version: None,
    };
    if !safe_path(&state.root, &state.root)? {
        return Ok(bundle);
    }
    visit(state, &state.root, &mut bundle, now)?;
    bundle
        .concepts
        .sort_by(|a, b| a.summary.id.cmp(&b.summary.id));
    if !legacy(bundle.version.as_deref()) {
        for concept in &mut bundle.concepts {
            concept.without_legacy_timestamp(now);
        }
    }
    link(&mut bundle);
    Ok(bundle)
}

pub(super) fn legacy(version: Option<&str>) -> bool {
    let Some(version) = version else {
        return true;
    };
    let mut parts = version.split('.').map(str::parse::<u32>);
    match (parts.next(), parts.next()) {
        (Some(Ok(major)), Some(Ok(minor))) => (major, minor) <= (0, 2),
        _ => false,
    }
}

fn link(bundle: &mut Bundle) {
    let view = okf::View {
        paths: &bundle.paths,
        legacy_root_fallback: legacy(bundle.version.as_deref()),
    };
    let mut findings = Vec::new();
    let mut edges = BTreeMap::new();
    let mut replacements = Vec::new();
    for concept in &bundle.concepts {
        let path = format!("{}.md", concept.summary.id);
        findings.extend(
            concept
                .doc
                .diagnostics
                .iter()
                .cloned()
                .map(|found| (path.clone(), found)),
        );
        let relations = okf::relations(&path, &concept.doc, &concept.links, &view);
        findings.extend(
            relations
                .diagnostics
                .into_iter()
                .map(|found| (path.clone(), found)),
        );
        edges.insert(concept.summary.id.clone(), relations.edges);
        replacements.push(relations.replacement);
    }
    let conflicts = okf::conflicts(
        &bundle
            .concepts
            .iter()
            .map(|concept| (concept.summary.id.clone(), &concept.summary.meta))
            .collect::<Vec<_>>(),
    );
    for (concept, replacement) in bundle.concepts.iter_mut().zip(replacements) {
        concept.summary.signals.replacement = replacement;
        concept.summary.signals.conflicts_with = conflicts
            .get(&concept.summary.id)
            .cloned()
            .unwrap_or_default();
    }
    bundle.findings.extend(findings);
    bundle.edges = edges;
}

fn visit(
    state: &State,
    directory: &Path,
    bundle: &mut Bundle,
    now: DateTime<Utc>,
) -> Result<(), Error> {
    if !fs::symlink_metadata(directory)?.is_dir() {
        return Err(Error::UnsafePath);
    }
    for entry in entries(directory)? {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') {
            continue;
        }
        let target = entry.path();
        let relative = target
            .strip_prefix(&state.root)
            .map_err(|_| Error::UnsafePath)?
            .to_string_lossy()
            .into_owned();
        let id = relative.trim_end_matches(".md").to_owned();
        let info = entry.file_type()?;
        if info.is_symlink() {
            bundle.warnings.push(warning(&id, "unsafe-link"));
            continue;
        }
        bundle.paths.insert(relative.clone());
        if info.is_dir() {
            safe_path(&state.root, &target)?;
            visit(state, &target, bundle, now)?;
            continue;
        }
        if matches!(name.as_str(), "index.md" | "log.md") {
            reserved(state, directory, &name, &target, &relative, bundle);
            continue;
        }
        if !name.ends_with(".md") {
            continue;
        }
        bundle.count += 1;
        let bytes = fs::symlink_metadata(&target)?.len() as usize;
        bundle.bytes += bytes;
        if bundle.count > state.limits.max_concepts
            || bytes > state.limits.max_concept_bytes
            || bundle.bytes > state.limits.max_bundle_bytes
        {
            return Err(Error::TooLarge);
        }
        match read_content(state, &target).and_then(|content| parse(&id, &content, now)) {
            Ok(concept) => bundle.concepts.push(concept),
            Err(Error::TooLarge) => return Err(Error::TooLarge),
            Err(Error::UnterminatedFrontmatter) => {
                bundle
                    .warnings
                    .push(warning(&id, "unterminated-frontmatter"));
                bundle.findings.push((
                    relative,
                    okf::diagnostic(
                        okf::Level::Error,
                        "E002",
                        "frontmatter does not parse as a YAML mapping: the closing --- line is missing (section 4)",
                        Some(1),
                    ),
                ));
            }
            Err(Error::InvalidConcept) => {
                bundle.warnings.push(warning(&id, "not-a-concept"));
                bundle.findings.push((
                    relative,
                    okf::diagnostic(
                        okf::Level::Warning,
                        "W120",
                        "not a concept: the file has no frontmatter or no non-empty type (section 3.2)",
                        Some(1),
                    ),
                ));
            }
            Err(Error::InvalidYaml) => {
                bundle.warnings.push(warning(&id, "invalid-concept"));
                bundle.findings.push((
                    relative,
                    okf::diagnostic(
                        okf::Level::Error,
                        "E002",
                        "frontmatter does not parse as a YAML mapping (section 4)",
                        Some(1),
                    ),
                ));
            }
            Err(_) => bundle.warnings.push(warning(&id, "unreadable-concept")),
        }
    }
    Ok(())
}

fn reserved(
    state: &State,
    directory: &Path,
    name: &str,
    target: &Path,
    relative: &str,
    bundle: &mut Bundle,
) {
    let Ok(content) = read_bounded(target, state.limits.max_bundle_bytes) else {
        bundle.warnings.push(warning(
            relative.trim_end_matches(".md"),
            "unreadable-concept",
        ));
        return;
    };
    let found = match (name, directory == state.root) {
        ("log.md", _) => okf::validate_log(&content),
        ("index.md", true) => {
            let (found, version, _) = okf::root_index(&content);
            bundle.version = version;
            found
        }
        _ => okf::validate_nested_index(&content),
    };
    bundle
        .findings
        .extend(found.into_iter().map(|found| (relative.to_owned(), found)));
}

pub(super) fn prefixes(concepts: &[Concept]) -> BTreeSet<String> {
    let mut directories = BTreeSet::from([String::new()]);
    for concept in concepts {
        let parts = concept.summary.id.split('/').collect::<Vec<_>>();
        for i in 1..parts.len() {
            directories.insert(parts[..i].join("/"));
        }
    }
    directories
}

pub(super) struct Entry<'a> {
    pub kind: &'a str,
    pub id: &'a str,
    pub title: &'a str,
}

pub(super) fn refresh(
    state: &State,
    now: DateTime<Utc>,
    concepts: Option<&[Concept]>,
    id: &str,
    entry: Option<Entry<'_>>,
) -> Vec<Warning> {
    let bundle = if concepts.is_none() {
        scan(state, now).ok()
    } else {
        None
    };
    let result = concepts
        .or_else(|| bundle.as_ref().map(|b| b.concepts.as_slice()))
        .ok_or(Error::Unavailable)
        .and_then(|concepts| indexes(state, concepts));
    let log = entry.map_or(Ok(()), |entry| record(state, now, &entry));
    let graph = filesystem::remove(
        &state.root,
        &state.root.join("graph.html"),
        false,
        &Hooks::default(),
    );
    if result.is_err() || graph.is_err() || log.is_err() {
        vec![warning(id, "index-out-of-date")]
    } else {
        Vec::new()
    }
}

fn record(state: &State, now: DateTime<Utc>, entry: &Entry<'_>) -> Result<(), Error> {
    let target = state.root.join("log.md");
    let existing = if safe_path(&state.root, &target)? {
        read_bounded(&target, state.limits.max_bundle_bytes)?
    } else {
        String::new()
    };
    if okf::validate_log(&existing)
        .iter()
        .any(|found| found.level == okf::Level::Error)
    {
        return Err(Error::InvalidConcept);
    }
    let day = now.format("%Y-%m-%d").to_string();
    let title = collapse(entry.title)
        .replace('\\', "\\\\")
        .replace('[', "\\[")
        .replace(']', "\\]");
    let item = if entry.kind == "Deletion" {
        format!("* **{}**: {}", entry.kind, title)
    } else {
        format!("* **{}**: [{}]({}.md)", entry.kind, title, entry.id)
    };
    let heading = format!("## {day}");
    let mut lines = existing.lines().map(str::to_owned).collect::<Vec<_>>();
    let first = lines.iter().position(|line| line.starts_with("## "));
    match first {
        Some(at) if lines[at] == heading => {
            let mut end = at + 1;
            while end < lines.len() && !lines[end].starts_with("## ") {
                end += 1;
            }
            while end > at + 1 && lines[end - 1].trim().is_empty() {
                end -= 1;
            }
            lines.insert(end, item);
        }
        Some(at) => {
            lines.splice(at..at, [heading, item, String::new()]);
        }
        None => {
            if lines.is_empty() {
                lines.extend(["# Memory log".to_owned(), String::new()]);
            } else if !lines.last().is_some_and(|line| line.trim().is_empty()) {
                lines.push(String::new());
            }
            lines.extend([heading, item]);
        }
    }
    lines.push(String::new());
    create_root(&state.root)?;
    atomic(&state.root, &target, lines.join("\n"))
}

fn root_front(state: &State, existing: Option<&str>) -> Result<String, Error> {
    if let Some(existing) = existing
        && let okf::Split::Block { body, .. } = okf::split(existing)
    {
        return Ok(existing[..existing.len() - body.len()].to_owned());
    }
    Ok(fresh_front(
        state.scope,
        state.repository.as_ref().map(|r| r.id.as_str()),
    ))
}

pub(super) fn fresh_front(scope: Scope, repository: Option<&str>) -> String {
    let (title, description) = if scope == Scope::Knowledge {
        (
            "Shared knowledge",
            "Durable knowledge shared across repositories. Consult it for conventions, constraints, and decisions that outlive one project.",
        )
    } else {
        (
            "Repository memory",
            "Durable knowledge for one repository and all of its worktrees. Consult it for decisions, constraints, lessons, and procedures that outlive one Session.",
        )
    };
    let mut lines = vec![
        "---".to_owned(),
        format!("okf_version: \"{}\"", okf::VERSION),
        format!("title: {}", super::edit::quote(title)),
        format!("description: {}", super::edit::quote(description)),
    ];
    if let Some(id) = repository
        && scope == Scope::Repository
    {
        lines.push(format!("x-ycoding-repository: {id}"));
    }
    lines.push("---".into());
    lines.push(String::new());
    lines.join("\n")
}

pub(super) fn indexes(state: &State, concepts: &[Concept]) -> Result<(), Error> {
    for directory in prefixes(concepts) {
        let target = state.root.join(&directory).join("index.md");
        let existing = if safe_path(&state.root, &target)? {
            let text = read_bounded(&target, state.limits.max_bundle_bytes)?;
            if !text.contains(GENERATED_INDEX) {
                continue;
            }
            Some(text)
        } else {
            None
        };
        let prefix = if directory.is_empty() {
            String::new()
        } else {
            format!("{directory}/")
        };
        let mut lines = Vec::new();
        if directory.is_empty() {
            lines.push(root_front(state, existing.as_deref())?);
        }
        lines.extend([GENERATED_INDEX.to_owned(), String::new()]);
        let subdirectories = prefixes(concepts)
            .into_iter()
            .filter(|other| {
                !other.is_empty()
                    && other.starts_with(&prefix)
                    && !other[prefix.len()..].contains('/')
                    && *other != directory
            })
            .collect::<Vec<_>>();
        if !subdirectories.is_empty() {
            lines.push("# Subdirectories".into());
            lines.push(String::new());
            for other in subdirectories {
                let count = concepts
                    .iter()
                    .filter(|c| c.summary.id.starts_with(&format!("{other}/")))
                    .count();
                lines.push(format!(
                    "* [{}]({}/index.md) - Contains {count} concept{}.",
                    &other[prefix.len()..],
                    &other[prefix.len()..],
                    if count == 1 { "" } else { "s" }
                ));
            }
            lines.push(String::new());
        }
        let mut groups: BTreeMap<String, Vec<&Concept>> = BTreeMap::new();
        for concept in concepts.iter().filter(|c| {
            c.summary.id.starts_with(&prefix) && !c.summary.id[prefix.len()..].contains('/')
        }) {
            groups
                .entry(text_value(&concept.summary.type_))
                .or_default()
                .push(concept);
        }
        for (type_, members) in groups {
            lines.push(format!("# {}", collapse(&type_)));
            lines.push(String::new());
            for concept in members {
                let summary = &concept.summary;
                let title = summary
                    .title
                    .as_ref()
                    .map(text_value)
                    .unwrap_or_else(|| summary.id[prefix.len()..].to_owned());
                let title = collapse(&title)
                    .replace('\\', "\\\\")
                    .replace('[', "\\[")
                    .replace(']', "\\]");
                let description = summary
                    .description
                    .as_ref()
                    .map(|text| collapse(&text_value(text)))
                    .filter(|text| !text.trim().is_empty());
                let destination = summary.id[prefix.len()..]
                    .split('/')
                    .map(encode)
                    .collect::<Vec<_>>()
                    .join("/");
                lines.push(match description {
                    Some(description) => format!("* [{title}]({destination}.md) - {description}"),
                    None => format!("* [{title}]({destination}.md)"),
                });
            }
            lines.push(String::new());
        }
        if existing
            .as_deref()
            .is_some_and(|text| text == lines.join("\n"))
        {
            continue;
        }
        atomic(&state.root, &target, lines.join("\n"))?;
    }
    Ok(())
}

fn encode(part: &str) -> String {
    part.bytes()
        .map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (byte as char).to_string()
            }
            byte => format!("%{byte:02X}"),
        })
        .collect()
}
