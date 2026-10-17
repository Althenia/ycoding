pub mod guidance;
pub mod record;

use std::{cmp::Reverse, collections::BTreeMap, ops::Bound};
use ycoding_schema::{
    LosslessString, agent, model, model_incident, provider, schema::NonNegativeInt,
};
use ycoding_store::{
    Client, IndexCursor, IndexOrder, IndexQuery, KeyPart,
    model_incident::{
        GuidanceClear, GuidanceClearTable, Incident, IncidentTable, MODEL_AGENT_INDEX, MODEL_INDEX,
        TIME_INDEX,
    },
    tuple_key,
};

pub const SLICE_ROWS: usize = 10_000;
pub const REPORT_LIMIT: i64 = 200;
pub const RECENT_LIMIT: i64 = 50;
const RECENT_DEFAULT: i64 = 20;

#[derive(Debug)]
pub enum Error {
    InvalidInput(&'static str),
    Store(ycoding_store::Error),
    Worker(tokio::task::JoinError),
}
impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidInput(message) => f.write_str(message),
            Self::Store(error) => write!(f, "model incidents: {error}"),
            Self::Worker(error) => write!(f, "model incidents: {error}"),
        }
    }
}
impl std::error::Error for Error {}
impl From<ycoding_store::Error> for Error {
    fn from(error: ycoding_store::Error) -> Self {
        Self::Store(error)
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct ModelKey {
    pub provider: provider::Id,
    pub model: model::Id,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ReportInput {
    pub group: model_incident::Group,
    pub from: Option<i64>,
    pub to: Option<i64>,
    pub offset: Option<i64>,
    pub limit: Option<i64>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct RecentInput {
    pub provider: provider::Id,
    pub model: model::Id,
    pub agent: Option<agent::Id>,
    pub limit: Option<i64>,
}

#[derive(Clone)]
pub struct Service {
    client: Client,
}

#[derive(Default)]
struct Counts {
    fallbacks: i64,
    escalated: i64,
    rejected: i64,
    last: i64,
}

type GroupKey = (LosslessString, LosslessString, Option<LosslessString>);

impl Service {
    pub fn new(client: Client) -> Self {
        Self { client }
    }

    pub async fn report(&self, input: ReportInput) -> Result<model_incident::Report, Error> {
        let offset = input.offset.unwrap_or(0);
        let limit = input.limit.unwrap_or(REPORT_LIMIT);
        let from = input.from.unwrap_or(0);
        if offset < 0 {
            return Err(Error::InvalidInput(
                "Incident report offset must be a nonnegative integer",
            ));
        }
        if !(1..=REPORT_LIMIT).contains(&limit) {
            return Err(Error::InvalidInput(
                "Incident report limit must be 1 to 200",
            ));
        }
        if from < 0 || input.to.is_some_and(|to| to < from) {
            return Err(Error::InvalidInput(
                "Incident report range must be ordered millisecond times",
            ));
        }
        let by_agent = input.group.0.as_str() == Some("agent");
        let client = self.client.clone();
        let groups = self
            .blocking(move || aggregate(&client, from, input.to, by_agent))
            .await?;
        let mut rows = groups.into_iter().collect::<Vec<_>>();
        rows.sort_by(|(left_key, left), (right_key, right)| {
            (
                Reverse(left.fallbacks + left.escalated + left.rejected),
                Reverse(left.last),
                left_key,
            )
                .cmp(&(
                    Reverse(right.fallbacks + right.escalated + right.rejected),
                    Reverse(right.last),
                    right_key,
                ))
        });
        let groups = number(rows.len() as i64)?;
        let rows = rows
            .into_iter()
            .skip(usize::try_from(offset).unwrap_or(usize::MAX))
            .take(limit as usize)
            .map(|((provider_id, model_id, agent), counts)| {
                Ok(model_incident::ReportRow {
                    provider_id: provider::Id(provider_id),
                    model_id,
                    agent,
                    fallbacks: number(counts.fallbacks)?,
                    escalated: number(counts.escalated)?,
                    rejected: number(counts.rejected)?,
                    last: number(counts.last)?,
                })
            })
            .collect::<Result<_, Error>>()?;
        Ok(model_incident::Report { rows, groups })
    }

    pub async fn recent(&self, input: RecentInput) -> Result<model_incident::Recent, Error> {
        let limit = input.limit.unwrap_or(RECENT_DEFAULT);
        if !(1..=RECENT_LIMIT).contains(&limit) {
            return Err(Error::InvalidInput("Recent incident limit must be 1 to 50"));
        }
        let client = self.client.clone();
        let rows = self
            .blocking(move || {
                let mut prefix = vec![
                    KeyPart::String(&input.provider.0),
                    KeyPart::String(&input.model),
                ];
                if let Some(agent) = &input.agent {
                    prefix.push(KeyPart::String(agent));
                }
                let prefix = tuple_key(&prefix);
                client.snapshot()?.index_range::<IncidentTable>(
                    if input.agent.is_some() {
                        MODEL_AGENT_INDEX
                    } else {
                        MODEL_INDEX
                    },
                    IndexQuery {
                        lower: Bound::Unbounded,
                        upper: Bound::Unbounded,
                        prefix: Some(&prefix),
                        order: IndexOrder::Descending,
                        after: None,
                        limit: limit as usize,
                    },
                )
            })
            .await?;
        Ok(model_incident::Recent {
            items: rows
                .into_iter()
                .map(|row| item(row.record))
                .collect::<Result<_, Error>>()?,
        })
    }

    pub async fn guidance(
        &self,
        model: ModelKey,
        enabled: bool,
        now: i64,
    ) -> Result<model_incident::Guidance, Error> {
        let client = self.client.clone();
        let (text, cleared) = self
            .blocking(move || {
                let snapshot = client.snapshot()?;
                Ok((
                    guidance::text(&snapshot, &model, now)?,
                    snapshot.get::<GuidanceClearTable>(&watermark_key(&model))?,
                ))
            })
            .await?;
        Ok(model_incident::Guidance {
            text: text.map(LosslessString::from),
            cleared_at: cleared.map(|row| number(row.cleared_at)).transpose()?,
            enabled,
        })
    }

    pub async fn clear(&self, model: ModelKey, now: i64) -> Result<i64, Error> {
        Ok(self
            .client
            .submit(move |tx| {
                let key = watermark_key(&model);
                let cleared_at = tx
                    .get::<GuidanceClearTable>(&key)?
                    .map_or(now, |row| row.cleared_at.max(now));
                GuidanceClearTable::put(
                    tx,
                    &GuidanceClear {
                        provider_id: model.provider.0.clone(),
                        model_id: model.model.clone(),
                        cleared_at,
                    },
                )?;
                Ok(cleared_at)
            })?
            .await?)
    }

    async fn blocking<T: Send + 'static>(
        &self,
        work: impl FnOnce() -> Result<T, ycoding_store::Error> + Send + 'static,
    ) -> Result<T, Error> {
        Ok(tokio::task::spawn_blocking(work)
            .await
            .map_err(Error::Worker)??)
    }
}

fn aggregate(
    client: &Client,
    from: i64,
    to: Option<i64>,
    by_agent: bool,
) -> Result<BTreeMap<GroupKey, Counts>, ycoding_store::Error> {
    let snapshot = client.snapshot()?;
    let lower = tuple_key(&[KeyPart::I64(from)]);
    let upper = to.map(|to| tuple_key(&[KeyPart::I64(to)]));
    let mut groups = BTreeMap::<GroupKey, Counts>::new();
    let mut cursor: Option<IndexCursor> = None;
    loop {
        let page = snapshot.index_range::<IncidentTable>(
            TIME_INDEX,
            IndexQuery {
                lower: Bound::Included(&lower),
                upper: upper.as_deref().map_or(Bound::Unbounded, Bound::Excluded),
                prefix: None,
                order: IndexOrder::Ascending,
                after: cursor.as_ref(),
                limit: SLICE_ROWS,
            },
        )?;
        for entry in &page {
            let row = &entry.record;
            let counts = groups
                .entry((
                    row.provider_id.clone(),
                    row.model_id.clone(),
                    by_agent.then(|| row.agent.clone()),
                ))
                .or_default();
            match row.kind.as_str() {
                Some("fallback") => counts.fallbacks += 1,
                Some("guardrail-escalated") => counts.escalated += 1,
                _ => counts.rejected += 1,
            }
            counts.last = counts.last.max(row.time_created);
        }
        if page.len() < SLICE_ROWS {
            return Ok(groups);
        }
        cursor = page.last().map(|entry| entry.cursor.clone());
    }
}

fn item(row: Incident) -> Result<model_incident::Item, Error> {
    Ok(model_incident::Item {
        id: model_incident::Id(row.id),
        time: number(row.time_created)?,
        kind: model_incident::Kind(row.kind),
        category: row.category,
        rule_ids: row.rule_ids.domain()?,
        agent: row.agent,
        variant: row.variant,
        profile: row.profile.map(model::ProfileName),
        target: row.target.map(|target| target.domain()).transpose()?,
        decided_by: row.decided_by.map(model_incident::DecidedBy),
    })
}

fn watermark_key(model: &ModelKey) -> Vec<u8> {
    tuple_key(&[
        KeyPart::String(&model.provider.0),
        KeyPart::String(&model.model),
    ])
}

fn number(value: i64) -> Result<NonNegativeInt, Error> {
    NonNegativeInt::new(value).map_err(|_| {
        Error::Store(ycoding_store::Error::Incompatible(
            "model incident count is out of range",
        ))
    })
}
