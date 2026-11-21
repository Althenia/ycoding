use super::{store::Service, usage_activity, usage_read};
use std::collections::{BTreeMap, BTreeSet};
use ycoding_schema::{
    DecodeError, DomainEncode, JsonValue, LosslessString, money,
    provider_request::{CostProvenance, Source},
    schema::{Finite, NonNegativeInt},
    session, token_usage,
    usage_accounting::{
        Attribution, Breakdown, Cost, Helper, History, PromptCost, PromptCosts, PromptInput,
        Status, TaskCost, TaskCosts, TaskInput,
    },
    usage_anchor,
};
use ycoding_store::Decimal;

const DAY: i64 = 86_400_000;

pub struct Context<'a> {
    pub now: i64,
    pub records_days: i64,
    pub active: &'a BTreeSet<session::Id>,
}

#[derive(Debug)]
pub enum Error {
    SessionNotFound(session::Id),
    Store(ycoding_store::Error),
}

impl From<ycoding_store::Error> for Error {
    fn from(error: ycoding_store::Error) -> Self {
        Self::Store(error)
    }
}

impl From<DecodeError> for Error {
    fn from(error: DecodeError) -> Self {
        Self::Store(ycoding_store::Error::Record(Box::new(error)))
    }
}

struct Member {
    id: LosslessString,
    parent: Option<LosslessString>,
    created: i64,
    pruned: Option<i64>,
    current: Option<usage_anchor::Ref>,
    task: Option<(i64, LosslessString, Option<usage_anchor::Ref>)>,
}

struct Read {
    read: usage_read::Read,
}
impl Read {
    fn new(client: &ycoding_store::Client) -> Result<Self, Error> {
        Ok(Self {
            read: usage_read::Read::new(client)?,
        })
    }
    fn members(&self, root: &session::Id) -> Result<Vec<Member>, Error> {
        if !self.read.data.sessions.contains_key(root.as_lossless()) {
            return Err(Error::SessionNotFound(root.clone()));
        }
        self.read
            .members(root, true)?
            .into_iter()
            .map(|id| {
                let member = self
                    .read
                    .data
                    .sessions
                    .get(&id)
                    .ok_or(ycoding_store::Error::Rejected("Usage member is missing"))?;
                Ok(Member {
                    id: member.id.clone(),
                    parent: member.parent.clone(),
                    created: member.time_created,
                    pruned: member.pruned_through,
                    current: member.current_anchor.clone(),
                    task: self
                        .read
                        .data
                        .tasks
                        .get(&id)
                        .map(|task| (task.time_created, task.state.clone(), task.anchor.clone())),
                })
            })
            .collect()
    }
    fn cells(
        &self,
        root: &session::Id,
        mut visit: impl FnMut(
            &LosslessString,
            &LosslessString,
            Option<usage_anchor::Ref>,
            Bucket,
        ) -> Result<(), Error>,
    ) -> Result<(), Error> {
        let members = self.read.members(root, true)?;
        let mut failure = None;
        self.read
            .cells("session", Some(&members), 900_000, None, None, |row| {
                let d = &row.cell.dimensions;
                let anchor = d
                    .anchor_session_id
                    .as_ref()
                    .zip(d.anchor_input_id.as_ref())
                    .map(|(id, input)| {
                        Ok::<_, ycoding_store::Error>(usage_anchor::Ref {
                            session_id: session::Id::new(id.clone())
                                .map_err(super::projector::record_error)?,
                            input_id: ycoding_schema::session_message_id::Id::new(input.clone())
                                .map_err(super::projector::record_error)?,
                        })
                    })
                    .transpose()?;
                let c = &row.cell.counts;
                let a = &row.cell.amounts;
                let result = visit(
                    &d.session_id,
                    &d.source,
                    anchor,
                    Bucket {
                        requests: c[0],
                        tokens: std::array::from_fn(|index| a[index + 1].clone()),
                        known: a[0].clone(),
                        priced: c[6],
                        unpriced: c[0] - c[6],
                        catalog: row.corrections > 0,
                    },
                );
                if let Err(error) = result {
                    failure = Some(error);
                    return Err(ycoding_store::Error::Rejected(
                        "Accounting aggregation failed",
                    ));
                }
                Ok(())
            })
            .map_err(|error| failure.unwrap_or(Error::Store(error)))?;
        Ok(())
    }
    fn prompt(
        &self,
        requested: &usage_anchor::Ref,
    ) -> Result<(Option<usage_anchor::Ref>, Option<i64>), Error> {
        usage_read::identity(requested.session_id.as_lossless())?;
        usage_read::identity(requested.input_id.as_lossless())?;
        let key = ycoding_schema::stringify_json(&JsonValue::Array(vec![
            requested.session_id.encode(),
            requested.input_id.encode(),
        ]));
        Ok(self
            .read
            .data
            .hints
            .get(&key)
            .map(|hint| (hint.resolved.clone(), hint.started))
            .unwrap_or((None, None)))
    }
}

impl Service {
    pub fn prompt_costs(
        &self,
        id: &session::Id,
        input: &PromptInput,
        context: &Context<'_>,
    ) -> Result<PromptCosts, Error> {
        let read = Read::new(&self.client)?;
        let members = read.members(id)?;
        let (active, anchors) = activity(&self.client, &members, context);
        let history = coverage(members.iter(), context);
        let mut units = Vec::new();
        for input_id in &input.input_ids {
            let requested = usage_anchor::Ref {
                session_id: id.clone(),
                input_id: input_id.clone(),
            };
            let (resolved, started) = read.prompt(&requested)?;
            if resolved.as_ref().is_some_and(|anchor| anchor != &requested) {
                continue;
            }
            units.push((requested, resolved.is_some(), started, Unit::default()));
        }
        let mut unattributed = Bucket::default();
        read.cells(id, |session, source, anchor, bucket| {
            let Some(anchor) = anchor else {
                unattributed.add(&bucket)?;
                return Ok(());
            };
            for (requested, _, _, unit) in &mut units {
                if *requested == anchor {
                    unit.add(source, session == anchor.session_id.as_lossless(), &bucket)?;
                }
            }
            Ok(())
        })?;
        let _ = active;
        read.read.finish()?;
        Ok(PromptCosts {
            units: units
                .into_iter()
                .map(|(anchor, valid, started, unit)| {
                    let retained = valid && started.is_some_and(|started| started >= history.since);
                    let attribution = if !valid {
                        "unattributed"
                    } else if unattributed.requests == 0 {
                        "complete"
                    } else {
                        "partial"
                    };
                    let parts = unit.parts(valid && attribution == "complete" && retained)?;
                    Ok(PromptCost {
                        status: status(anchors.contains(&anchor_key(&anchor))),
                        anchor,
                        attribution: Attribution(attribution.into()),
                        history: history_label(retained),
                        total: parts.total,
                        main: parts.main,
                        children: parts.children,
                        helpers: parts.helpers,
                    })
                })
                .collect::<Result<_, Error>>()?,
            unattributed: unattributed.breakdown(false)?,
            history: history_label(history.retained),
        })
    }

    pub fn task_costs(
        &self,
        id: &session::Id,
        input: &TaskInput,
        context: &Context<'_>,
    ) -> Result<TaskCosts, Error> {
        let read = Read::new(&self.client)?;
        let members = read.members(id)?;
        let mut units = Vec::new();
        for selected in &input.session_ids {
            usage_read::identity(selected.as_lossless())?;
            let root = members
                .iter()
                .find(|member| &member.id == selected.as_lossless())
                .ok_or_else(|| Error::SessionNotFound(selected.clone()))?;
            let (created, _, anchor) = root
                .task
                .as_ref()
                .ok_or_else(|| Error::SessionNotFound(selected.clone()))?;
            let mut subtree = BTreeSet::from([root.id.clone()]);
            loop {
                let previous = subtree.len();
                for member in &members {
                    if member
                        .parent
                        .as_ref()
                        .is_some_and(|parent| subtree.contains(parent))
                    {
                        subtree.insert(member.id.clone());
                    }
                }
                if previous == subtree.len() {
                    break;
                }
            }
            units.push((
                selected.clone(),
                *created,
                anchor.clone(),
                subtree,
                Unit::default(),
            ));
        }
        let selected = units
            .iter()
            .flat_map(|(_, _, _, members, _)| members.iter().cloned())
            .collect::<BTreeSet<_>>();
        let mut total = Bucket::default();
        read.cells(id, |session, source, _, bucket| {
            if selected.contains(session) {
                total.add(&bucket)?;
            }
            for (id, _, _, members, unit) in &mut units {
                if members.contains(session) {
                    unit.add(source, session == id.as_lossless(), &bucket)?;
                }
            }
            Ok(())
        })?;
        let (active, _) = activity(&self.client, &members, context);
        let history = coverage(
            members
                .iter()
                .filter(|member| selected.contains(&member.id)),
            context,
        );
        read.read.finish()?;
        Ok(TaskCosts {
            tasks: units
                .into_iter()
                .map(|(session_id, created, anchor, subtree, unit)| {
                    let retained = created
                        >= coverage(
                            members.iter().filter(|member| subtree.contains(&member.id)),
                            context,
                        )
                        .since;
                    let parts = unit.parts(retained)?;
                    Ok(TaskCost {
                        session_id,
                        usage_anchor: anchor,
                        status: status(subtree.iter().any(|id| active.contains(id))),
                        attribution: Attribution("complete".into()),
                        history: history_label(retained),
                        total: parts.total,
                        main: parts.main,
                        children: parts.children,
                        helpers: parts.helpers,
                    })
                })
                .collect::<Result<_, Error>>()?,
            total: total.breakdown(history.retained)?,
            history: history_label(history.retained),
        })
    }
}

type AnchorKey = (LosslessString, LosslessString);
fn anchor_key(anchor: &usage_anchor::Ref) -> AnchorKey {
    (
        anchor.session_id.as_lossless().clone(),
        anchor.input_id.as_lossless().clone(),
    )
}
fn status(active: bool) -> Status {
    Status(if active { "so-far" } else { "settled" }.into())
}
fn history_label(retained: bool) -> History {
    History(if retained { "retained" } else { "partial" }.into())
}

struct Coverage {
    since: i64,
    retained: bool,
}
fn coverage<'a>(members: impl Iterator<Item = &'a Member>, context: &Context<'_>) -> Coverage {
    let mut since = context
        .now
        .saturating_sub(context.records_days.saturating_mul(DAY));
    let mut oldest = i64::MAX;
    for member in members {
        if let Some(pruned) = member.pruned {
            since = since.max(pruned.saturating_add(1));
        }
        oldest = oldest.min(member.created);
    }
    Coverage {
        since,
        retained: oldest >= since,
    }
}

fn activity(
    client: &ycoding_store::Client,
    members: &[Member],
    context: &Context<'_>,
) -> (BTreeSet<LosslessString>, BTreeSet<AnchorKey>) {
    let live = usage_activity::snapshot(client);
    let mut active = context
        .active
        .iter()
        .map(|id| id.as_lossless().clone())
        .collect::<BTreeSet<_>>();
    let mut anchors = live
        .requests
        .iter()
        .filter_map(|(_, anchor)| anchor.as_ref().map(anchor_key))
        .collect::<BTreeSet<_>>();
    for (session, anchor) in &live.contributors {
        active.insert(session.as_lossless().clone());
        anchors.extend(anchor.as_ref().map(anchor_key));
    }
    for member in members {
        if member.task.as_ref().is_some_and(|(_, state, _)| {
            matches!(
                state.as_str(),
                Some("starting" | "running" | "waiting" | "cancelling")
            )
        }) {
            active.insert(member.id.clone());
        }
        if active.contains(&member.id) {
            anchors.extend(member.current.as_ref().map(anchor_key));
        }
    }
    (active, anchors)
}

#[derive(Default)]
struct Bucket {
    requests: i64,
    tokens: [Decimal; 5],
    known: Decimal,
    priced: i64,
    unpriced: i64,
    catalog: bool,
}
impl Bucket {
    fn add(&mut self, other: &Self) -> Result<(), Error> {
        self.requests = self
            .requests
            .checked_add(other.requests)
            .ok_or(ycoding_store::Error::Rejected("Usage count overflow"))?;
        for (sum, value) in self.tokens.iter_mut().zip(&other.tokens) {
            *sum = sum.checked_add(value)?;
        }
        self.known = self.known.checked_add(&other.known)?;
        self.priced = self
            .priced
            .checked_add(other.priced)
            .ok_or(ycoding_store::Error::Rejected("Usage count overflow"))?;
        self.unpriced = self
            .unpriced
            .checked_add(other.unpriced)
            .ok_or(ycoding_store::Error::Rejected("Usage count overflow"))?;
        self.catalog |= other.catalog;
        Ok(())
    }
    fn breakdown(&self, complete: bool) -> Result<Breakdown, Error> {
        let known = if self.priced > 0 {
            Some(money::Usd::new(self.known.to_f64()?)?)
        } else {
            None
        };
        Ok(Breakdown {
            requests: NonNegativeInt::new(self.requests)?,
            tokens: token_usage::Info {
                input: Finite::new(self.tokens[0].to_f64()?)?,
                output: Finite::new(self.tokens[1].to_f64()?)?,
                reasoning: Finite::new(self.tokens[2].to_f64()?)?,
                cache: token_usage::Cache {
                    read: Finite::new(self.tokens[3].to_f64()?)?,
                    write: Finite::new(self.tokens[4].to_f64()?)?,
                },
            },
            cost: Cost {
                total: known.filter(|_| complete && self.unpriced == 0),
                known,
                priced_requests: NonNegativeInt::new(self.priced)?,
                unpriced_requests: NonNegativeInt::new(self.unpriced)?,
                provenance: (self.priced > 0).then(|| {
                    CostProvenance(
                        if self.catalog {
                            "current_catalog"
                        } else {
                            "recorded"
                        }
                        .into(),
                    )
                }),
            },
        })
    }
}

#[derive(Default)]
struct Unit {
    total: Bucket,
    main: Bucket,
    children: Bucket,
    helpers: BTreeMap<LosslessString, Bucket>,
}
struct Parts {
    total: Breakdown,
    main: Breakdown,
    children: Breakdown,
    helpers: Vec<Helper>,
}
impl Unit {
    fn add(&mut self, source: &LosslessString, main: bool, bucket: &Bucket) -> Result<(), Error> {
        self.total.add(bucket)?;
        if main {
            self.main.add(bucket)?;
        } else {
            self.children.add(bucket)?;
        }
        if source.as_str() != Some("step") {
            self.helpers
                .entry(source.clone())
                .or_default()
                .add(bucket)?;
        }
        Ok(())
    }
    fn parts(&self, complete: bool) -> Result<Parts, Error> {
        Ok(Parts {
            total: self.total.breakdown(complete)?,
            main: self.main.breakdown(complete)?,
            children: self.children.breakdown(complete)?,
            helpers: self
                .helpers
                .iter()
                .map(|(source, bucket)| {
                    let breakdown = bucket.breakdown(complete)?;
                    Ok(Helper {
                        source: Source(source.clone()),
                        requests: breakdown.requests,
                        tokens: breakdown.tokens,
                        cost: breakdown.cost,
                    })
                })
                .collect::<Result<_, Error>>()?,
        })
    }
}
