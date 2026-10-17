use super::{
    key,
    store::Service,
    usage, usage_activity, usage_attribution,
    usage_read::{Pricer, Pricing, PricingRef},
};
use std::collections::{BTreeMap, BTreeSet};
use ycoding_schema::{
    DecodeError, LosslessString, money,
    provider_request::{CostProvenance, Source},
    schema::{Finite, NonNegativeInt},
    session,
    session_id::SessionId,
    session_message_id, token_usage,
    usage_accounting::{
        Attribution, Breakdown, Cost, Helper, History, PromptCost, PromptCosts, PromptInput,
        Status, TaskCost, TaskCosts, TaskInput,
    },
    usage_anchor,
};
use ycoding_store::{
    IndexOrder, KeyPart, Snapshot, TableSpec,
    resources::{Request, requests},
    session::{Session, SessionTable, TaskTable},
    tuple_key,
};

const PAGE: usize = 128;
const DAY: i64 = 86_400_000;
const ACTIVE_TASK_STATES: [&str; 4] = ["starting", "running", "waiting", "cancelling"];

pub struct Context<'a> {
    pub now: i64,
    pub records_days: i64,
    pub active: &'a BTreeSet<session::Id>,
    pub pricer: Pricer<'a>,
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

impl Service {
    pub fn prompt_costs(
        &self,
        id: &session::Id,
        input: &PromptInput,
        context: &Context<'_>,
    ) -> Result<PromptCosts, Error> {
        let mut snapshot = self.client.snapshot()?;
        let sessions = family(&snapshot, id)?;
        let mut units = Vec::new();
        for input_id in &input.input_ids {
            let requested = usage_anchor::Ref {
                session_id: id.clone(),
                input_id: input_id.clone(),
            };
            let anchor = usage_attribution::resolve(&mut snapshot, &requested)?;
            if anchor.as_ref().is_some_and(|anchor| *anchor != requested) {
                continue;
            }
            units.push(PromptUnit {
                valid: anchor.is_some(),
                started: usage_attribution::started(&mut snapshot, &requested)?,
                anchor: requested,
                value: Unit::default(),
            });
        }
        let positions = units
            .iter()
            .enumerate()
            .map(|(position, unit)| (anchor_key(&unit.anchor), position))
            .collect::<BTreeMap<_, _>>();
        let mut unattributed = Bucket::default();
        let mut prices = Prices::new(context.pricer);
        let mut resolved = BTreeMap::new();
        each(&mut snapshot, &sessions, |snapshot, session, row| {
            let anchor = match &row.usage_anchor {
                Some(anchor) => Some(anchor.domain()?),
                None => match &row.input_id {
                    Some(input) => resolve(snapshot, &mut resolved, &row.session_id, input)?,
                    None => None,
                },
            };
            let tokens = row.tokens.domain()?;
            let cost = prices.cost(session, &row)?;
            let Some(anchor) = anchor else {
                unattributed.add(&tokens, cost, row.cost.is_none());
                return Ok(());
            };
            if let Some(&position) = positions.get(&anchor_key(&anchor)) {
                let main = row.session_id == *anchor.session_id.as_lossless();
                units[position].value.add(&row, &tokens, main, cost);
            }
            Ok(())
        })?;
        let history = coverage(&sessions, context);
        let activity = activity(&self.client, &mut snapshot, &sessions, context)?;
        Ok(PromptCosts {
            units: units
                .iter()
                .map(|unit| {
                    let retained =
                        unit.valid && unit.started.is_some_and(|started| started >= history.since);
                    let attribution = match (unit.valid, unattributed.requests) {
                        (false, _) => "unattributed",
                        (true, 0) => "complete",
                        (true, _) => "partial",
                    };
                    let parts = unit
                        .value
                        .parts(unit.valid && attribution == "complete" && retained)?;
                    Ok(PromptCost {
                        anchor: unit.anchor.clone(),
                        status: status(activity.anchors.contains(&anchor_key(&unit.anchor))),
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
        let mut snapshot = self.client.snapshot()?;
        let members = family(&snapshot, id)?
            .into_iter()
            .map(|session| session.id)
            .collect::<BTreeSet<_>>();
        let mut units = Vec::new();
        for session_id in &input.session_ids {
            let rejected = || Error::SessionNotFound(session_id.clone());
            let session = session_id.as_lossless();
            if !members.contains(session) {
                return Err(rejected());
            }
            let task = snapshot
                .get::<TaskTable>(&key(session))?
                .ok_or_else(rejected)?;
            let root = snapshot
                .get::<SessionTable>(&key(session))?
                .ok_or_else(rejected)?;
            let sessions = descendants(&snapshot, root)?;
            let anchor = match &task.usage_anchor {
                Some(anchor) => Some(anchor.domain()?),
                None => resolve(&mut snapshot, &mut BTreeMap::new(), session, &task.input_id)?,
            };
            units.push(TaskUnit {
                session_id: session_id.clone(),
                anchor,
                started: task.time_created,
                members: sessions.iter().map(|session| session.id.clone()).collect(),
                sessions,
                value: Unit::default(),
            });
        }
        let mut seen = BTreeSet::new();
        let selected = units
            .iter()
            .flat_map(|unit| unit.sessions.iter())
            .filter(|session| seen.insert(session.id.clone()))
            .cloned()
            .collect::<Vec<_>>();
        let mut total = Bucket::default();
        let mut prices = Prices::new(context.pricer);
        each(&mut snapshot, &selected, |_, session, row| {
            let tokens = row.tokens.domain()?;
            let cost = prices.cost(session, &row)?;
            total.add(&tokens, cost, row.cost.is_none());
            for unit in units
                .iter_mut()
                .filter(|unit| unit.members.contains(&row.session_id))
            {
                let main = row.session_id == *unit.session_id.as_lossless();
                unit.value.add(&row, &tokens, main, cost);
            }
            Ok(())
        })?;
        let activity = activity(&self.client, &mut snapshot, &selected, context)?;
        let history = coverage(&selected, context);
        Ok(TaskCosts {
            tasks: units
                .iter()
                .map(|unit| {
                    let retained = unit.started >= coverage(&unit.sessions, context).since;
                    let parts = unit.value.parts(retained)?;
                    Ok(TaskCost {
                        session_id: unit.session_id.clone(),
                        usage_anchor: unit.anchor.clone(),
                        status: status(
                            unit.members
                                .iter()
                                .any(|session| activity.active.contains(session)),
                        ),
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

struct PromptUnit {
    anchor: usage_anchor::Ref,
    valid: bool,
    started: Option<i64>,
    value: Unit,
}

struct TaskUnit {
    session_id: session::Id,
    anchor: Option<usage_anchor::Ref>,
    started: i64,
    sessions: Vec<Session>,
    members: BTreeSet<LosslessString>,
    value: Unit,
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

fn family(snapshot: &Snapshot, id: &session::Id) -> Result<Vec<Session>, Error> {
    let root = snapshot
        .get::<SessionTable>(&key(id.as_lossless()))?
        .ok_or_else(|| Error::SessionNotFound(id.clone()))?;
    descendants(snapshot, root)
}

fn descendants(snapshot: &Snapshot, root: Session) -> Result<Vec<Session>, Error> {
    let mut seen = BTreeSet::from([root.id.clone()]);
    let mut sessions = vec![root];
    let mut current = 0;
    while current < sessions.len() {
        let parent = tuple_key(&[KeyPart::String(&sessions[current].id)]);
        let mut after = None;
        loop {
            let page = snapshot.index::<SessionTable>(
                "session_parent_idx",
                &parent,
                after.as_deref(),
                PAGE,
            )?;
            let Some(last) = page.last() else {
                break;
            };
            after = Some(SessionTable::primary_key(last));
            let full = page.len() == PAGE;
            sessions.extend(
                page.into_iter()
                    .filter(|child| seen.insert(child.id.clone())),
            );
            if !full {
                break;
            }
            std::thread::yield_now();
        }
        current += 1;
    }
    Ok(sessions)
}

fn each(
    snapshot: &mut Snapshot,
    sessions: &[Session],
    mut visit: impl FnMut(&mut Snapshot, &Session, Request) -> Result<(), Error>,
) -> Result<(), Error> {
    for session in sessions {
        let mut after = None;
        loop {
            let page = requests(
                snapshot,
                &session.id,
                IndexOrder::Ascending,
                after.as_ref(),
                PAGE,
            )?;
            let Some(last) = page.last() else {
                break;
            };
            after = Some(last.cursor.clone());
            let full = page.len() == PAGE;
            for entry in page {
                visit(snapshot, session, entry.record)?;
            }
            if !full {
                break;
            }
            std::thread::yield_now();
        }
    }
    Ok(())
}

fn resolve(
    snapshot: &mut Snapshot,
    cache: &mut BTreeMap<AnchorKey, Option<usage_anchor::Ref>>,
    session: &LosslessString,
    input: &LosslessString,
) -> Result<Option<usage_anchor::Ref>, Error> {
    let cursor = (session.clone(), input.clone());
    if let Some(anchor) = cache.get(&cursor) {
        return Ok(anchor.clone());
    }
    let anchor = match (
        SessionId::new(session.clone()),
        session_message_id::Id::new(input.clone()),
    ) {
        (Ok(session_id), Ok(input_id)) => usage_attribution::resolve(
            snapshot,
            &usage_anchor::Ref {
                session_id,
                input_id,
            },
        )?,
        _ => None,
    };
    cache.insert(cursor, anchor.clone());
    Ok(anchor)
}

struct Coverage {
    since: i64,
    retained: bool,
}

fn coverage(sessions: &[Session], context: &Context<'_>) -> Coverage {
    let cutoff = context
        .now
        .saturating_sub(context.records_days.saturating_mul(DAY));
    let since = sessions
        .iter()
        .filter_map(|session| session.usage_pruned_through)
        .map(|through| through.saturating_add(1))
        .fold(cutoff, i64::max);
    let oldest = sessions
        .iter()
        .map(|session| session.time_created)
        .min()
        .unwrap_or(i64::MAX);
    Coverage {
        since,
        retained: oldest >= since,
    }
}

struct Activity {
    active: BTreeSet<LosslessString>,
    anchors: BTreeSet<AnchorKey>,
}

fn activity(
    client: &ycoding_store::Client,
    snapshot: &mut Snapshot,
    sessions: &[Session],
    context: &Context<'_>,
) -> Result<Activity, Error> {
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
    for session in sessions {
        let running = snapshot
            .get::<TaskTable>(&key(&session.id))?
            .is_some_and(|task| {
                ACTIVE_TASK_STATES
                    .iter()
                    .any(|state| task.state.as_str() == Some(state))
            });
        if running {
            active.insert(session.id.clone());
        }
        if active.contains(&session.id) {
            anchors.extend(
                usage_attribution::current(snapshot, &session.id)?
                    .as_ref()
                    .map(anchor_key),
            );
        }
    }
    Ok(Activity { active, anchors })
}

type PriceKey = (
    LosslessString,
    Option<LosslessString>,
    LosslessString,
    LosslessString,
    Option<LosslessString>,
);

struct Prices<'a> {
    pricer: Pricer<'a>,
    cache: BTreeMap<PriceKey, Option<Pricing>>,
}

impl<'a> Prices<'a> {
    fn new(pricer: Pricer<'a>) -> Self {
        Self {
            pricer,
            cache: BTreeMap::new(),
        }
    }

    fn cost(&mut self, session: &Session, row: &Request) -> Result<Option<f64>, Error> {
        if row.cost.is_some() {
            return Ok(row.cost);
        }
        let Some(pricer) = self
            .pricer
            .filter(|_| row.source.as_str() != Some("decision"))
        else {
            return Ok(None);
        };
        let model = row.model.domain()?;
        let reference = PricingRef {
            directory: session.directory.clone(),
            workspace_id: session.workspace_id.clone(),
            provider: model.provider_id.0,
            model: model.id,
            profile: model.profile.map(|profile| profile.0),
        };
        let pricing = self
            .cache
            .entry((
                reference.directory.clone(),
                reference.workspace_id.clone(),
                reference.provider.clone(),
                reference.model.clone(),
                reference.profile.clone(),
            ))
            .or_insert_with(|| pricer(&reference));
        let tokens = row.tokens.value();
        Ok(pricing.as_ref().and_then(|pricing| {
            usage::estimated_cost(&pricing.provider, tokens, None)
                .or_else(|| usage::estimated_cost(&pricing.router, tokens, None))
        }))
    }
}

#[derive(Default)]
struct Bucket {
    requests: i64,
    tokens: [f64; 5],
    known: f64,
    priced: i64,
    unpriced: i64,
    catalog: bool,
}

impl Bucket {
    fn add(&mut self, tokens: &token_usage::Info, cost: Option<f64>, unrecorded: bool) {
        self.requests += 1;
        let values = [
            tokens.input.get(),
            tokens.output.get(),
            tokens.reasoning.get(),
            tokens.cache.read.get(),
            tokens.cache.write.get(),
        ];
        self.tokens
            .iter_mut()
            .zip(values)
            .for_each(|(sum, value)| *sum += value);
        let Some(cost) = cost else {
            self.unpriced += 1;
            return;
        };
        self.known += cost;
        self.priced += 1;
        self.catalog |= unrecorded;
    }

    fn breakdown(&self, complete: bool) -> Result<Breakdown, Error> {
        Ok(Breakdown {
            requests: NonNegativeInt::new(self.requests)?,
            tokens: token_usage::Info {
                input: Finite::new(self.tokens[0])?,
                output: Finite::new(self.tokens[1])?,
                reasoning: Finite::new(self.tokens[2])?,
                cache: token_usage::Cache {
                    read: Finite::new(self.tokens[3])?,
                    write: Finite::new(self.tokens[4])?,
                },
            },
            cost: self.cost(complete)?,
        })
    }

    fn cost(&self, complete: bool) -> Result<Cost, Error> {
        let priced = self.priced > 0;
        let known = priced.then(|| money::Usd::new(self.known)).transpose()?;
        Ok(Cost {
            total: known.filter(|_| complete && self.unpriced == 0),
            known,
            priced_requests: NonNegativeInt::new(self.priced)?,
            unpriced_requests: NonNegativeInt::new(self.unpriced)?,
            provenance: priced.then(|| {
                CostProvenance(
                    if self.catalog {
                        "current_catalog"
                    } else {
                        "recorded"
                    }
                    .into(),
                )
            }),
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
    fn add(&mut self, row: &Request, tokens: &token_usage::Info, main: bool, cost: Option<f64>) {
        let unrecorded = row.cost.is_none();
        self.total.add(tokens, cost, unrecorded);
        let side = if main {
            &mut self.main
        } else {
            &mut self.children
        };
        side.add(tokens, cost, unrecorded);
        if row.source.as_str() == Some("step") {
            return;
        }
        self.helpers
            .entry(row.source.clone())
            .or_default()
            .add(tokens, cost, unrecorded);
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
