use super::ModelKey;
use crate::instructions::{self, Observation, Source};
use std::{
    collections::{BTreeMap, BTreeSet},
    ops::Bound,
    sync::Arc,
};
use ycoding_schema::{DomainDecode, JsonValue, LosslessString, instruction};
use ycoding_store::{
    Client, IndexOrder, IndexQuery, KeyPart, Snapshot,
    model_incident::{GUIDANCE_INDEX, GuidanceClearTable, IncidentTable},
    tuple_key,
};

pub const KEY: &str = "core/model-guidance";
pub const WINDOW_MILLIS: i64 = 30 * 86_400_000;
pub const THRESHOLD: usize = 2;
pub const MAX_LINES: usize = 5;
pub const MAX_BYTES: usize = 1_024;
pub const MAX_ROWS: usize = 10_000;
pub const RETRACTION: &str = "Earlier <model-guidance> notes no longer apply.";

const CHANGED: &str = "Model guidance changed. It replaces the earlier <model-guidance> notes.\n";
const HEADER: &str =
    "<model-guidance>\nPast guardrail reviews stopped some of this model's actions:";
const FOOTER: &str = "</model-guidance>";
const CUSTOM: &str = "custom";
const LINES: [(&str, &str); 7] = [
    (
        "standard.review.outside-repo",
        "Outside-repository changes (standard.review.outside-repo): Respect approved paths and required approval checks for outside-repository mutations.",
    ),
    (
        "standard.review.git-destructive",
        "Destructive Git (standard.review.git-destructive): Prefer reversible Git commands and retain required approval checks.",
    ),
    (
        "standard.review.force-push",
        "Force push (standard.review.force-push): Do not force-push unless the task requires it; retain required approval checks.",
    ),
    (
        "standard.review.project-deletion",
        "Project deletion (standard.review.project-deletion): Confirm the target and pass required approval checks before deleting a project or its ancestors.",
    ),
    (
        "standard.review.home-child",
        "Home-directory deletion (standard.review.home-child): Confirm the target and pass required approval checks before deleting a direct child of the home directory.",
    ),
    (
        "standard.review.database-destructive",
        "Destructive database statements (standard.review.database-destructive): Use scoped statements and pass required approval checks before destructive database changes.",
    ),
    (
        CUSTOM,
        "Custom guardrail rules (custom): Review configured guardrail rules before repeating a blocked action.",
    ),
];

pub fn text(
    snapshot: &Snapshot,
    model: &ModelKey,
    now: i64,
) -> Result<Option<String>, ycoding_store::Error> {
    let prefix = [
        KeyPart::String(&model.provider.0),
        KeyPart::String(&model.model),
    ];
    let cleared = snapshot
        .get::<GuidanceClearTable>(&tuple_key(&prefix))?
        .map_or(-1, |row| row.cleared_at);
    let lower = (now - WINDOW_MILLIS).max(cleared.saturating_add(1));
    let bound = |time: i64| tuple_key(&[prefix[0], prefix[1], KeyPart::I64(time)]);
    let (lower, upper) = (bound(lower), bound(now.saturating_add(1)));
    let rows = snapshot.index_range::<IncidentTable>(
        GUIDANCE_INDEX,
        IndexQuery {
            lower: Bound::Included(&lower),
            upper: Bound::Excluded(&upper),
            prefix: Some(&tuple_key(&prefix)),
            order: IndexOrder::Descending,
            after: None,
            limit: MAX_ROWS,
        },
    )?;
    let mut requests = BTreeMap::<&str, BTreeSet<LosslessString>>::new();
    for row in &rows {
        let Some(request) = &row.record.request_id else {
            continue;
        };
        for rule in row.record.rule_ids.domain()? {
            let key = LINES
                .iter()
                .find(|(id, _)| rule.as_str() == Some(*id))
                .map_or(CUSTOM, |(id, _)| *id);
            requests.entry(key).or_default().insert(request.clone());
        }
    }
    Ok(render(requests))
}

fn render(requests: BTreeMap<&str, BTreeSet<LosslessString>>) -> Option<String> {
    let mut selected = requests
        .into_iter()
        .filter(|(_, group)| group.len() >= THRESHOLD)
        .collect::<Vec<_>>();
    selected.sort_by(|(left, a), (right, b)| b.len().cmp(&a.len()).then(left.cmp(right)));
    let lines = selected
        .into_iter()
        .take(MAX_LINES)
        .filter_map(|(rule, _)| LINES.iter().find(|(id, _)| *id == rule))
        .map(|(_, line)| format!("- {line}"))
        .collect::<Vec<_>>();
    (0..lines.len())
        .map(|dropped| {
            std::iter::once(HEADER.to_owned())
                .chain(lines[..lines.len() - dropped].iter().cloned())
                .chain(std::iter::once(FOOTER.to_owned()))
                .collect::<Vec<_>>()
                .join("\n")
        })
        .find(|candidate| candidate.len() <= MAX_BYTES)
}

pub fn source(
    client: Client,
    model: ModelKey,
    clock: Arc<dyn Fn() -> i64 + Send + Sync>,
) -> Source {
    Source {
        key: instruction::Key::decode(&JsonValue::String(KEY.into()))
            .expect("model guidance instruction key is valid"),
        read: Arc::new(move || {
            let client = client.clone();
            let model = model.clone();
            let now = clock();
            Box::pin(async move {
                let text =
                    tokio::task::spawn_blocking(move || text(&client.snapshot()?, &model, now))
                        .await
                        .map_err(|_| instructions::Error::ReaderFailed)??;
                Ok(text.map_or(Observation::Removed, |text| {
                    Observation::Value(JsonValue::String(text.into()))
                }))
            })
        }),
        initial: Arc::new(|value| match value {
            JsonValue::String(text) => Some(text.clone()),
            _ => None,
        }),
        changed: Arc::new(|_, value| match value {
            JsonValue::String(text) => {
                Some(instructions::join(&[CHANGED.into(), text.clone()], ""))
            }
            _ => None,
        }),
        removed: Some(Arc::new(|_| Some(RETRACTION.into()))),
    }
}
