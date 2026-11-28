use crate::resources::recall::candidate::{Method, Reason};
use std::{future::Future, pin::Pin};
use ycoding_schema::{JsonObject, JsonValue, LosslessString, skill};

pub type SkillsFuture<'a> =
    Pin<Box<dyn Future<Output = Result<Vec<skill::Info>, String>> + Send + 'a>>;
pub type InstructionsFuture<'a> =
    Pin<Box<dyn Future<Output = Result<LosslessString, String>> + Send + 'a>>;
pub type ActivationFuture<'a> = Pin<Box<dyn Future<Output = Option<JsonObject>> + Send + 'a>>;

pub trait Resolver: Send + Sync {
    fn list(&self) -> SkillsFuture<'_>;
    fn instructions<'a>(&'a self, info: &'a skill::Info) -> InstructionsFuture<'a>;
    fn activation_metadata<'a>(&'a self, _info: &'a skill::Info) -> ActivationFuture<'a> {
        Box::pin(async { None })
    }
}

struct Activation {
    events: Vec<String>,
    commands: Vec<String>,
    paths: Vec<String>,
    keywords: Vec<String>,
}

fn workspace_relative(value: &str) -> bool {
    !value.is_empty()
        && !value.starts_with('/')
        && !value.contains(['\\', ':'])
        && !value
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..")
}

fn activation(metadata: &JsonObject) -> Option<Activation> {
    if !matches!(metadata.get(&"activation".into()), Some(JsonValue::String(value)) if value.as_str() == Some("auto"))
    {
        return None;
    }
    if metadata.get(&"version".into()).is_some_and(|value| !matches!(value, JsonValue::String(value) if value.as_str().is_some_and(|version| !version.trim().is_empty()))) { return None; }
    let terms = |key: &str| -> Option<Vec<String>> {
        match metadata.get(&key.into()) {
            None => Some(Vec::new()),
            Some(JsonValue::String(value)) => {
                let items = value
                    .as_str()?
                    .split(',')
                    .map(str::trim)
                    .collect::<Vec<_>>();
                if items.iter().any(|item| item.is_empty()) {
                    return None;
                }
                Some(items.into_iter().map(str::to_owned).collect())
            }
            _ => None,
        }
    };
    let events = terms("events")?;
    let commands = terms("commands")?;
    let paths = terms("paths")?;
    let keywords = terms("keywords")?;
    if events
        .iter()
        .any(|item| item.chars().any(char::is_whitespace))
        || paths.iter().any(|item| !workspace_relative(item))
    {
        return None;
    }
    Some(Activation {
        events,
        commands,
        paths,
        keywords,
    })
}

pub(crate) fn ranked_implicit(
    items: &[(&skill::Info, &JsonObject)],
    query: &str,
) -> Vec<(usize, Method, Reason, f64)> {
    use crate::resources::recall::{
        candidate::Query,
        document::{Activation, Document, Fields, Kind, Lifecycle, Scope, Source},
        hybrid::{Calibration, Retriever},
        index::Entry,
    };
    use std::{
        collections::HashMap,
        sync::{Arc, LazyLock},
        time::{Duration, Instant},
    };
    static CATALOGS: LazyLock<std::sync::Mutex<HashMap<String, Arc<Retriever>>>> =
        LazyLock::new(Default::default);
    if items.is_empty() || items.len() > 1000 || query.len() > 65536 || query.trim().is_empty() {
        return Vec::new();
    }
    let documents: Vec<Document> = items
        .iter()
        .map(|(info, metadata)| {
            let keywords = activation(metadata).map(|a| a.keywords).unwrap_or_default();
            let tags = match metadata.get(&"tags".into()) {
                Some(JsonValue::String(value)) => value
                    .as_str()
                    .map(|value| {
                        value
                            .split(',')
                            .map(str::trim)
                            .filter(|value| !value.is_empty())
                            .map(str::to_owned)
                            .collect::<Vec<_>>()
                    })
                    .unwrap_or_default(),
                _ => Vec::new(),
            };
            let id = info.id.as_str().unwrap_or_default().to_owned();
            let name = info.name.to_utf8().unwrap_or_default();
            let description = info
                .description
                .as_ref()
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_owned();
            let hash = ring::digest::digest(
                &ring::digest::SHA256,
                format!(
                    "{id}\0{name}\0{description}\0{}\0{}",
                    keywords.join("\0"),
                    tags.join("\0")
                )
                .as_bytes(),
            )
            .as_ref()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>();
            Document {
                source: Source {
                    path: id.clone(),
                    revision: hash.clone(),
                    content_hash: hash,
                },
                id,
                kind: Kind::Skill,
                scope: Scope::Workspace,
                fields: Fields {
                    title: name,
                    description,
                    keywords,
                    tags,
                    ..Fields::default()
                },
                lifecycle: Lifecycle {
                    activation: Some(Activation::Auto),
                    ..Lifecycle::default()
                },
            }
        })
        .collect();
    let by_id: HashMap<&str, &Document> = documents.iter().map(|d| (d.id.as_str(), d)).collect();
    let manifest: Vec<Entry> = documents
        .iter()
        .map(|d| Entry {
            scope: d.scope,
            kind: d.kind,
            id: d.id.clone(),
            hash: d.source.content_hash.clone(),
        })
        .collect();
    let catalog = ring::digest::digest(
        &ring::digest::SHA256,
        manifest
            .iter()
            .map(|e| e.hash.as_str())
            .collect::<Vec<_>>()
            .join("\0")
            .as_bytes(),
    )
    .as_ref()
    .iter()
    .map(|b| format!("{b:02x}"))
    .collect::<String>();
    let retriever = {
        let Ok(mut catalogs) = CATALOGS.lock() else {
            return Vec::new();
        };
        if catalogs.len() >= 8 && !catalogs.contains_key(&catalog) {
            catalogs.clear();
        }
        catalogs
            .entry(catalog)
            .or_insert_with(|| Arc::new(Retriever::open(None, None, Calibration::default())))
            .clone()
    };
    if retriever
        .sync(
            &manifest,
            |entry| by_id.get(entry.id.as_str()).map(|d| (*d).clone()),
            Instant::now() + Duration::from_secs(60),
        )
        .is_err()
    {
        return Vec::new();
    }
    let ids: HashMap<&str, usize> = documents
        .iter()
        .enumerate()
        .map(|(i, d)| (d.id.as_str(), i))
        .collect();
    retriever
        .search(&Query {
            text: query.to_owned(),
            kinds: vec![Kind::Skill],
            implicit: true,
            limit: documents.len(),
            ..Query::default()
        })
        .candidates
        .iter()
        .filter_map(|c| {
            let index = ids.get(c.id.as_str()).copied()?;
            if c.reason == Reason::ExactTag {
                return Some((
                    index,
                    Method::Exact,
                    Reason::ExactTag,
                    c.score(Method::Exact)?.score,
                ));
            }
            Some((
                index,
                Method::Bm25,
                Reason::Lexical,
                c.score(Method::Bm25)?.score,
            ))
        })
        .collect()
}

#[cfg(test)]
mod relevance_tests {
    use super::*;
    use ycoding_schema::{DomainDecode, parse_json};

    fn info(id: &str) -> skill::Info {
        skill::Info::decode(&parse_json(&format!(r#"{{"id":"{id}","name":"guide","location":"/skills/{id}/SKILL.md","content":"guidance","autoinvoke":true}}"#)).unwrap()).unwrap()
    }

    #[test]
    fn bm25_abstains_on_weak_exact_and_phrase_matches_and_breaks_ties_by_id() {
        let metadata = JsonObject::decode(&parse_json(r#"{"activation":"auto","keywords":"cobalt birch alder willow maple oak pine cedar elm amber quartz violet"}"#).unwrap()).unwrap();
        let zeta = info("zeta");
        let alpha = info("alpha");
        let items = [(&zeta, &metadata), (&alpha, &metadata)];
        assert!(ranked_implicit(&items, "alpha").is_empty());
        assert!(ranked_implicit(&items, "cobalt birch").is_empty());
        assert!(ranked_implicit(&items, "unrelated query").is_empty());
        assert_eq!(
            ranked_implicit(
                &items,
                "cobalt birch alder willow maple oak pine cedar elm amber quartz violet"
            )
            .into_iter()
            .map(|(index, _, _, _)| index)
            .collect::<Vec<_>>(),
            vec![1, 0]
        );
    }
}

pub(crate) fn valid_automatic(metadata: &JsonObject) -> bool {
    activation(metadata).is_some()
}

pub fn triggered(metadata: &JsonObject, event: &str, command: Option<&[String]>) -> bool {
    let Some(activation) = activation(metadata) else {
        return false;
    };
    activation.events.iter().any(|item| item == event)
        || command.is_some_and(|argv| {
            activation.commands.iter().any(|pattern| {
                let prefix = pattern.split_whitespace().collect::<Vec<_>>();
                !prefix.is_empty()
                    && argv.len() >= prefix.len()
                    && prefix.iter().zip(argv).all(|(a, b)| *a == b)
            })
        })
}

pub fn path_triggered(metadata: &JsonObject, path: &str) -> bool {
    let Some(activation) = activation(metadata) else {
        return false;
    };
    if !workspace_relative(path) {
        return false;
    }
    activation
        .events
        .iter()
        .any(|event| event == "path.selected")
        || activation.paths.iter().any(|pattern| {
            let escaped = pattern.chars().fold(String::new(), |mut output, ch| {
                if matches!(
                    ch,
                    '[' | ']' | '{' | '}' | '(' | ')' | '+' | '^' | '$' | '|'
                ) {
                    output.push('\\');
                }
                output.push(ch);
                output
            });
            crate::platform::filesystem::glob::matches(&escaped, path).unwrap_or(false)
        })
}

pub(crate) fn in_scope(
    info: &skill::Info,
    session: &ycoding_schema::session::Info,
    config: Option<&crate::resources::config::Configuration>,
) -> bool {
    let Some(path) = info
        .location
        .as_lossless()
        .as_str()
        .and_then(|p| std::fs::canonicalize(p).ok())
    else {
        return false;
    };
    let Some(location) = session
        .location
        .directory
        .as_lossless()
        .as_str()
        .and_then(|p| std::fs::canonicalize(p).ok())
    else {
        return false;
    };
    let project = session
        .subpath
        .as_ref()
        .and_then(|subpath| subpath.as_lossless().as_str())
        .and_then(|subpath| {
            let relative = std::path::Path::new(subpath);
            if !relative
                .components()
                .all(|component| matches!(component, std::path::Component::Normal(_)))
                || !location.ends_with(relative)
            {
                return None;
            }
            let mut project = location.clone();
            for _ in relative.components() {
                project.pop();
            }
            Some(project)
        })
        .unwrap_or(location);
    if path.starts_with(project) {
        return true;
    }
    config.is_some_and(|config| {
        let roots = config.roots();
        [
            roots.home.join(".agents/skills"),
            roots.home.join(".claude/skills"),
            roots.config.join("skills"),
        ]
        .iter()
        .filter_map(|root| std::fs::canonicalize(root).ok())
        .any(|root| path.starts_with(root))
    })
}

pub async fn activate(
    store: &super::store::Service,
    session_id: &ycoding_schema::session::Id,
    fields: JsonValue,
    now: i64,
) -> Result<(), ycoding_store::Error> {
    activate_with_origin(store, session_id, fields, now, false).await
}

pub(crate) fn automatic_key(
    session_id: &ycoding_schema::session::Id,
    message: &ycoding_schema::session_message::Id,
) -> LosslessString {
    use ycoding_schema::DomainEncode;
    format!(
        "{}{}",
        automatic_prefix(session_id),
        ycoding_schema::stringify_json(&message.encode())
    )
    .into()
}

fn automatic_prefix(session_id: &ycoding_schema::session::Id) -> String {
    use ycoding_schema::DomainEncode;
    format!(
        "skill-automatic:{}:",
        ycoding_schema::stringify_json(&session_id.encode())
    )
}

#[derive(Clone)]
pub(crate) struct LifecycleCue {
    key: LosslessString,
    pub(crate) event: &'static str,
    pub(crate) identity: LosslessString,
    pub(crate) explicit: Vec<skill::Id>,
}

fn cue_key(session_id: &ycoding_schema::session::Id, event: &str) -> LosslessString {
    format!("{}cue:{event}", automatic_prefix(session_id)).into()
}

pub(crate) fn mark_cue(
    tx: &mut ycoding_store::Write<'_>,
    session: &LosslessString,
    event: &'static str,
    identity: &LosslessString,
    now: i64,
) -> Result<(), ycoding_store::Error> {
    let session = ycoding_schema::session::Id::new(session.clone())
        .map_err(|_| ycoding_store::Error::Rejected("Invalid Session ID"))?;
    ycoding_store::resources::set_kv(
        tx,
        &cue_key(&session, event),
        &ycoding_store::session::Document::new(JsonValue::String(identity.clone()))?,
        now,
    )
}

pub(crate) fn lifecycle_cues(
    snapshot: &ycoding_store::Snapshot,
    session: &ycoding_schema::session::Id,
) -> Result<Vec<LifecycleCue>, ycoding_store::Error> {
    let mut cues = Vec::new();
    for event in ["session.compacted", "session.recovered"] {
        let key = cue_key(session, event);
        if let Some(value) = ycoding_store::resources::get_kv(snapshot, &key)?
            && let Some(identity) = cue_identity(value.value()).cloned()
        {
            use ycoding_schema::DomainDecode;
            let explicit = match value.value() {
                JsonValue::Object(data) => {
                    let Some(ids) = data
                        .get(&"explicit".into())
                        .and_then(|value| Vec::<skill::Id>::decode(value).ok())
                    else {
                        continue;
                    };
                    if !matches!(data.get(&"inputID".into()), Some(JsonValue::String(id)) if !id.is_empty())
                    {
                        continue;
                    }
                    ids
                }
                JsonValue::String(_) => Vec::new(),
                _ => continue,
            };
            cues.push(LifecycleCue {
                key,
                event,
                identity,
                explicit,
            });
        }
    }
    Ok(cues)
}

fn cue_identity(value: &JsonValue) -> Option<&LosslessString> {
    match value {
        JsonValue::String(identity) => Some(identity),
        JsonValue::Object(data) => match data.get(&"identity".into()) {
            Some(JsonValue::String(identity)) => Some(identity),
            _ => None,
        },
        _ => None,
    }
}

pub(crate) fn assign_cues(
    tx: &mut ycoding_store::Write<'_>,
    cues: &[LifecycleCue],
    input: &LosslessString,
    explicit: &[skill::Id],
    now: i64,
) -> Result<(), ycoding_store::Error> {
    for cue in cues {
        if tx
            .get::<ycoding_store::resources::KvTable>(&super::key(&cue.key))?
            .is_some_and(|row| cue_identity(row.value.value()) == Some(&cue.identity))
        {
            let value = ycoding_schema::ObjectEncoder::new()
                .field("identity", &cue.identity)
                .field("inputID", input)
                .field("explicit", &explicit.to_vec())
                .finish();
            ycoding_store::resources::set_kv(
                tx,
                &cue.key,
                &ycoding_store::session::Document::new(value)?,
                now,
            )?;
        }
    }
    Ok(())
}

pub(crate) fn acknowledge_cues(
    tx: &mut ycoding_store::Write<'_>,
    cues: &[LifecycleCue],
) -> Result<(), ycoding_store::Error> {
    for cue in cues {
        if tx
            .get::<ycoding_store::resources::KvTable>(&super::key(&cue.key))?
            .is_some_and(|row| cue_identity(row.value.value()) == Some(&cue.identity))
        {
            ycoding_store::resources::remove_kv(tx, &cue.key)?;
        }
    }
    Ok(())
}

pub(crate) fn remove_automatic(
    tx: &mut ycoding_store::Write<'_>,
    session_id: &ycoding_schema::session::Id,
) -> Result<(), ycoding_store::Error> {
    use std::ops::Bound;
    use ycoding_store::{TableSpec, resources::KvTable};
    let prefix = automatic_prefix(session_id);
    let mut after = None;
    loop {
        let rows = tx.scan::<KvTable>(
            after.as_deref().map_or(Bound::Unbounded, Bound::Excluded),
            Bound::Unbounded,
            128,
        )?;
        if rows.is_empty() {
            return Ok(());
        }
        after = rows.last().map(KvTable::primary_key);
        for row in rows
            .into_iter()
            .filter(|row| row.key.as_str().is_some_and(|key| key.starts_with(&prefix)))
        {
            ycoding_store::resources::remove_kv(tx, &row.key)?;
        }
    }
}

pub(crate) fn mark_origin(
    tx: &mut ycoding_store::Write<'_>,
    event: &ycoding_store::session::NewEvent,
    automatic: bool,
) -> Result<(), ycoding_store::Error> {
    let session = ycoding_schema::session::Id::new(event.aggregate_id.clone())
        .map_err(|_| ycoding_store::Error::Rejected("Invalid Session ID"))?;
    let id = ycoding_schema::event::Id::new(event.id.clone())
        .map_err(|_| ycoding_store::Error::Rejected("Invalid event ID"))?;
    let message = ycoding_schema::session_message::Id::from_event(&id);
    ycoding_store::resources::set_kv(
        tx,
        &automatic_key(&session, &message),
        &ycoding_store::session::Document::new(JsonValue::Bool(automatic))?,
        event.created,
    )
}

pub(crate) async fn activate_with_origin(
    store: &super::store::Service,
    session_id: &ycoding_schema::session::Id,
    fields: JsonValue,
    now: i64,
    automatic: bool,
) -> Result<(), ycoding_store::Error> {
    let JsonValue::Object(mut data) = fields else {
        return Err(ycoding_store::Error::Rejected(
            "Skill event fields must be an object",
        ));
    };
    data.insert(
        "sessionID".into(),
        ycoding_schema::DomainEncode::encode(session_id),
    );
    let event = ycoding_store::session::NewEvent {
        id: super::projector::random_event_id()?.as_lossless().clone(),
        aggregate_id: session_id.as_lossless().clone(),
        created: now,
        type_: "session.skill.activated.1".into(),
        data: JsonValue::Object(data),
    };
    store
        .client
        .submit(move |tx| {
            mark_origin(tx, &event, automatic)?;
            super::projector::append(tx, &event)
        })?
        .await?;
    Ok(())
}

pub fn selected(metadata: Option<&JsonObject>) -> Vec<skill::Id> {
    let Some(JsonValue::Array(skills)) =
        metadata.and_then(|metadata| metadata.get(&"skills".into()))
    else {
        return Vec::new();
    };
    skills
        .iter()
        .filter_map(|value| {
            let JsonValue::Object(fields) = value else {
                return None;
            };
            let Some(JsonValue::String(id)) = fields.get(&"id".into()) else {
                return None;
            };
            (!id.as_str().is_some_and(|id| id.trim().is_empty())).then(|| id.clone())
        })
        .collect()
}

pub fn mentions(text: &LosslessString, available: &[skill::Id]) -> Vec<skill::Id> {
    let text = text.code_units().collect::<Vec<_>>();
    available
        .iter()
        .filter(|id| mentioned(&text, id))
        .cloned()
        .collect()
}

fn mentioned(text: &[u16], id: &skill::Id) -> bool {
    let mut token = vec![36];
    token.extend(id.code_units());
    if token.len() == 1 || token.len() > text.len() {
        return false;
    }
    text.windows(token.len())
        .enumerate()
        .any(|(start, window)| {
            if window != token {
                return false;
            }
            let begins = start == 0 || is_whitespace(text[start - 1]);
            let end = start + token.len();
            let ends = end == text.len() || is_delimiter(text[end]);
            begins && ends
        })
}

fn is_whitespace(unit: u16) -> bool {
    char::from_u32(u32::from(unit)).is_some_and(crate::resources::discovery::whitespace)
}

fn is_delimiter(unit: u16) -> bool {
    is_whitespace(unit)
        || matches!(
            unit,
            33 | 34 | 39 | 40 | 41 | 44 | 46 | 58 | 59 | 63 | 96 | 93
        )
}

#[cfg(test)]
mod tests {
    use super::{mentions, selected};
    use ycoding_schema::{JsonObject, JsonValue, skill};

    fn ids(values: &[&str]) -> Vec<skill::Id> {
        values.iter().map(|value| (*value).into()).collect()
    }

    #[test]
    fn mention_matching_obeys_known_exact_token_boundaries_and_catalog_order() {
        let available = ids(&["audit", "audit-long", "audit.v2"]);
        for text in [
            "$audit",
            "Use $audit, then report",
            "\n$audit!",
            "$audit)",
            "$audit'",
            "$audit\"",
            "$audit`",
        ] {
            assert_eq!(
                mentions(&text.into(), &available),
                ids(&["audit"]),
                "{text}"
            );
        }
        for text in [
            "costs $10",
            "$VAR",
            "$unknown",
            "path/$audit",
            "`$audit`",
            "'$audit'",
            "\\$audit",
            "$$audit",
            "$audit_extra",
            "$audit-longer",
            "$audit}",
        ] {
            assert!(mentions(&text.into(), &available).is_empty(), "{text}");
        }
        assert_eq!(
            mentions(&"$audit-long, $audit.v2 $audit $audit".into(), &available),
            available
        );
    }

    #[test]
    fn selected_reads_only_nonblank_string_ids_from_skill_metadata() {
        let mut metadata = JsonObject::new();
        metadata.insert(
            "skills".into(),
            JsonValue::Array(vec![
                JsonValue::Object(object("audit")),
                JsonValue::Object(object("  ")),
                JsonValue::Object(object("")),
                JsonValue::String("audit".into()),
                JsonValue::Object(object_number()),
            ]),
        );
        assert_eq!(selected(Some(&metadata)), ids(&["audit"]));
        assert!(selected(None).is_empty());
        assert!(selected(Some(&JsonObject::new())).is_empty());
    }

    fn object(id: &str) -> JsonObject {
        let mut object = JsonObject::new();
        object.insert("id".into(), JsonValue::String(id.into()));
        object
    }

    fn object_number() -> JsonObject {
        let mut object = JsonObject::new();
        object.insert("id".into(), JsonValue::Number(1.0));
        object
    }
}
