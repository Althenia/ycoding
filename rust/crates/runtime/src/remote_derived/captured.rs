use super::target;
use crate::{
    Core, convert,
    dispatch::{Failure, Invocation},
};
use futures_util::{
    FutureExt,
    future::{BoxFuture, Shared, WeakShared},
};
use std::{
    collections::{BTreeMap, VecDeque},
    sync::{Arc, Mutex, PoisonError},
};
use ycoding_core::{
    regexp::{Budget, RegExp},
    session::{orchestration, prompt_cache::sha256},
    ycoding_schema::{
        JsonPath, JsonValue, LosslessString, ObjectDecoder, ObjectEncoder, parse_json, session,
        session_captured_changes::{File, Input, InputType, Tool},
        stringify_json,
    },
};
use ycoding_protocol::v5;

const MAX_CHARS: usize = 512_000;
const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

type ReadFuture = BoxFuture<'static, Result<Arc<Captured>, Failure>>;
type Flight = Shared<ReadFuture>;

#[derive(Default)]
pub(crate) struct Cache(Mutex<State>);

#[derive(Default)]
struct State {
    clock: u64,
    floor: u64,
    activity: BTreeMap<LosslessString, u64>,
    entries: BTreeMap<session::Id, Arc<Captured>>,
    order: VecDeque<session::Id>,
    flights: BTreeMap<(session::Id, String), WeakShared<ReadFuture>>,
}

impl State {
    fn mark(&mut self, id: LosslessString) {
        self.clock += 1;
        self.activity.insert(id, self.clock);
        if self.activity.len() > 4096
            && let Some((id, at)) = self
                .activity
                .iter()
                .min_by_key(|(_, at)| *at)
                .map(|(id, at)| (id.clone(), *at))
        {
            self.activity.remove(&id);
            self.floor = self.floor.max(at);
        }
    }
    fn changed(&self, id: &session::Id, read_at: u64) -> bool {
        self.activity
            .get(id.as_lossless())
            .copied()
            .unwrap_or(self.floor)
            > read_at
    }
}

impl Cache {
    pub(crate) fn attach(client: &ycoding_core::ycoding_store::Client) -> Arc<Self> {
        let cache = Arc::new(Self::default());
        let weak = Arc::downgrade(&cache);
        client.observe_events(move |events| {
            let Some(cache) = weak.upgrade() else {
                return false;
            };
            let mut state = cache.0.lock().unwrap_or_else(PoisonError::into_inner);
            for event in events {
                state.mark(event.aggregate_id.clone());
            }
            true
        });
        cache
    }
    fn flight(&self, core: Core, owner: session::Info, epoch: String) -> Flight {
        let mut state = self.0.lock().unwrap_or_else(PoisonError::into_inner);
        state.flights.retain(|_, flight| flight.upgrade().is_some());
        let key = (owner.id.clone(), epoch.clone());
        if let Some(flight) = state.flights.get(&key).and_then(WeakShared::upgrade) {
            return flight;
        }
        let id = owner.id.clone();
        let read_at = state.clock;
        let cached = state.entries.get(&id).cloned();
        let flight = async move { load(&core, owner, epoch, read_at, cached).await }
            .boxed()
            .shared();
        if let Some(weak) = flight.downgrade() {
            state.flights.insert(key, weak);
        }
        flight
    }
    fn invalidate(&self, id: &session::Id) {
        let mut state = self.0.lock().unwrap_or_else(PoisonError::into_inner);
        state.entries.remove(id);
        state.order.retain(|entry| entry != id);
    }
}

struct Member {
    info: session::Info,
    position: Option<i64>,
    inputs: Arc<Vec<Input>>,
}

struct Captured {
    epoch: String,
    read_at: u64,
    owner: session::Info,
    parent_position: Option<i64>,
    parent: Arc<Vec<Input>>,
    members: BTreeMap<session::Id, Member>,
    groups: Arc<Vec<v5::ConnectorCapturedGroup>>,
    digest: String,
}

pub async fn list(
    invocation: Invocation,
    request: v5::SessionCapturedChangesListRequest,
) -> Result<v5::SessionCapturedChangesListResult, Failure> {
    let (owner, _) = target::session(&invocation)?;
    let core = invocation.core()?;
    tracing::debug!(session = %convert::readable(owner.id.as_lossless()), "captured read requested");
    let captured = match core
        .captured
        .flight(
            core.clone(),
            owner.clone(),
            invocation
                .environment
                .services
                .identity
                .source_epoch
                .clone(),
        )
        .await
    {
        Ok(captured) => captured,
        Err(error) => {
            core.captured.invalidate(&owner.id);
            return Err(error);
        }
    };
    if let Err(error) = stable(core, &captured) {
        core.captured.invalidate(&owner.id);
        return Err(error);
    }
    let groups = &captured.groups;
    let digest = &captured.digest;
    let offset = match request.payload.cursor {
        Some(cursor) => decode_cursor(
            &convert::readable(&convert::domain(&cursor)?),
            digest,
            groups.len(),
        )?,
        None => 0,
    };
    let mut page = Vec::new();
    for group in groups.iter().skip(offset) {
        if page.len() >= 100
            || !page.is_empty()
                && chars(&JsonValue::Array(
                    page.iter()
                        .chain(std::iter::once(group))
                        .map(group_json)
                        .collect(),
                )) > MAX_CHARS
        {
            break;
        }
        page.push(group.clone());
    }
    let next = offset + page.len();
    Ok(v5::SessionCapturedChangesListResult {
        data: v5::SessionCapturedChangesListResultData { items: page },
        cursor: (next < groups.len()).then(|| v5::SessionCapturedChangesListResultCursor {
            next: Some(convert::text(&encode(
                stringify_json(
                    &ObjectEncoder::new()
                        .field("offset", &(next as f64))
                        .field("digest", digest.as_str())
                        .finish(),
                )
                .as_bytes(),
            ))),
        }),
    })
}

async fn load(
    core: &Core,
    owner: session::Info,
    epoch: String,
    read_at: u64,
    cached: Option<Arc<Captured>>,
) -> Result<Arc<Captured>, Failure> {
    let parent_position = position(core, &owner.id)?;
    let cached = cached.filter(|entry| entry.epoch == epoch);
    if let Some(entry) = &cached
        && (entry.owner.parent_id != owner.parent_id || entry.owner.location != owner.location)
    {
        return Err(target::error(15, "Captured ownership changed"));
    }
    let parent = match &cached {
        Some(entry) if entry.parent_position == parent_position => entry.parent.clone(),
        _ => Arc::new(read(core, &owner.id).await?),
    };
    let mut members = BTreeMap::new();
    if owner.parent_id.is_none() {
        let ids = parent
            .iter()
            .filter(|input| input.kind == InputType::Assistant)
            .flat_map(|input| {
                input
                    .content
                    .iter()
                    .flatten()
                    .filter_map(|tool| dispatch(tool).map(|dispatch| dispatch.child))
            })
            .collect::<Vec<_>>();
        for id in ids {
            if members.contains_key(&id) {
                continue;
            }
            let child = match target::verify(core, &id) {
                Ok((child, _)) => child,
                Err(Failure::Connector { code: 5, .. })
                    if cached
                        .as_ref()
                        .is_none_or(|entry| !entry.members.contains_key(&id)) =>
                {
                    continue;
                }
                Err(error) => return Err(error),
            };
            if child.parent_id.as_ref() != Some(&owner.id)
                || child
                    .agent
                    .as_ref()
                    .is_some_and(|agent| agent.as_str() == Some("btw"))
            {
                if cached
                    .as_ref()
                    .is_some_and(|entry| entry.members.contains_key(&id))
                {
                    return Err(target::error(15, "Captured ownership changed"));
                }
                continue;
            }
            let mark = position(core, &id)?;
            let previous = cached.as_ref().and_then(|entry| entry.members.get(&id));
            if previous.is_some_and(|member| {
                member.info.location != child.location || member.info.parent_id != child.parent_id
            }) {
                return Err(target::error(15, "Captured ownership changed"));
            }
            let inputs = match previous {
                Some(member) if member.position == mark => member.inputs.clone(),
                _ => Arc::new(read(core, &id).await?),
            };
            members.insert(
                id,
                Member {
                    info: child,
                    position: mark,
                    inputs,
                },
            );
        }
    }
    let unchanged = cached.as_ref().filter(|entry| {
        entry.parent_position == parent_position
            && entry.members.len() == members.len()
            && members.iter().all(|(id, member)| {
                entry
                    .members
                    .get(id)
                    .is_some_and(|previous| previous.position == member.position)
            })
    });
    let (groups, digest) = match unchanged {
        Some(entry) => (entry.groups.clone(), entry.digest.clone()),
        None => {
            tracing::debug!(session = %convert::readable(owner.id.as_lossless()), "captured summary built");
            let children = members
                .iter()
                .map(|(id, member)| (id.clone(), member.inputs.as_ref().clone()))
                .collect();
            let mut groups = summarize(&owner.id, &parent, &children)?;
            for group in &mut groups {
                if chars(&group_json(group)) > MAX_CHARS {
                    group.additions = 0;
                    group.deletions = 0;
                    group.files.items = vec![v5::ConnectorCapturedFile {
                        path: group.path.clone(),
                        diff: convert::text(""),
                        additions: 0,
                        deletions: 0,
                        status: group.status,
                        unavailable: Some(true),
                    }];
                }
            }
            let digest = sha256(&format!(
                "{}{}",
                convert::readable(owner.id.as_lossless()),
                stringify_json(&JsonValue::Array(groups.iter().map(group_json).collect()))
            ));
            (Arc::new(groups), digest)
        }
    };
    let captured = Arc::new(Captured {
        epoch,
        read_at,
        owner,
        parent_position,
        parent,
        members,
        groups,
        digest,
    });
    stable(core, &captured)?;
    let mut state = core
        .captured
        .0
        .lock()
        .unwrap_or_else(PoisonError::into_inner);
    state.order.retain(|id| id != &captured.owner.id);
    state.order.push_back(captured.owner.id.clone());
    state
        .entries
        .insert(captured.owner.id.clone(), captured.clone());
    if state.entries.len() > 32
        && let Some(oldest) = state.order.pop_front()
    {
        state.entries.remove(&oldest);
    }
    Ok(captured)
}

fn stable(core: &Core, captured: &Captured) -> Result<(), Failure> {
    for (info, mark) in std::iter::once((&captured.owner, captured.parent_position)).chain(
        captured
            .members
            .values()
            .map(|member| (&member.info, member.position)),
    ) {
        let current = target::verify(core, &info.id)?.0;
        if current.parent_id != info.parent_id
            || current.location != info.location
            || current.project_id != info.project_id
            || current.agent != info.agent
            || position(core, &info.id)? != mark
        {
            return Err(target::error(15, "Captured changes changed while reading"));
        }
    }
    let state = core
        .captured
        .0
        .lock()
        .unwrap_or_else(PoisonError::into_inner);
    if state.changed(&captured.owner.id, captured.read_at)
        || captured
            .members
            .keys()
            .any(|id| state.changed(id, captured.read_at))
    {
        return Err(target::error(15, "Captured changes changed while reading"));
    }
    Ok(())
}

fn position(core: &Core, id: &session::Id) -> Result<Option<i64>, Failure> {
    let snapshot = core
        .sessions
        .snapshot(id, 1, None)
        .map_err(|_| target::error(10, "Captured change position unavailable"))?;
    Ok(snapshot.watermark)
}

#[cfg(test)]
mod cache_tests {
    use super::State;
    #[test]
    fn activity_is_bounded_and_eviction_retains_an_invalidation_floor() {
        let mut state = State::default();
        state.mark("ses_changed".into());
        for index in 0..4096 {
            state.mark(format!("ses_other_{index}").into());
        }
        assert_eq!(state.activity.len(), 4096);
        assert!(!state.activity.contains_key(&"ses_changed".into()));
        assert!(state.changed(
            &ycoding_core::ycoding_schema::session::Id::new("ses_changed").unwrap(),
            0
        ));
        let read_at = state.clock;
        state.mark("ses_new".into());
        assert!(!state.changed(
            &ycoding_core::ycoding_schema::session::Id::new("ses_unrelated").unwrap(),
            read_at
        ));
    }
}

async fn read(core: &Core, id: &session::Id) -> Result<Vec<Input>, Failure> {
    let mut output = Vec::new();
    let mut after = None;
    loop {
        tokio::task::yield_now().await;
        tracing::debug!(session = %convert::readable(id.as_lossless()), "captured input page read");
        let page = core
            .sessions
            .captured_inputs(id, after, 200)
            .map_err(|_| target::error(10, "Captured change inputs unavailable"))?;
        output.extend(page.data);
        let Some(next) = page.next else {
            return Ok(output);
        };
        after = Some(next.get());
    }
}

#[derive(Clone)]
struct Dispatch {
    child: session::Id,
    boundary: Boundary,
}
#[derive(Clone)]
enum Boundary {
    Launch,
    Send(LosslessString),
    Answer(Option<LosslessString>),
}

fn dispatch(tool: &Tool) -> Option<Dispatch> {
    let structured = tool.state.structured.as_ref()?;
    if tool.name.as_str() == Some("subagent") {
        return Some(Dispatch {
            child: session::Id::new(structured.session_id.clone()?).ok()?,
            boundary: Boundary::Launch,
        });
    }
    if tool.name.as_str() != Some("subagent_control")
        || tool.state.status.as_ref()?.as_str() != Some("completed")
    {
        return None;
    }
    let child = session::Id::new(structured.task.as_ref()?.session_id.clone()?).ok()?;
    let boundary = match structured.action.as_ref()?.as_str()? {
        "send" => Boundary::Send(tool.id.clone()?),
        "answer" => Boundary::Answer(
            tool.state
                .input
                .as_ref()
                .and_then(|input| input.question_id.clone()),
        ),
        _ => return None,
    };
    Some(Dispatch { child, boundary })
}

fn summarize(
    owner: &session::Id,
    parent: &[Input],
    children: &BTreeMap<session::Id, Vec<Input>>,
) -> Result<Vec<v5::ConnectorCapturedGroup>, Failure> {
    let mut units = Vec::<Vec<&Input>>::new();
    for input in parent {
        if input.kind == InputType::User || units.is_empty() {
            units.push(Vec::new());
        }
        units
            .last_mut()
            .expect("captured unit initialized")
            .push(input);
    }
    let mut claims = Vec::new();
    for (unit, inputs) in units.iter().enumerate() {
        for input in inputs
            .iter()
            .filter(|input| input.kind == InputType::Assistant)
        {
            for dispatch in input.content.iter().flatten().filter_map(dispatch) {
                let Some(child) = children.get(&dispatch.child) else {
                    continue;
                };
                let index = child.iter().position(|message| match &dispatch.boundary {
                    Boundary::Launch => message.kind == InputType::User,
                    Boundary::Send(call) => {
                        message.id
                            == orchestration::send_message_id(
                                &convert::readable(owner.as_lossless()),
                                &convert::readable(input.id.as_lossless()),
                                &convert::readable(call),
                            )
                    }
                    Boundary::Answer(Some(question)) => {
                        message.kind == InputType::Synthetic
                            && message.metadata.as_ref().is_some_and(|metadata| {
                                metadata
                                    .kind
                                    .as_ref()
                                    .is_some_and(|kind| kind.as_str() == Some("answer"))
                                    && metadata.question_id.as_ref() == Some(question)
                            })
                    }
                    Boundary::Answer(None) => false,
                });
                if let Some(index) = index
                    && !claims
                        .iter()
                        .any(|(_, id, existing)| id == &dispatch.child && *existing == index)
                {
                    claims.push((unit, dispatch.child, index));
                }
            }
        }
    }
    let mut output = Vec::new();
    for (unit, messages) in units.iter().enumerate() {
        let Some(placement) = messages
            .iter()
            .rev()
            .find(|input| input.kind == InputType::Assistant)
        else {
            continue;
        };
        let mut patches = patches(messages.iter().copied())?;
        for (_, id, index) in claims.iter().filter(|(claimed, _, _)| *claimed == unit) {
            let child = &children[id];
            let end = child
                .iter()
                .enumerate()
                .skip(index + 1)
                .find(|(position, input)| {
                    input.kind == InputType::User
                        || input.kind == InputType::Synthetic
                            && input.metadata.as_ref().is_some_and(|metadata| {
                                metadata
                                    .kind
                                    .as_ref()
                                    .is_some_and(|kind| kind.as_str() == Some("answer"))
                            })
                        || claims
                            .iter()
                            .any(|(_, other, boundary)| other == id && boundary == position)
                })
                .map_or(child.len(), |(position, _)| position);
            patches.extend(patches_from_slice(&child[*index..end])?);
        }
        let mut groups = Vec::<v5::ConnectorCapturedGroup>::new();
        for patch in patches {
            if let Some(group) = groups.iter_mut().find(|group| group.path == patch.path) {
                group.additions += patch.additions;
                group.deletions += patch.deletions;
                if group.status != patch.status {
                    group.status = 3;
                }
                group.files.items.push(patch);
                continue;
            }
            groups.push(v5::ConnectorCapturedGroup {
                placement_message_id: convert::wire(placement.id.as_lossless()),
                path: patch.path.clone(),
                additions: patch.additions,
                deletions: patch.deletions,
                status: patch.status,
                files: v5::ConnectorCapturedGroupFiles { items: vec![patch] },
            });
        }
        output.extend(groups);
    }
    Ok(output)
}

fn patches_from_slice(messages: &[Input]) -> Result<Vec<v5::ConnectorCapturedFile>, Failure> {
    patches(messages.iter())
}

fn patches<'a>(
    messages: impl Iterator<Item = &'a Input>,
) -> Result<Vec<v5::ConnectorCapturedFile>, Failure> {
    let mut output = Vec::new();
    for tool in messages
        .filter(|message| message.kind == InputType::Assistant)
        .flat_map(|message| message.content.iter().flatten())
    {
        if !matches!(tool.name.as_str(), Some("edit" | "patch" | "apply_patch"))
            || tool
                .state
                .status
                .as_ref()
                .is_none_or(|status| status.as_str() != Some("completed"))
        {
            continue;
        }
        for file in tool
            .state
            .structured
            .iter()
            .flat_map(|structured| structured.files.iter().flatten())
        {
            if let Some(file) = patch(file)? {
                output.push(file);
            }
        }
    }
    Ok(output)
}

fn patch(file: &File) -> Result<Option<v5::ConnectorCapturedFile>, Failure> {
    let units = file.patch.code_units().collect::<Vec<_>>();
    let normalized = units
        .iter()
        .enumerate()
        .filter(|(index, unit)| **unit != 13 || units.get(index + 1) != Some(&10))
        .map(|(_, unit)| *unit)
        .collect::<Vec<_>>();
    let lines = normalized.split(|unit| *unit == 10).collect::<Vec<_>>();
    let mut old_path = None;
    let mut new_path = None;
    let mut expected = (0u64, 0u64);
    let mut consumed = (0u64, 0u64);
    let mut counts = (0u64, 0u64);
    let mut hunk = false;
    let mut found = false;
    let mut header = RegExp::new(
        &r"^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@"
            .encode_utf16()
            .collect::<Vec<_>>(),
        "",
    )
    .map_err(|_| target::error(15, "Patch matcher unavailable"))?;
    let starts =
        |line: &[u16], prefix: &str| line.starts_with(&prefix.encode_utf16().collect::<Vec<_>>());
    let path = |line: &[u16]| {
        line[4..]
            .split(|unit| *unit == 9)
            .next()
            .unwrap_or(&[])
            .to_vec()
    };
    for (index, line) in lines.iter().enumerate() {
        if starts(line, "--- ") && !hunk {
            old_path = Some(path(line));
            continue;
        }
        if starts(line, "+++ ") && !hunk {
            new_path = Some(path(line));
            continue;
        }
        if starts(line, "@@") {
            let Some(matched) = header
                .exec(
                    line,
                    &mut Budget {
                        remaining: Some(100_000),
                        cancelled: None,
                    },
                )
                .map_err(|_| target::error(15, "Patch matcher failed"))?
            else {
                return Ok(None);
            };
            if hunk && consumed != expected {
                return Ok(None);
            }
            let number = |position: usize| {
                matched
                    .captures
                    .get(position)
                    .and_then(|value| value.as_ref())
                    .map(|value| {
                        String::from_utf16_lossy(value)
                            .parse::<u64>()
                            .ok()
                            .filter(|value| *value <= 9_007_199_254_740_991)
                    })
                    .unwrap_or(Some(1))
            };
            if number(1).is_none() || number(3).is_none() {
                return Ok(None);
            }
            let (Some(old), Some(new)) = (number(2), number(4)) else {
                return Ok(None);
            };
            expected = (old, new);
            consumed = (0, 0);
            hunk = true;
            found = true;
            continue;
        }
        if hunk
            && consumed == expected
            && (starts(line, "diff --git ") || starts(line, "Index: ") || starts(line, "--- "))
        {
            hunk = false;
            if starts(line, "--- ") {
                old_path = Some(path(line));
            }
            continue;
        }
        if !hunk {
            continue;
        }
        if starts(line, "\\ No newline at end of file")
            || line.is_empty() && index == lines.len() - 1
        {
            continue;
        }
        match line.first() {
            Some(32) => {
                consumed.0 += 1;
                consumed.1 += 1;
            }
            Some(45) => {
                consumed.0 += 1;
                counts.1 += 1;
            }
            Some(43) => {
                consumed.1 += 1;
                counts.0 += 1;
            }
            _ => return Ok(None),
        }
    }
    if !found || hunk && consumed != expected {
        return Ok(None);
    }
    let dev_null = "/dev/null".encode_utf16().collect::<Vec<_>>();
    let status = if matches!(
        file.status.as_ref().and_then(LosslessString::as_str),
        Some("added" | "created")
    ) || old_path.as_ref() == Some(&dev_null)
    {
        1
    } else if matches!(
        file.status.as_ref().and_then(LosslessString::as_str),
        Some("deleted" | "removed")
    ) || new_path.as_ref() == Some(&dev_null)
    {
        2
    } else {
        3
    };
    let resolved = file.file.clone().unwrap_or_else(|| {
        let path = new_path
            .into_iter()
            .chain(old_path)
            .find(|path| !path.is_empty() && path != &dev_null)
            .unwrap_or_else(|| "unknown".encode_utf16().collect());
        LosslessString::from_utf16(
            if path.len() >= 2 && matches!(path[0], 97 | 98) && path[1] == 47 {
                path[2..].to_vec()
            } else {
                path
            },
        )
    });
    Ok(Some(v5::ConnectorCapturedFile {
        diff: convert::wire(&file.patch),
        path: convert::wire(&resolved),
        additions: counts.0,
        deletions: counts.1,
        status,
        unavailable: None,
    }))
}

fn group_json(group: &v5::ConnectorCapturedGroup) -> JsonValue {
    let status = |value| match value {
        1 => "created",
        2 => "deleted",
        _ => "modified",
    };
    let scalar = |value: &v5::LosslessString| {
        JsonValue::String(convert::domain(value).expect("constructed captured field"))
    };
    let files = group
        .files
        .items
        .iter()
        .map(|file| {
            let value = if file.unavailable == Some(true) {
                ObjectEncoder::new()
                    .field("path", &scalar(&file.path))
                    .field("diff", &scalar(&file.diff))
            } else {
                ObjectEncoder::new()
                    .field("diff", &scalar(&file.diff))
                    .field("path", &scalar(&file.path))
            };
            value
                .field("additions", &(file.additions as f64))
                .field("deletions", &(file.deletions as f64))
                .field("status", status(file.status))
                .optional("unavailable", &file.unavailable)
                .finish()
        })
        .collect::<Vec<_>>();
    ObjectEncoder::new()
        .field("placementMessageID", &scalar(&group.placement_message_id))
        .field("path", &scalar(&group.path))
        .field("additions", &(group.additions as f64))
        .field("deletions", &(group.deletions as f64))
        .field("status", status(group.status))
        .field("files", &JsonValue::Array(files))
        .finish()
}

fn chars(value: &JsonValue) -> usize {
    stringify_json(value).encode_utf16().count()
}

fn encode(bytes: &[u8]) -> String {
    bytes
        .chunks(3)
        .flat_map(|chunk| {
            let value = (u32::from(chunk[0]) << 16)
                | (u32::from(*chunk.get(1).unwrap_or(&0)) << 8)
                | u32::from(*chunk.get(2).unwrap_or(&0));
            (0..chunk.len() + 1)
                .map(move |index| ALPHABET[((value >> (18 - index * 6)) & 63) as usize] as char)
        })
        .collect()
}

fn decode_cursor(cursor: &str, digest: &str, total: usize) -> Result<usize, Failure> {
    let invalid = || target::error(1, "Captured change cursor is invalid or stale");
    if cursor.len() > 256 || cursor.len() % 4 == 1 {
        return Err(invalid());
    }
    let mut bytes = Vec::new();
    for chunk in cursor.as_bytes().chunks(4) {
        let mut value = 0u32;
        for ch in chunk {
            value = (value << 6)
                | ALPHABET
                    .iter()
                    .position(|candidate| candidate == ch)
                    .ok_or_else(invalid)? as u32;
        }
        value <<= (4 - chunk.len()) * 6;
        bytes.push((value >> 16) as u8);
        if chunk.len() > 2 {
            bytes.push((value >> 8) as u8);
        }
        if chunk.len() > 3 {
            bytes.push(value as u8);
        }
    }
    if encode(&bytes) != cursor {
        return Err(invalid());
    }
    let json =
        parse_json(std::str::from_utf8(&bytes).map_err(|_| invalid())?).map_err(|_| invalid())?;
    let path = JsonPath::default();
    let object = ObjectDecoder::new(&json, &path).map_err(|_| invalid())?;
    let offset = object.field::<f64>("offset").map_err(|_| invalid())?;
    let given = object
        .field::<LosslessString>("digest")
        .map_err(|_| invalid())?;
    if given.as_str() != Some(digest)
        || !offset.is_finite()
        || offset.fract() != 0.0
        || offset < 1.0
        || offset >= total as f64
    {
        return Err(invalid());
    }
    Ok(offset as usize)
}
