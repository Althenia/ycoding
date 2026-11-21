use super::{
    compaction_job::{CompactionError, EndInput, FailInput, Lease, Target},
    context_manifest::{self, Manifest},
    projector,
    runner::Clock,
    store::Service,
};
use std::{future::Future, ops::Bound, pin::Pin};
use ycoding_schema::{
    DomainDecode, DomainEncode, JsonValue, LosslessString, parse_json, schema::NonNegativeInt,
    session_compaction,
};
use ycoding_store::{
    IndexOrder,
    session::{Document, Job, Manifest as ManifestRow, ManifestTable},
};

const LEASE_MILLISECONDS: i64 = 30_000;
const HEARTBEAT_MILLISECONDS: u64 = 10_000;
const POLL_MILLISECONDS: u64 = 100;
const ACTIVATION_ATTEMPTS: u32 = 3;

type Failure = session_compaction::FailureCode;
pub type ManifestFuture<'a> = Pin<Box<dyn Future<Output = Result<Manifest, Failure>> + Send + 'a>>;
pub type Builder<'a> = &'a (dyn Fn(Job) -> ManifestFuture<'a> + Sync);

enum Outcome {
    Ended,
    Failed(Failure),
    Store(CompactionError),
}

pub async fn run(
    store: &Service,
    clock: &dyn Clock,
    id: &session_compaction::Id,
    builder: Builder<'_>,
) -> Result<Job, CompactionError> {
    loop {
        let Some(job) = store.compaction_job(id)? else {
            return Err(CompactionError::Conflict {
                id: Some(identity(id)),
                message: "Compaction job does not exist".into(),
            });
        };
        if matches!(job.status.as_str(), Some("ended" | "failed")) {
            return Ok(job);
        }
        let owner = format!(
            "compaction-{}",
            projector::random_event_id()?
                .as_lossless()
                .to_utf8()
                .unwrap_or_default()
                .trim_start_matches("evt_")
        );
        let now = clock.now();
        let claimed = store
            .compaction_claim(
                Target::Job(id.clone()),
                Lease {
                    owner: owner.clone(),
                    now,
                    expires_at: now + LEASE_MILLISECONDS,
                },
            )
            .await?;
        match claimed {
            Some(claimed) => execute(store, clock, claimed, &owner, builder).await?,
            None => clock.sleep(POLL_MILLISECONDS).await,
        }
    }
}

async fn execute(
    store: &Service,
    clock: &dyn Clock,
    claimed: Job,
    owner: &str,
    builder: Builder<'_>,
) -> Result<(), CompactionError> {
    let id = job_id(&claimed.id)?;
    let work = async {
        let mut remaining = ACTIVATION_ATTEMPTS;
        loop {
            remaining -= 1;
            let outcome = match builder(claimed.clone()).await {
                Ok(manifest) => activate(store, clock, &claimed, owner, &manifest).await,
                Err(code) => Outcome::Failed(code),
            };
            match outcome {
                Outcome::Failed(Failure::ProtectedStateChanged) if remaining > 0 => continue,
                outcome => return outcome,
            }
        }
    };
    let heartbeat = async {
        loop {
            clock.sleep(HEARTBEAT_MILLISECONDS).await;
            if let Err(error) = store
                .compaction_heartbeat(
                    id.clone(),
                    owner.to_string(),
                    clock.now() + LEASE_MILLISECONDS,
                )
                .await
            {
                return error;
            }
        }
    };
    let outcome = tokio::select! {
        outcome = work => outcome,
        error = heartbeat => Outcome::Store(error),
    };
    match outcome {
        Outcome::Ended => Ok(()),
        Outcome::Store(error) => Err(error),
        Outcome::Failed(code) => {
            let current = store.compaction_job(&id)?;
            if current
                .as_ref()
                .is_some_and(|job| matches!(job.status.as_str(), Some("ended" | "failed")))
            {
                return Ok(());
            }
            store
                .compaction_fail(FailInput {
                    id,
                    owner: Some(owner.to_string()),
                    code,
                    now: clock.now(),
                })
                .await?;
            Ok(())
        }
    }
}

async fn activate(
    store: &Service,
    clock: &dyn Clock,
    job: &Job,
    owner: &str,
    manifest: &Manifest,
) -> Outcome {
    match settle(store, clock, job, owner, manifest).await {
        Ok(()) => Outcome::Ended,
        Err(CompactionError::Conflict { message, .. })
            if message.contains("active context revision")
                || message.contains("canonical Session history") =>
        {
            Outcome::Failed(Failure::ProtectedStateChanged)
        }
        Err(CompactionError::Conflict { .. }) => Outcome::Failed(Failure::InvalidManifest),
        Err(error) => Outcome::Store(error),
    }
}

async fn settle(
    store: &Service,
    clock: &dyn Clock,
    job: &Job,
    owner: &str,
    manifest: &Manifest,
) -> Result<(), CompactionError> {
    let digest = context_manifest::manifest_digest(manifest);
    let content = parse_json(&context_manifest::manifest_json(manifest)).map_err(|_| {
        CompactionError::Conflict {
            id: Some(job.id.clone()),
            message: "Manifest content is not JSON".into(),
        }
    })?;
    let summary_messages = match &manifest.summary {
        Some(summary) => covered_messages(store, job, summary.covered_through.seq.get())?,
        None => 0,
    };
    let counted = |kind: &str| {
        manifest
            .exclusions
            .iter()
            .filter(|exclusion| {
                exclusion.reason() != "provider_rebase" && exclusion.target_kind() == kind
            })
            .count() as i64
    };
    let now = clock.now();
    let row = ManifestRow {
        digest: digest.as_str().into(),
        schema_version: 1,
        content: Document::new(content).map_err(CompactionError::Store)?,
        input_tokens: manifest.input_tokens,
        retained_tokens: manifest.retained_tokens,
        time_created: now,
    };
    store
        .client
        .submit(move |tx| {
            if tx.get::<ManifestTable>(&super::key(&row.digest))?.is_none() {
                ManifestTable::insert(tx, &row)?;
            }
            Ok(())
        })?
        .await?;
    let number = |value: i64| {
        NonNegativeInt::new(value).map_err(|_| CompactionError::Conflict {
            id: Some(job.id.clone()),
            message: "Compaction settlement values are invalid".into(),
        })
    };
    store
        .compaction_end(EndInput {
            id: job_id(&job.id)?,
            owner: owner.to_string(),
            manifest_digest: digest,
            revision: job.base_context_revision + 1,
            boundary: session_compaction::Boundary {
                message_id: manifest.covered_through.message_id.clone(),
                seq: manifest.covered_through.seq,
            },
            metrics: session_compaction::Metrics {
                excluded_messages: number(summary_messages + counted("message"))?,
                excluded_parts: number(counted("part"))?,
                input_tokens: number(manifest.input_tokens)?,
                retained_tokens: number(manifest.retained_tokens)?,
            },
            now,
        })
        .await?;
    Ok(())
}

fn covered_messages(store: &Service, job: &Job, seq: i64) -> Result<i64, CompactionError> {
    let snapshot = store.client.snapshot()?;
    let mut count = 0;
    let mut after = None;
    loop {
        let page = ycoding_store::session::messages(
            &snapshot,
            &job.session_id,
            Bound::Unbounded,
            Bound::Included(seq),
            IndexOrder::Ascending,
            after.as_ref(),
            128,
        )?;
        let Some(last) = page.last() else {
            return Ok(count);
        };
        after = Some(last.cursor.clone());
        count += page.len() as i64;
    }
}

pub fn job_id(id: &LosslessString) -> Result<session_compaction::Id, CompactionError> {
    session_compaction::Id::decode(&JsonValue::String(id.clone())).map_err(|_| {
        CompactionError::Conflict {
            id: Some(id.clone()),
            message: "Compaction job identity is invalid".into(),
        }
    })
}

fn identity(id: &session_compaction::Id) -> LosslessString {
    match id.encode() {
        JsonValue::String(text) => text,
        _ => LosslessString::from(""),
    }
}
