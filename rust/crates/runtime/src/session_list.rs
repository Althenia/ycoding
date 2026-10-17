use crate::{
    convert, cursor,
    dispatch::{Failure, Invocation},
    remote_derived::target,
};
use std::{
    cmp::Ordering,
    collections::{BTreeMap, BTreeSet},
    path::{Component, PathBuf},
};
use ycoding_core::session::{
    list::{Order, Parent, Query, Scope},
    outstanding,
    prompt_cache::sha256,
};
use ycoding_core::ycoding_schema::{
    JsonObject, JsonValue, LosslessString, parse_json,
    project_id::ProjectId,
    schema::{AbsolutePath, Finite},
    session, stringify_json,
    workspace_id::WorkspaceId,
};
use ycoding_protocol::{limits, v5};

const DEFAULT_LIMIT: usize = 50;
const MAX_LIMIT: usize = 200;
const MAX_CURSOR_BYTES: usize = 1024;
const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
type ClassifiedSessions = (BTreeSet<String>, BTreeSet<String>, BTreeSet<String>);

#[derive(Clone, Copy, PartialEq)]
enum Sort {
    Ascending,
    Descending,
    Pinned,
    Active,
}

struct Key {
    id: String,
    updated: i64,
    active: i64,
    pinned: Option<i64>,
    running: bool,
    waiting: bool,
}

struct Anchor {
    key: Key,
    previous: bool,
    epoch: Option<String>,
}

pub async fn list(
    invocation: Invocation,
    request: v5::SessionListRequest,
) -> Result<v5::SessionListResult, Failure> {
    if !invocation.remote {
        return local(&invocation, request);
    }
    let core = invocation.core()?;
    let query = &request.query;
    let limit = match query.limit {
        None => DEFAULT_LIMIT,
        Some(limit) if (1..=MAX_LIMIT as u64).contains(&limit) => limit as usize,
        Some(_) => return Err(Failure::Invalid("invalid limit".into())),
    };
    let sort = match query.order.map(v5::SessionsQueryOrder::try_from) {
        Some(Ok(v5::SessionsQueryOrder::SessionsqueryOrderAsc)) => Sort::Ascending,
        Some(Ok(v5::SessionsQueryOrder::SessionsqueryOrderDesc)) | None => Sort::Descending,
        Some(Ok(v5::SessionsQueryOrder::SessionsqueryOrderPinned)) => Sort::Pinned,
        Some(Ok(v5::SessionsQueryOrder::SessionsqueryOrderActive)) => Sort::Active,
        Some(_) => return Err(Failure::Invalid("invalid order".into())),
    };
    let summary = match query.search_fields {
        None | Some(0) => false,
        Some(1) => true,
        Some(_) => return Err(Failure::Invalid("invalid searchFields".into())),
    };
    let status = match query.status {
        None | Some(0) => None,
        Some(value @ 1..=3) => Some(value),
        Some(_) => return Err(Failure::Invalid("invalid status".into())),
    };
    let anchor = match &query.cursor {
        Some(cursor) => Some(decode_anchor(
            &convert::domain(cursor)?.to_utf8().map_err(invalid_cursor)?,
            sort,
        )?),
        None => None,
    };
    if (query.around.is_some() || query.before.is_some())
        && (sort != Sort::Active || anchor.is_some() || query.around.is_none())
    {
        return Err(Failure::Invalid("invalid Session window".into()));
    }
    if query.before.is_some_and(|before| before >= limit as u64) {
        return Err(Failure::Invalid("invalid before".into()));
    }
    let around = query
        .around
        .as_ref()
        .map(convert::identifier::<session::Id>)
        .transpose()?;
    let sessions = core
        .sessions
        .list(&Query::default())
        .map_err(|_| Failure::Unavailable("Session store unavailable".into()))?;
    let by_id = sessions
        .iter()
        .map(|info| (text(info.id.as_lossless()), info))
        .collect::<BTreeMap<_, _>>();
    let classified = sort == Sort::Active || status.is_some();
    let (running, waiting, lost) = if classified {
        classify(core, &by_id)?
    } else {
        (BTreeSet::new(), BTreeSet::new(), BTreeSet::new())
    };
    let running_roots = running
        .iter()
        .filter_map(|id| root(id, &by_id))
        .collect::<BTreeSet<_>>();
    let is_running = |info: &session::Info| {
        if info.parent_id.is_none() {
            running_roots.contains(&text(info.id.as_lossless()))
        } else {
            running.contains(&text(info.id.as_lossless()))
        }
    };
    let is_waiting = |info: &session::Info| {
        info.parent_id.is_none() && waiting.contains(&text(info.id.as_lossless()))
    };
    let key = |info: &session::Info| Key {
        id: text(info.id.as_lossless()),
        updated: info.time.updated.epoch_millis(),
        active: info
            .time
            .active
            .map_or(info.time.updated.epoch_millis(), |active| {
                active.epoch_millis()
            }),
        pinned: info.time.pinned.map(|pinned| pinned.epoch_millis()),
        running: info.parent_id.is_none() && is_running(info) && !is_waiting(info),
        waiting: is_waiting(info),
    };
    let workspace = match &query.workspace {
        None => None,
        Some(token) => {
            let token = convert::domain(token)?;
            Some(
                target::inventory(core, true)?
                    .into_iter()
                    .find(|candidate| {
                        convert::domain(&candidate.wire.id).is_ok_and(|key| key == token)
                    })
                    .map(|candidate| (candidate.project, candidate.directory, candidate.workspace)),
            )
        }
    };
    let directory = query.directory.as_ref().map(convert::domain).transpose()?;
    let project = query.project.as_ref().map(convert::domain).transpose()?;
    let needle = query
        .search
        .as_ref()
        .map(convert::domain)
        .transpose()?
        .map(|search| convert::readable(&search).to_lowercase());
    let parent = match query
        .parent_id
        .as_ref()
        .and_then(|parent| parent.kind.as_ref())
    {
        Some(v5::sessions_query_parent_id::Kind::Value1(id)) => {
            Some(Some(convert::readable(&convert::domain(id)?)))
        }
        Some(v5::sessions_query_parent_id::Kind::Clear(_)) => Some(None),
        None => None,
    };
    let mut matching = sessions
        .iter()
        .filter(|info| match &workspace {
            None => true,
            Some(None) => false,
            Some(Some((project, directory, workspace))) => {
                info.project_id.as_lossless() == project
                    && normalized(info.location.directory.as_lossless()) == Some(directory.clone())
                    && info
                        .location
                        .workspace_id
                        .as_ref()
                        .map(|id| id.as_lossless())
                        == workspace.as_ref()
            }
        })
        .filter(|info| match &directory {
            Some(directory) => info.location.directory.as_lossless() == directory,
            None => true,
        })
        .filter(|info| match &project {
            Some(project) => info.project_id.as_lossless() == project,
            None => true,
        })
        .filter(|info| match &parent {
            None => true,
            Some(expected) => {
                info.parent_id
                    .as_ref()
                    .map(|id| convert::readable(id.as_lossless()))
                    == *expected
            }
        })
        .filter(|info| match status {
            None => true,
            Some(1) => is_running(info) && !is_waiting(info),
            Some(2) => !is_running(info) && !is_waiting(info) && info.time.archived.is_none(),
            Some(3) => is_waiting(info),
            Some(_) => false,
        })
        .filter(|info| match &needle {
            None => true,
            Some(needle) => search_values(info, summary)
                .iter()
                .any(|value| value.to_lowercase().contains(needle)),
        })
        .collect::<Vec<_>>();
    matching.sort_by(|left, right| compare(&key(left), &key(right), sort));
    let epoch = (sort == Sort::Active).then(|| {
        let mut filters = query.clone();
        filters.cursor = None;
        filters.around = None;
        filters.before = None;
        filters.limit = None;
        let mut fingerprint = JsonObject::new();
        fingerprint.insert(
            "filters".into(),
            JsonValue::String(base64url(&prost::Message::encode_to_vec(&filters)).into()),
        );
        fingerprint.insert(
            "keys".into(),
            JsonValue::Array(
                matching
                    .iter()
                    .map(|info| {
                        let key = key(info);
                        JsonValue::Array(vec![
                            JsonValue::String(key.id.into()),
                            JsonValue::Number(key.active as f64),
                            JsonValue::Bool(key.waiting),
                            JsonValue::Bool(key.running),
                        ])
                    })
                    .collect(),
            ),
        );
        sha256(&stringify_json(&JsonValue::Object(fingerprint)))
    });
    if anchor
        .as_ref()
        .is_some_and(|anchor| sort == Sort::Active && anchor.epoch != epoch)
    {
        return Ok(v5::SessionListResult {
            data: v5::SessionsResponse {
                data: v5::SessionsResponseData { items: Vec::new() },
                cursor: v5::SessionsResponseCursor {
                    previous: None,
                    next: None,
                },
                status: None,
                stale: Some(true),
            },
        });
    }
    let (page, previous, next) = if let Some(around) = around {
        let start = matching
            .iter()
            .position(|info| info.id == around)
            .unwrap_or_default()
            .saturating_sub(query.before.unwrap_or_default() as usize);
        let page = matching
            .iter()
            .skip(start)
            .take(limit)
            .copied()
            .collect::<Vec<_>>();
        let previous = (start > 0)
            .then(|| page.first().map(|info| key(info)))
            .flatten();
        let next = (start + page.len() < matching.len())
            .then(|| page.last().map(|info| key(info)))
            .flatten();
        (page, previous, next)
    } else {
        paginate(&matching, &key, sort, anchor.as_ref(), limit)
    };
    let page_status = classified.then(|| {
        let loss_only = page
            .iter()
            .filter(|info| {
                info.parent_id.is_none()
                    && lost.contains(&text(info.id.as_lossless()))
                    && !key(info).waiting
            })
            .map(|info| text(info.id.as_lossless()))
            .collect::<Vec<_>>();
        v5::Status {
            running: page
                .iter()
                .filter(|info| is_running(info))
                .map(|info| text(info.id.as_lossless()))
                .collect(),
            attention: page
                .iter()
                .filter(|info| {
                    key(info).waiting || loss_only.contains(&text(info.id.as_lossless()))
                })
                .map(|info| text(info.id.as_lossless()))
                .collect(),
            lost: (!loss_only.is_empty()).then_some(v5::IdentifierList { items: loss_only }),
            outstanding: None,
            failed: None,
            details: None,
        }
    });
    Ok(v5::SessionListResult {
        data: v5::SessionsResponse {
            cursor: v5::SessionsResponseCursor {
                previous: previous
                    .map(|key| encode_anchor(&key, "previous", sort, epoch.as_deref()))
                    .transpose()?
                    .map(|value| convert::text(&value)),
                next: next
                    .map(|key| encode_anchor(&key, "next", sort, epoch.as_deref()))
                    .transpose()?
                    .map(|value| convert::text(&value)),
            },
            data: v5::SessionsResponseData {
                items: page
                    .iter()
                    .map(|info| convert::session_info(info))
                    .collect::<Result<_, _>>()
                    .map_err(|_| unrepresentable())?,
            },
            status: page_status,
            stale: None,
        },
    })
}

fn classify(
    core: &crate::Core,
    sessions: &BTreeMap<String, &session::Info>,
) -> Result<ClassifiedSessions, Failure> {
    let work = outstanding::read(
        &core.sessions,
        &core.orchestration,
        core.execution.jobs(),
        &core.execution.active(),
        false,
    )
    .map_err(|_| Failure::Unavailable("Session work unavailable".into()))?;
    let running = work.running.iter().map(text).collect();
    let lost = work
        .lost
        .iter()
        .filter_map(|id| root(&text(id), sessions))
        .collect();
    let mut waiting = BTreeSet::new();
    for (directory, workspace) in core.locations.cached() {
        let services = core.locations.location(&directory, workspace.as_ref())?;
        for services in core.locations.policy_sets(&services.info) {
            for request in services.permissions.list() {
                waiting.extend(root(&text(request.session_id.as_lossless()), sessions));
            }
            for request in services.questions.list() {
                waiting.extend(root(&text(request.session_id.as_lossless()), sessions));
            }
            for form in services.forms.list(None) {
                waiting.extend(root(&text(&form.session_id), sessions));
            }
            let mut reviewed = BTreeSet::new();
            for info in sessions.values().filter(|info| {
                info.location.directory == services.info.directory
                    && info.location.workspace_id == services.info.workspace_id
            }) {
                if !root(&text(info.id.as_lossless()), sessions)
                    .is_some_and(|id| reviewed.insert(id))
                {
                    continue;
                }
                for request in services
                    .guardrails
                    .for_session(&info.id)
                    .map_err(|_| Failure::Unavailable("Session requests unavailable".into()))?
                {
                    waiting.extend(root(&text(request.session_id.as_lossless()), sessions));
                }
            }
        }
    }
    for info in sessions.values().filter(|info| info.parent_id.is_none()) {
        if !core
            .reviews
            .list(&info.id)
            .map_err(|_| Failure::Unavailable("Session reviews unavailable".into()))?
            .is_empty()
        {
            waiting.insert(text(info.id.as_lossless()));
        }
    }
    Ok((running, waiting, lost))
}

fn local(
    invocation: &Invocation,
    request: v5::SessionListRequest,
) -> Result<v5::SessionListResult, Failure> {
    let core = invocation.core()?;
    let limit = request
        .query
        .limit
        .map_or(DEFAULT_LIMIT, |limit| limit as usize);
    let query = match &request.query.cursor {
        Some(cursor) => cursor::decode_list(
            &convert::domain(cursor)?
                .to_utf8()
                .map_err(|_| Failure::InvalidCursor("Invalid cursor".into()))?,
            limits::INLINE_BODY_BYTES as usize,
        )?,
        None => local_query(&request.query)?,
    };
    let sessions = core
        .sessions
        .list(&Query {
            limit: Some(limit),
            ..query.clone()
        })
        .map_err(|_| Failure::Unavailable("Session store unavailable".into()))?;
    let link = |info: &session::Info, direction: &str| -> Result<v5::LosslessString, Failure> {
        let anchor = session::ListAnchor {
            id: info.id.clone(),
            time: Finite::new(info.time.updated.epoch_millis() as f64)
                .map_err(|_| unrepresentable())?,
            direction: direction.into(),
        };
        Ok(convert::text(&cursor::encode_list(&query, &anchor)))
    };
    Ok(v5::SessionListResult {
        data: v5::SessionsResponse {
            cursor: v5::SessionsResponseCursor {
                previous: sessions
                    .first()
                    .map(|info| link(info, "previous"))
                    .transpose()?,
                next: sessions.last().map(|info| link(info, "next")).transpose()?,
            },
            data: v5::SessionsResponseData {
                items: sessions
                    .iter()
                    .map(convert::session_info)
                    .collect::<Result<_, _>>()
                    .map_err(|_| unrepresentable())?,
            },
            status: None,
            stale: None,
        },
    })
}

fn local_query(query: &v5::SessionsQuery) -> Result<Query, Failure> {
    let directory = query
        .directory
        .as_ref()
        .map(convert::identifier::<AbsolutePath>)
        .transpose()?;
    let project = query
        .project
        .as_ref()
        .map(convert::identifier::<ProjectId>)
        .transpose()?;
    let scope = match (directory, project) {
        (Some(directory), _) => Scope::Directory(directory.as_lossless().clone()),
        (None, Some(project)) => Scope::Project(project.as_lossless().clone()),
        (None, None) => Scope::All,
    };
    let parent = match query
        .parent_id
        .as_ref()
        .and_then(|parent| parent.kind.as_ref())
    {
        Some(v5::sessions_query_parent_id::Kind::Value1(id)) => {
            Some(Parent::Child(convert::identifier::<session::Id>(id)?))
        }
        Some(v5::sessions_query_parent_id::Kind::Clear(_)) => Some(Parent::Root),
        None => None,
    };
    let order = match query.order.map(v5::SessionsQueryOrder::try_from) {
        Some(Ok(v5::SessionsQueryOrder::SessionsqueryOrderAsc)) => Order::Ascending,
        Some(Ok(v5::SessionsQueryOrder::SessionsqueryOrderDesc)) | None => Order::Descending,
        Some(_) => return Err(Failure::Invalid("invalid order".into())),
    };
    Ok(Query {
        scope,
        workspace: query
            .workspace
            .as_ref()
            .map(convert::identifier::<WorkspaceId>)
            .transpose()?
            .map(|workspace| workspace.as_lossless().clone()),
        search: query.search.as_ref().map(convert::domain).transpose()?,
        parent,
        order,
        limit: None,
        anchor: None,
    })
}

fn paginate<'a>(
    matching: &[&'a session::Info],
    key: &impl Fn(&session::Info) -> Key,
    sort: Sort,
    anchor: Option<&Anchor>,
    limit: usize,
) -> (Vec<&'a session::Info>, Option<Key>, Option<Key>) {
    let Some(anchor) = anchor else {
        let page = matching.iter().take(limit).copied().collect::<Vec<_>>();
        let next = (matching.len() > limit)
            .then(|| page.last().map(|info| key(info)))
            .flatten();
        return (page, None, next);
    };
    if anchor.previous {
        let before = matching
            .iter()
            .filter(|info| compare(&key(info), &anchor.key, sort) == Ordering::Less)
            .copied()
            .collect::<Vec<_>>();
        let page = before[before.len().saturating_sub(limit)..].to_vec();
        let previous = (before.len() > limit)
            .then(|| page.first().map(|info| key(info)))
            .flatten();
        let next = page.last().map(|info| key(info));
        return (page, previous, next);
    }
    let after = matching
        .iter()
        .filter(|info| compare(&key(info), &anchor.key, sort) == Ordering::Greater)
        .copied()
        .collect::<Vec<_>>();
    let page = after.iter().take(limit).copied().collect::<Vec<_>>();
    let previous = page.first().map(|info| key(info));
    let next = (after.len() > limit)
        .then(|| page.last().map(|info| key(info)))
        .flatten();
    (page, previous, next)
}

fn compare(left: &Key, right: &Key, sort: Sort) -> Ordering {
    match sort {
        Sort::Ascending => by_updated(left, right),
        Sort::Descending => by_updated(left, right).reverse(),
        Sort::Pinned => match (left.pinned, right.pinned) {
            (Some(_), None) => Ordering::Less,
            (None, Some(_)) => Ordering::Greater,
            (Some(a), Some(b)) if a != b => a.cmp(&b),
            _ => by_updated(left, right).reverse(),
        },
        Sort::Active => right
            .waiting
            .cmp(&left.waiting)
            .then_with(|| right.running.cmp(&left.running))
            .then_with(|| right.active.cmp(&left.active))
            .then_with(|| left.id.cmp(&right.id)),
    }
}

fn by_updated(left: &Key, right: &Key) -> Ordering {
    left.updated
        .cmp(&right.updated)
        .then_with(|| left.id.cmp(&right.id))
}

fn root(id: &str, by_id: &BTreeMap<String, &session::Info>) -> Option<String> {
    let mut current = id.to_owned();
    let mut seen = BTreeSet::new();
    while seen.insert(current.clone()) {
        match by_id.get(&current)?.parent_id.as_ref() {
            Some(parent) => current = text(parent.as_lossless()),
            None => return Some(current),
        }
    }
    None
}

fn search_values(info: &session::Info, summary: bool) -> Vec<String> {
    let mut values = vec![convert::readable(&info.title)];
    if summary {
        values.push(
            info.agent
                .as_ref()
                .map(convert::readable)
                .unwrap_or_default(),
        );
        if let Some(model) = &info.model {
            values.push(format!(
                "{}/{}{}{}",
                convert::readable(&model.provider_id.0),
                convert::readable(&model.id),
                model
                    .variant
                    .as_ref()
                    .map(|variant| format!("#{}", convert::readable(variant)))
                    .unwrap_or_default(),
                model
                    .profile
                    .as_ref()
                    .map(|profile| format!(" profile {}", convert::readable(&profile.0)))
                    .unwrap_or_default(),
            ));
        }
    }
    values
}

fn normalized(directory: &LosslessString) -> Option<LosslessString> {
    let scalar = directory.to_utf8().ok()?;
    let absolute = std::path::absolute(&scalar).ok()?;
    let mut path = PathBuf::new();
    for part in absolute.components() {
        match part {
            Component::CurDir => {}
            Component::ParentDir => {
                path.pop();
            }
            part => path.push(part.as_os_str()),
        }
    }
    path.to_str().map(LosslessString::from)
}

fn encode_anchor(
    key: &Key,
    direction: &str,
    sort: Sort,
    epoch: Option<&str>,
) -> Result<String, Failure> {
    let mut object = JsonObject::new();
    object.insert("id".into(), JsonValue::String(key.id.clone().into()));
    object.insert(
        "time".into(),
        JsonValue::Number(if sort == Sort::Active {
            key.active
        } else {
            key.updated
        } as f64),
    );
    object.insert("direction".into(), JsonValue::String(direction.into()));
    if sort == Sort::Pinned {
        object.insert(
            "pinned".into(),
            key.pinned
                .map_or(JsonValue::Null, |pinned| JsonValue::Number(pinned as f64)),
        );
    }
    if sort == Sort::Active {
        object.insert("running".into(), JsonValue::Bool(key.running));
        object.insert("waiting".into(), JsonValue::Bool(key.waiting));
        object.insert(
            "epoch".into(),
            JsonValue::String(epoch.ok_or_else(|| invalid_cursor(()))?.into()),
        );
    }
    Ok(base64url(
        stringify_json(&JsonValue::Object(object)).as_bytes(),
    ))
}

fn decode_anchor(value: &str, sort: Sort) -> Result<Anchor, Failure> {
    let bytes = unbase64url(value).ok_or_else(|| invalid_cursor(()))?;
    let value =
        parse_json(std::str::from_utf8(&bytes).map_err(invalid_cursor)?).map_err(invalid_cursor)?;
    let JsonValue::Object(object) = value else {
        return Err(invalid_cursor(()));
    };
    let string = |name: &str| match object.get(&name.into()) {
        Some(JsonValue::String(value)) => Some(convert::readable(value)),
        _ => None,
    };
    let number = |name: &str| match object.get(&name.into()) {
        Some(JsonValue::Number(value)) if value.fract() == 0.0 => Some(*value as i64),
        _ => None,
    };
    let id = string("id").ok_or_else(|| invalid_cursor(()))?;
    let time = number("time").ok_or_else(|| invalid_cursor(()))?;
    let previous = match string("direction").as_deref() {
        Some("previous") => true,
        Some("next") => false,
        _ => return Err(invalid_cursor(())),
    };
    let pinned = match object.get(&"pinned".into()) {
        None => None,
        Some(JsonValue::Null) => Some(None),
        Some(JsonValue::Number(value)) if value.fract() == 0.0 => Some(Some(*value as i64)),
        Some(_) => return Err(invalid_cursor(())),
    };
    if sort == Sort::Pinned && pinned.is_none() {
        return Err(invalid_cursor(()));
    }
    let running = match object.get(&"running".into()) {
        None => None,
        Some(JsonValue::Bool(value)) => Some(*value),
        Some(_) => return Err(invalid_cursor(())),
    };
    if sort == Sort::Active && running.is_none() {
        return Err(invalid_cursor(()));
    }
    let waiting = match object.get(&"waiting".into()) {
        None => None,
        Some(JsonValue::Bool(value)) => Some(*value),
        Some(_) => return Err(invalid_cursor(())),
    };
    let epoch = match string("epoch") {
        Some(epoch)
            if epoch.len() == 64
                && epoch
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)) =>
        {
            Some(epoch)
        }
        None if object.get(&"epoch".into()).is_none() => None,
        _ => return Err(invalid_cursor(())),
    };
    if sort == Sort::Active && (waiting.is_none() || epoch.is_none()) {
        return Err(invalid_cursor(()));
    }
    Ok(Anchor {
        key: Key {
            id,
            updated: time,
            active: time,
            pinned: pinned.unwrap_or_default(),
            running: running.unwrap_or_default(),
            waiting: waiting.unwrap_or_default(),
        },
        previous,
        epoch,
    })
}

fn base64url(bytes: &[u8]) -> String {
    let mut output = String::new();
    let mut accumulator = 0u32;
    let mut bits = 0;
    for byte in bytes {
        accumulator = (accumulator << 8) | u32::from(*byte);
        bits += 8;
        while bits >= 6 {
            bits -= 6;
            output.push(ALPHABET[((accumulator >> bits) & 63) as usize] as char);
        }
    }
    if bits > 0 {
        output.push(ALPHABET[((accumulator << (6 - bits)) & 63) as usize] as char);
    }
    output
}

fn unbase64url(value: &str) -> Option<Vec<u8>> {
    if value.is_empty() || value.len() > MAX_CURSOR_BYTES {
        return None;
    }
    let mut accumulator = 0u32;
    let mut bits = 0;
    let mut bytes = Vec::new();
    for byte in value.bytes() {
        let index = ALPHABET.iter().position(|item| *item == byte)? as u32;
        accumulator = (accumulator << 6) | index;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            bytes.push((accumulator >> bits) as u8);
        }
    }
    (base64url(&bytes) == value).then_some(bytes)
}

fn text(value: &LosslessString) -> String {
    convert::readable(value)
}

fn invalid_cursor<E>(_: E) -> Failure {
    Failure::InvalidCursor("Invalid cursor".into())
}

fn unrepresentable() -> Failure {
    Failure::Unavailable("stored Session is not representable on the wire".into())
}
