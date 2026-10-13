use super::target;
use crate::{
    convert, cursor,
    dispatch::{Failure, Invocation},
    ids,
};
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::Arc,
};
use ycoding_core::{
    regexp::{Budget, RegExp},
    session::{
        list::{Parent, Query},
        prompt_cache::sha256,
    },
    ycoding_schema::{
        JsonValue, LosslessString, ObjectEncoder, location, session, session_message, shell,
    },
    ycoding_store::session::NewEvent,
};
use ycoding_protocol::v5;

pub async fn status(
    invocation: Invocation,
    _: v5::SessionStatusRequest,
) -> Result<v5::SessionStatusResult, Failure> {
    let core = invocation.core()?;
    let inventory = core
        .sessions
        .list(&Query::default())
        .map_err(|_| target::error(10, "Session inventory unavailable"))?
        .into_iter()
        .map(|info| Ok(target::living(core, &info.id)?.then_some((info.id.clone(), info))))
        .collect::<Result<Vec<_>, Failure>>()?
        .into_iter()
        .flatten()
        .collect::<BTreeMap<_, _>>();
    let root = |id: &session::Id| {
        let mut current = id.clone();
        let mut seen = BTreeSet::new();
        while seen.insert(current.clone()) {
            match inventory.get(&current)?.parent_id.as_ref() {
                Some(parent) => current = parent.clone(),
                None => return Some(current),
            }
        }
        None
    };
    let active = core.execution.active();
    let work = ycoding_core::session::outstanding::read(
        &core.sessions,
        &core.orchestration,
        core.execution.jobs(),
        &active,
        true,
    )
    .map_err(|_| target::error(10, "Outstanding work unavailable"))?;
    let roots = |ids: &BTreeSet<LosslessString>| {
        ids.iter()
            .filter_map(|id| session::Id::new(id.clone()).ok())
            .filter_map(|id| root(&id))
            .collect::<BTreeSet<_>>()
    };
    let running = roots(&work.running);
    let outstanding = roots(&work.sessions)
        .difference(&running)
        .cloned()
        .collect::<BTreeSet<_>>();
    let failed = roots(&work.failed);
    let lost = roots(&work.lost);
    let mut requests = BTreeSet::new();
    let mut locations = Vec::new();
    for id in &work.running {
        let Some(info) = session::Id::new(id.clone())
            .ok()
            .and_then(|id| inventory.get(&id))
        else {
            continue;
        };
        if locations.contains(&info.location) {
            continue;
        }
        locations.push(info.location.clone());
        let services = target::verify(core, &info.id)?.1;
        for permission in services.permissions.list() {
            if let Some(owner) = root(&permission.session_id) {
                requests.insert(owner);
            }
        }
        for form in services.forms.list(None) {
            if let Some(owner) = session::Id::new(form.session_id.clone())
                .ok()
                .and_then(|id| root(&id))
            {
                requests.insert(owner);
            }
        }
    }
    for root in &running {
        if !target::verify(core, root)?
            .1
            .guardrails
            .for_session(root)
            .map_err(|_| target::error(10, "Guardrail requests unavailable"))?
            .is_empty()
        {
            requests.insert(root.clone());
        }
    }
    let attention = requests
        .iter()
        .chain(failed.iter())
        .chain(lost.iter())
        .cloned()
        .collect::<BTreeSet<_>>();
    let failed = failed
        .difference(&requests)
        .filter(|id| !lost.contains(*id))
        .cloned()
        .collect::<BTreeSet<_>>();
    if [
        running.len(),
        attention.len(),
        outstanding.len(),
        failed.len(),
    ]
    .iter()
    .any(|count| *count > 500)
    {
        return Err(target::error(2, "Session status exceeds the root bound"));
    }
    let items = |ids: &BTreeSet<session::Id>| {
        ids.iter()
            .map(|id| convert::wire(id.as_lossless()))
            .collect()
    };
    Ok(v5::SessionStatusResult {
        running: v5::SessionStatusResultRunning {
            items: items(&running),
        },
        attention: v5::SessionStatusResultAttention {
            items: items(&attention),
        },
        outstanding: (!outstanding.is_empty()).then(|| v5::SessionStatusResultOutstanding {
            items: items(&outstanding),
        }),
        failed: (!failed.is_empty()).then(|| v5::SessionStatusResultFailed {
            items: items(&failed),
        }),
    })
}

fn selected(ids: &[v5::LosslessString]) -> Result<Vec<session::Id>, Failure> {
    let ids = ids
        .iter()
        .map(convert::identifier::<session::Id>)
        .collect::<Result<Vec<_>, _>>()?;
    if ids.iter().collect::<BTreeSet<_>>().len() != ids.len() {
        return Err(target::error(1, "Duplicate family member"));
    }
    Ok(ids)
}

pub async fn economics(
    invocation: Invocation,
    request: v5::SessionTeamEconomicsRequest,
) -> Result<v5::SessionTeamEconomicsResult, Failure> {
    let root = target::root(&invocation)?;
    let core = invocation.core()?;
    let members = selected(&request.payload.session_i_ds.items)?
        .iter()
        .map(|id| target::member(core, &root, id, true))
        .collect::<Result<Vec<_>, _>>()?;
    let items = members
        .iter()
        .map(|member| {
            let diagnostics = core
                .sessions
                .diagnostics(&member.id, None)
                .map_err(|_| target::error(10, "Session diagnostics unavailable"))?;
            let wire = convert::session_info(member)
                .map_err(|_| target::error(15, "Session is unrepresentable"))?;
            Ok(v5::SessionTeamEconomicsResultDataItem {
                session_id: wire.id,
                cost: wire.cost,
                tokens: wire.tokens,
                context_total: diagnostics
                    .as_ref()
                    .map(|value| value.context.total.get() as f64),
                context_limit: diagnostics
                    .as_ref()
                    .and_then(|value| value.context.limit.map(|value| value.get() as f64)),
                cache_hit_ratio: diagnostics.as_ref().and_then(|value| value.cache.hit_ratio),
                cache_read: diagnostics
                    .as_ref()
                    .filter(|value| value.cache.read_reported)
                    .map(|value| value.tokens.cache_read.get() as f64),
                cache_write: diagnostics
                    .as_ref()
                    .filter(|value| value.cache.write_reported)
                    .map(|value| value.tokens.cache_write.get() as f64),
            })
        })
        .collect::<Result<_, Failure>>()?;
    Ok(v5::SessionTeamEconomicsResult {
        data: v5::SessionTeamEconomicsResultData { items },
    })
}

pub async fn side_list(
    invocation: Invocation,
    request: v5::SessionSideChatListRequest,
) -> Result<v5::SessionSideChatListResult, Failure> {
    let root = target::root(&invocation)?;
    let query = match request.payload.cursor {
        Some(cursor) => cursor::decode_list(&convert::readable(&convert::domain(&cursor)?), 1024)?,
        None => Query {
            parent: Some(Parent::Child(root.id.clone())),
            ..Default::default()
        },
    };
    if query.parent != Some(Parent::Child(root.id.clone()))
        || query.workspace.is_some()
        || query.search.is_some()
        || query.scope != ycoding_core::session::list::Scope::All
    {
        return Err(target::error(1, "Child cursor belongs to another query"));
    }
    let rows = invocation
        .core()?
        .sessions
        .list(&Query {
            limit: Some(50),
            ..query.clone()
        })
        .map_err(|_| target::error(10, "Child Session list unavailable"))?;
    let link = |row: &session::Info, direction: &str| -> Result<v5::LosslessString, Failure> {
        Ok(convert::text(&cursor::encode_list(
            &query,
            &session::ListAnchor {
                id: row.id.clone(),
                time: ycoding_core::ycoding_schema::schema::Finite::new(
                    row.time.updated.epoch_millis() as f64,
                )
                .map_err(|_| target::error(15, "Child cursor is unrepresentable"))?,
                direction: direction.into(),
            },
        )))
    };
    Ok(v5::SessionSideChatListResult {
        data: v5::SessionSideChatListResultData {
            items: rows
                .iter()
                .filter(|row| {
                    row.parent_id.as_ref() == Some(&root.id)
                        && row
                            .agent
                            .as_ref()
                            .is_some_and(|agent| agent.as_str() == Some("btw"))
                })
                .map(|row| v5::SessionSideChatListResultDataItem {
                    id: convert::wire(row.id.as_lossless()),
                    title: convert::wire(&row.title),
                    updated_at: row.time.updated.epoch_millis() as f64,
                })
                .collect(),
        },
        cursor: v5::ConnectorCursor {
            previous: rows.first().map(|row| link(row, "previous")).transpose()?,
            next: rows.last().map(|row| link(row, "next")).transpose()?,
        },
    })
}

pub async fn side_create(
    invocation: Invocation,
    request: v5::SessionSideChatCreateRequest,
) -> Result<v5::SessionSideChatCreateResult, Failure> {
    let root = target::root(&invocation)?;
    let core = invocation.core()?;
    let id = convert::identifier::<session::Id>(&request.payload.id)?;
    let existing = core
        .sessions
        .get(&id)
        .map_err(|_| target::error(10, "Session store unavailable"))?;
    if existing.as_ref().is_some_and(|info| {
        info.parent_id.as_ref() != Some(&root.id)
            || info
                .agent
                .as_ref()
                .is_none_or(|agent| agent.as_str() != Some("btw"))
    }) {
        return Err(target::error(1, "Session ID belongs to another Session"));
    }
    let binding = if root
        .model
        .as_ref()
        .is_some_and(|model| model.profile.is_some())
    {
        Some(
            core.sessions
                .profile_binding(&root.id)
                .map_err(|_| target::error(10, "Profile binding unavailable"))?
                .ok_or_else(|| target::error(10, "Parent profile is not bound"))?,
        )
    } else {
        None
    };
    let now = ids::now_millis();
    let info = match existing {
        Some(info) => info,
        None => core
            .sessions
            .create(NewEvent {
                id: ids::event_id()
                    .map_err(|_| target::error(15, "Event ID unavailable"))?
                    .as_lossless()
                    .clone(),
                aggregate_id: id.as_lossless().clone(),
                created: now,
                type_: "session.created.2".into(),
                data: ObjectEncoder::new()
                    .field("sessionID", &id)
                    .field("parentID", &root.id)
                    .field("projectID", &root.project_id)
                    .field("location", &root.location)
                    .field("agent", "btw")
                    .optional("model", &root.model)
                    .optional("subpath", &root.subpath)
                    .optional("permissionCeiling", &root.permission_ceiling)
                    .field(
                        "title",
                        format!("New session - {}", crate::session_create::iso(now)).as_str(),
                    )
                    .field("created", &(now as f64))
                    .finish(),
            })
            .await
            .map_err(|_| target::error(15, "Side chat creation failed"))?,
    };
    if info.parent_id.as_ref() != Some(&root.id)
        || info
            .agent
            .as_ref()
            .is_none_or(|agent| agent.as_str() != Some("btw"))
        || info.location != root.location
        || info.project_id != root.project_id
    {
        return Err(target::error(1, "Session ID belongs to another Session"));
    }
    if info
        .model
        .as_ref()
        .is_some_and(|model| model.profile.is_some())
        && core
            .sessions
            .profile_binding(&id)
            .map_err(|_| target::error(10, "Profile binding unavailable"))?
            .is_none()
    {
        if root.model != info.model {
            return Err(target::error(
                10,
                "Side chat profile cannot be resolved from this parent selection",
            ));
        }
        let binding = binding.ok_or_else(|| target::error(10, "Parent profile is not bound"))?;
        core.sessions
            .publish(NewEvent {
                id: ids::event_id()
                    .map_err(|_| target::error(15, "Event ID unavailable"))?
                    .as_lossless()
                    .clone(),
                aggregate_id: id.as_lossless().clone(),
                created: ids::now_millis(),
                type_: "session.profile.bound.1".into(),
                data: ObjectEncoder::new()
                    .field("sessionID", &id)
                    .field("binding", &binding)
                    .finish(),
            })
            .await
            .map_err(|_| target::error(15, "Side chat profile binding failed"))?;
    }
    let snapshot = core
        .sessions
        .snapshot(&root.id, 20, None)
        .map_err(|_| target::error(10, "Parent snapshot unavailable"))?;
    let recent = snapshot
        .messages
        .iter()
        .flat_map(|message| match message {
            session_message::Info::User(message) => {
                vec![format!("User:\n{}", convert::readable(&message.text))]
            }
            session_message::Info::Synthetic(message) => {
                vec![format!("Context:\n{}", convert::readable(&message.text))]
            }
            session_message::Info::Assistant(message) => message
                .content
                .iter()
                .filter_map(|part| match part {
                    session_message::AssistantContent::Text(part) => {
                        Some(format!("Assistant:\n{}", convert::readable(&part.text)))
                    }
                    _ => None,
                })
                .collect(),
            _ => Vec::new(),
        })
        .collect::<Vec<_>>();
    let recent = &recent[recent.len().saturating_sub(12)..];
    let child = Invocation {
        environment: invocation.environment.clone(),
        connection_id: invocation.connection_id.clone(),
        scope: v5::Scope {
            target: Some(v5::scope::Target::Session(convert::readable(
                id.as_lossless(),
            ))),
        },
        request_id: invocation.request_id.clone(),
    };
    crate::session_services::synthetic(
        child,
        v5::SessionSyntheticRequest {
            params: v5::SessionSyntheticRequestParams {
                session_id: convert::wire(id.as_lossless()),
            },
            payload: v5::SessionSyntheticRequestPayload {
                id: Some(convert::text(&format!(
                    "msg_{}",
                    sha256(&format!(
                        "ycoding.btw.context.v1\0{}",
                        convert::readable(id.as_lossless())
                    ))
                ))),
                text: convert::text(
                    &["Recent parent session history:".into(), recent.join("\n\n")].join("\n\n"),
                ),
                description: Some(convert::text("Parent session history snapshot")),
                metadata: None,
                delivery: None,
                resume: Some(false),
            },
        },
    )
    .await?;
    let info = target::verify(core, &id)?.0;
    Ok(v5::SessionSideChatCreateResult {
        data: convert::session_info(&info)
            .map_err(|_| target::error(15, "Side chat is unrepresentable"))?,
    })
}

fn platforms(
    invocation: &Invocation,
    root: &session::Info,
) -> Result<Vec<(location::Ref, Arc<crate::PlatformServices>)>, Failure> {
    let core = invocation.core()?;
    let resolver = core
        .platform
        .as_ref()
        .ok_or_else(|| target::error(10, "Location platform services are not composed"))?;
    let children = core
        .sessions
        .list(&Query {
            parent: Some(Parent::Child(root.id.clone())),
            ..Default::default()
        })
        .map_err(|_| target::error(10, "Family inventory unavailable"))?;
    let mut locations = vec![root.location.clone()];
    for child in children {
        let current = target::member(core, root, &child.id, false)?;
        if !locations.contains(&current.location) {
            if locations.len() >= 16 {
                return Err(target::error(2, "Family spans too many Locations"));
            }
            locations.push(current.location);
        }
    }
    locations
        .into_iter()
        .map(|location| {
            let services = resolver(&location)
                .map_err(|_| target::error(10, "Location shell services unavailable"))?;
            if services.shell.directory()
                != std::path::Path::new(&convert::readable(location.directory.as_lossless()))
            {
                return Err(target::error(
                    10,
                    "Shell resolver returned another Location",
                ));
            }
            Ok((location, services))
        })
        .collect()
}

fn owner(info: &shell::Info) -> Option<session::Id> {
    match info.metadata.get(&"sessionID".into()) {
        Some(JsonValue::String(id)) => session::Id::new(id.clone()).ok(),
        _ => None,
    }
}

pub async fn shell_list(
    invocation: Invocation,
    _: v5::SessionTeamShellListRequest,
) -> Result<v5::SessionTeamShellListResult, Failure> {
    let root = target::root(&invocation)?;
    let core = invocation.core()?;
    let mut items = Vec::new();
    for (location, platform) in platforms(&invocation, &root)? {
        for shell in platform.shell.list() {
            let Some(id) = owner(&shell) else {
                continue;
            };
            let Ok(member) = target::member(core, &root, &id, false) else {
                continue;
            };
            if member.location != location {
                continue;
            }
            if items.len() == 50 {
                return Ok(v5::SessionTeamShellListResult {
                    data: v5::SessionTeamShellListResultData { items },
                    truncated: true,
                });
            }
            items.push(v5::SessionTeamShellListResultDataItem {
                id: convert::identity(&shell.id)?,
                owner_id: convert::wire(id.as_lossless()),
                command: convert::wire(&LosslessString::from_utf16(
                    shell.command.code_units().take(256).collect(),
                )),
                status: convert::text(shell.status.as_str()),
                started_at: shell.time.started.get(),
                completed_at: shell.time.completed.map(|value| value.get()),
            });
        }
    }
    Ok(v5::SessionTeamShellListResult {
        data: v5::SessionTeamShellListResultData { items },
        truncated: false,
    })
}

pub async fn shell_kill(
    invocation: Invocation,
    request: v5::SessionTeamShellKillRequest,
) -> Result<v5::SessionTeamShellKillResult, Failure> {
    let root = target::root(&invocation)?;
    let core = invocation.core()?;
    let id = convert::identifier::<shell::Id>(&request.payload.shell_id)?;
    for (location, platform) in platforms(&invocation, &root)? {
        let shell = match platform.shell.get(&id).await {
            Ok(shell) => shell,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(_) => return Err(target::error(10, "Shell service unavailable")),
        };
        let owner =
            owner(&shell).ok_or_else(|| target::error(12, "Shell has no verified family owner"))?;
        if target::member(core, &root, &owner, false)?.location != location {
            return Err(target::error(12, "Shell Location does not match its owner"));
        }
        platform
            .shell
            .remove(&id)
            .await
            .map_err(|_| target::error(11, "Shell removal outcome is unknown"))?;
        return Ok(v5::SessionTeamShellKillResult { data: v5::Empty {} });
    }
    Err(target::error(7, "Shell is unavailable in this family"))
}

pub async fn activity(
    invocation: Invocation,
    request: v5::SessionFamilyActivityRequest,
) -> Result<v5::SessionFamilyActivityResult, Failure> {
    let root = target::session(&invocation)?.0;
    if root.parent_id.is_some() {
        return Err(target::error(5, "Family activity requires a root Session"));
    }
    let core = invocation.core()?;
    let ids = selected(&request.payload.session_i_ds.items)?;
    if ids.contains(&root.id) {
        return Err(target::error(
            5,
            "Family activity accepts direct children only",
        ));
    }
    let members = std::iter::once(Ok(root.clone()))
        .chain(ids.iter().map(|id| {
            let member = target::verify(core, id)?.0;
            if member.parent_id.as_ref() != Some(&root.id) {
                return Err(target::error(5, "Session is not a direct family member"));
            }
            Ok(member)
        }))
        .collect::<Result<Vec<_>, Failure>>()?;
    let executing = core.execution.active().into_iter().collect::<BTreeSet<_>>();
    let items = members
        .iter()
        .map(|member| {
            let active = executing.contains(&member.id);
            let activity = if active {
                let snapshot = core
                    .sessions
                    .snapshot(&member.id, 8, None)
                    .map_err(|_| target::error(10, "Family snapshot unavailable"))?;
                Some(summarize(&snapshot.messages)?)
            } else {
                None
            };
            Ok(v5::SessionFamilyActivityResultDataItem {
                session_id: convert::wire(member.id.as_lossless()),
                executing: active,
                activity,
            })
        })
        .collect::<Result<_, Failure>>()?;
    Ok(v5::SessionFamilyActivityResult {
        data: v5::SessionFamilyActivityResultData { items },
    })
}

fn bounded(value: &str, maximum: usize) -> String {
    let clean = value
        .chars()
        .map(|ch| {
            if ch <= '\u{1f}'
                || ('\u{7f}'..='\u{9f}').contains(&ch)
                || ('\u{202a}'..='\u{202e}').contains(&ch)
                || ('\u{2066}'..='\u{2069}').contains(&ch)
            {
                ' '
            } else {
                ch
            }
        })
        .collect::<String>();
    let clean = clean
        .split(|ch: char| ch.is_whitespace() || ch == '\u{feff}')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    if clean.chars().count() <= maximum {
        return clean;
    }
    format!("{}…", clean.chars().take(maximum - 1).collect::<String>())
}

fn capture(pattern: &str, flags: &str, value: &str) -> Result<Option<String>, Failure> {
    let mut regexp = RegExp::new(&pattern.encode_utf16().collect::<Vec<_>>(), flags)
        .map_err(|_| target::error(15, "Activity matcher unavailable"))?;
    let matched = regexp
        .exec(
            &value.encode_utf16().collect::<Vec<_>>(),
            &mut Budget {
                remaining: Some(1_000_000),
                cancelled: None,
            },
        )
        .map_err(|_| target::error(15, "Activity matcher failed"))?;
    Ok(matched
        .and_then(|matched| matched.captures.into_iter().next().flatten())
        .map(|units| String::from_utf16_lossy(&units)))
}

fn summarize(
    messages: &[session_message::Info],
) -> Result<v5::SessionFamilyActivityResultDataItemActivity, Failure> {
    let assistant = messages.iter().rev().find_map(|message| match message {
        session_message::Info::Assistant(message) if message.time.completed.is_none() => {
            Some(message)
        }
        _ => None,
    });
    let part = assistant.and_then(|message| message.content.last());
    let action = |kind, room, text: String| v5::SessionFamilyActivityResultDataItemActivity {
        kind,
        room,
        text: convert::text(&bounded(&text, 80)),
    };
    if matches!(part, Some(session_message::AssistantContent::Reasoning(reasoning)) if reasoning.time.as_ref().is_none_or(|time| time.completed.is_none()))
    {
        return Ok(action(2, 5, "Thinking".into()));
    }
    let Some(session_message::AssistantContent::Tool(tool)) = part else {
        return Ok(action(
            3,
            4,
            if part.is_none() {
                "Preparing next step"
            } else {
                "Replying"
            }
            .into(),
        ));
    };
    let input = match &tool.state {
        session_message::ToolState::Running(state) => Some(&state.input),
        session_message::ToolState::Streaming(_) => None,
        _ => return Ok(action(3, 4, "Replying".into())),
    };
    let value = |key: &str| {
        input
            .and_then(|input| input.get(&key.into()))
            .and_then(|value| match value {
                JsonValue::String(value) => Some(convert::readable(value)),
                _ => None,
            })
            .unwrap_or_default()
    };
    let tool = convert::readable(&tool.name);
    let leaf = |path: String| {
        path.rsplit(['/', '\\'])
            .next()
            .unwrap_or("")
            .chars()
            .filter(|ch| ch.is_alphanumeric() || matches!(ch, '.' | '_' | '-'))
            .collect::<String>()
    };
    let label = |label: &str, subject: String| {
        if subject.is_empty() {
            label.into()
        } else {
            format!("{label} {subject}")
        }
    };
    Ok(match tool.as_str() {
        "read" | "glob" => action(
            1,
            1,
            label(
                if tool == "read" {
                    "Reading"
                } else {
                    "Finding files"
                },
                leaf(if value("path").is_empty() {
                    value("pattern")
                } else {
                    value("path")
                }),
            ),
        ),
        "grep" | "websearch" => {
            let query = if value("query").is_empty() {
                value("pattern")
            } else {
                value("query")
            };
            let safe = capture(
                r"\b(?:api[_-]?key|token|secret|password|bearer)\b|sk-|[A-Za-z0-9_-]{32,}|@|:\/\/",
                "i",
                &query,
            )?
            .is_none();
            action(
                1,
                1,
                if safe && !query.is_empty() {
                    label("Searching:", bounded(&query, 42))
                } else {
                    "Searching".into()
                },
            )
        }
        "webfetch" => action(
            1,
            1,
            label(
                "Fetching",
                url::Url::parse(&value("url"))
                    .ok()
                    .and_then(|url| url.host_str().map(String::from))
                    .unwrap_or_default(),
            ),
        ),
        "subagent" | "subagent_control" | "subagent_report" | "todowrite" => action(
            1,
            3,
            if tool == "todowrite" {
                "Planning tasks"
            } else {
                "Dispatching a subagent"
            }
            .into(),
        ),
        "patch" | "write" | "edit_image" => {
            let path = if value("path").is_empty() {
                capture(
                    r"^\*\*\* (?:Update|Add) File: [^\r\n]+",
                    "m",
                    &value("patchText"),
                )?
                .and_then(|line| line.split_once(": ").map(|(_, path)| path.into()))
                .unwrap_or_default()
            } else {
                value("path")
            };
            action(1, 4, label("Editing", leaf(path)))
        }
        "shell" => {
            let command = value("command");
            if let Some(check) = capture(
                r"\b(?:bun|npm|pnpm|yarn) (?:test|run (?:typecheck|lint))\b(?: [./\w-]+)?",
                "i",
                &command,
            )? {
                action(1, 2, label("Running", check))
            } else if capture(
                r"\b(?:pytest|vitest|jest|tsc|eslint|oxlint)\b",
                "i",
                &command,
            )?
            .is_some()
            {
                action(1, 2, "Running checks".into())
            } else if capture(r"\b(?:rg|grep|find|ls|cat)\b", "", &command)?.is_some() {
                action(1, 1, "Searching files".into())
            } else {
                action(1, 4, "Running a command".into())
            }
        }
        _ => action(
            1,
            4,
            label(
                "Using",
                tool.chars()
                    .filter(|ch| ch.is_alphanumeric() || matches!(ch, '_' | '-'))
                    .collect(),
            ),
        ),
    })
}
