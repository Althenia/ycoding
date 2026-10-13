use super::{
    compaction_policy::Resolved,
    compaction_summary::{self, Generate, Settings, Source},
    context_manifest::{
        self, Candidate, ContextItem, ContextItemKind, CoveredThrough, Manifest, ModelTokens,
        ProtectedStateEntry, RollingSummary, RuntimeEvidence, ValidationInput,
    },
    context_pressure::estimate_json,
    model_history::checkpoint_entry,
    skill_status,
    store::Service,
};
use std::ops::Bound;
use ycoding_schema::{
    LosslessString, schema::NonNegativeInt, session, session_compaction, session_message,
    session_skill_status::State,
};
use ycoding_store::{IndexOrder, session::Job};

type Failure = session_compaction::FailureCode;

#[derive(Default)]
pub struct LiveState {
    pub required_texts: Vec<String>,
    pub protected_state: Vec<ProtectedStateEntry>,
}

pub type LoadLiveState<'a> = &'a (dyn Fn(&session::Id) -> Result<LiveState, Failure> + Sync);

pub struct Input<'a, 'g> {
    pub store: &'a Service,
    pub job: &'a Job,
    pub policy: &'a Resolved,
    pub helper_context_window: Option<i64>,
    pub generate: Option<Generate<'g>>,
    pub live_state: LoadLiveState<'a>,
}

pub async fn manifest(input: Input<'_, '_>) -> Result<Manifest, Failure> {
    let job = input.job;
    let session = session::Id::new(
        job.session_id
            .to_utf8()
            .map_err(|_| Failure::MigrationFailed)?,
    )
    .map_err(|_| Failure::MigrationFailed)?;
    let rows = rows_through(input.store, job).map_err(|_| Failure::MigrationFailed)?;
    if !rows.iter().any(|row| {
        row.id == job.requested_through_message_id && row.seq == job.requested_through_seq
    }) {
        return Err(Failure::ContextLimitUnresolved);
    }
    let items = rows
        .iter()
        .enumerate()
        .map(|(position, row)| ContextItem {
            message_id: message_id(&row.id),
            position: position as i64,
            terminal_seq: row.seq,
            input_kind: row.type_.to_utf8().unwrap_or_default(),
            payload: row.data.clone(),
            tokens: estimate_json(&row.data),
            dependency_group: None,
            tool_call: None,
            kind: ContextItemKind::Message,
            ordinal: 0,
            part_kind: String::new(),
            execution_group: String::new(),
            intermediate_kind: None,
        })
        .collect::<Vec<_>>();
    let decoded = rows
        .iter()
        .filter_map(|row| row.info().ok().map(|info| (row.seq, info)))
        .collect::<Vec<_>>();
    let max_input_tokens = match input.generate {
        Some(_) => job.target_max_input_tokens.unwrap_or(0).min(
            input.helper_context_window.unwrap_or(0) - input.policy.context_safety_margin_tokens,
        ),
        None => job.target_max_input_tokens.unwrap_or(0),
    };
    if max_input_tokens <= 0 {
        return Err(Failure::ContextLimitUnresolved);
    }
    let selected_before = input
        .store
        .model_history(&session)
        .map_err(|_| Failure::MigrationFailed)?
        .into_iter()
        .filter(|entry| entry.seq <= job.requested_through_seq)
        .collect::<Vec<_>>();
    let previous = selected_before
        .iter()
        .filter_map(|entry| compaction_summary::checkpoint_memory(entry.seq, &entry.message))
        .next_back();
    let covered = previous
        .as_ref()
        .map_or(0, |memory| memory.through_sequence);
    let uncovered = items
        .iter()
        .filter(|item| item.terminal_seq > covered)
        .collect::<Vec<_>>();
    let tail = if job.trigger.as_str() == Some("mandatory") {
        0
    } else {
        (input.policy.keep_recent_messages.max(0) as usize).min(uncovered.len())
    };
    let source = uncovered[..uncovered.len() - tail]
        .iter()
        .map(|item| {
            Source::new(
                item.message_id.clone(),
                item.terminal_seq,
                &item.input_kind,
                decoded
                    .iter()
                    .find(|(seq, _)| *seq == item.terminal_seq)
                    .map(|(_, info)| info),
                &item.payload,
            )
        })
        .collect::<Vec<_>>();
    let Some(last) = source.last() else {
        return Err(Failure::ContextLimitUnresolved);
    };
    let summary_through = last.terminal_seq;
    let covered_through = CoveredThrough {
        message_id: message_id(&job.requested_through_message_id),
        seq: NonNegativeInt::new(job.requested_through_seq)
            .map_err(|_| Failure::MigrationFailed)?,
    };
    let evidence = RuntimeEvidence {
        base_context_revision: job.base_context_revision,
        covered_through: covered_through.clone(),
        items: items.clone(),
        settlements: Vec::new(),
        authorities: Vec::new(),
        resource_authorities: Vec::new(),
        tool_results: Vec::new(),
        recent_tail: uncovered[uncovered.len() - tail..]
            .iter()
            .map(|item| context_manifest::selector(item))
            .collect(),
        protected_targets: Vec::new(),
        provider_links: Vec::new(),
        protected_state: Vec::new(),
    };
    let required_skills = skill_status::list(
        &decoded
            .iter()
            .filter(|(seq, _)| *seq <= summary_through)
            .map(|(_, info)| info.clone())
            .collect::<Vec<_>>(),
        &[],
    )
    .into_iter()
    .filter(|skill| skill.state == State::Active)
    .map(|skill| {
        compaction_summary::skill_text(
            &text(&skill.name),
            &text(&skill.id),
            &text(&skill.activated_by),
            &text(skill.activation_message_id.as_lossless()),
            &text(&skill.content),
        )
    })
    .collect::<Vec<_>>();
    let input_tokens = compaction_summary::input_tokens(
        &selected_before
            .iter()
            .map(|entry| entry.message.clone())
            .collect::<Vec<_>>(),
    );
    let retained_tokens = |summary: &str, through: i64| {
        let checkpoint =
            checkpoint_entry(through, summary.into(), &"0".repeat(64), 1_000_000_000_000)
                .expect("checkpoint entry has a valid synthetic identity");
        compaction_summary::input_tokens(
            &std::iter::once(checkpoint.message)
                .chain(
                    selected_before
                        .iter()
                        .filter(|entry| entry.seq > through)
                        .map(|entry| entry.message.clone()),
                )
                .collect::<Vec<_>>(),
        )
    };
    let accepts = |summary: &str, through: i64| retained_tokens(summary, through) < input_tokens;
    let settings = Settings {
        max_calls: input.policy.max_internal_passes,
        max_bytes: input.policy.max_manifest_bytes.max(0) as usize,
        max_input_tokens,
        accepts: &accepts,
        required_texts: Vec::new(),
        required_skills,
        previous,
    };
    let candidate = match input.generate {
        Some(_) if input.policy.timeout_seconds > 0 => {
            let bounded = tokio::time::timeout(
                std::time::Duration::from_secs(input.policy.timeout_seconds as u64),
                compaction_summary::generate(&source, &settings, input.generate),
            )
            .await;
            match bounded {
                Ok(candidate) => candidate,
                Err(_) => compaction_summary::generate(&source, &settings, None).await,
            }
        }
        generate => compaction_summary::generate(&source, &settings, generate).await,
    };
    let live = (input.live_state)(&session)?;
    let settings = Settings {
        required_texts: live.required_texts,
        ..settings
    };
    let summary = candidate
        .and_then(|candidate| compaction_summary::finalize(&source, &settings, &candidate))
        .ok_or(Failure::ContextLimitUnresolved)?;
    let validated = context_manifest::validate(&ValidationInput {
        candidate: Candidate {
            base_context_revision: NonNegativeInt::new(job.base_context_revision)
                .map_err(|_| Failure::MigrationFailed)?,
            covered_through: covered_through.clone(),
            protected_state: live.protected_state.clone(),
            exclusions: Vec::new(),
        },
        evidence: RuntimeEvidence {
            protected_state: live.protected_state,
            ..evidence
        },
        summary: Some(RollingSummary {
            text: summary.as_str().into(),
            covered_through: CoveredThrough {
                message_id: last.message_id.clone(),
                seq: NonNegativeInt::new(summary_through).map_err(|_| Failure::MigrationFailed)?,
            },
            digest: last.digest.as_str().into(),
        }),
        model_tokens: Some(ModelTokens {
            before: input_tokens,
            after: retained_tokens(&summary, summary_through),
        }),
    });
    match validated {
        Ok(manifest) => Ok(manifest),
        Err(issues)
            if issues
                .iter()
                .any(|issue| issue.code == context_manifest::IssueCode::ProtectedStateChanged) =>
        {
            Err(Failure::ProtectedStateChanged)
        }
        Err(issues)
            if issues
                .iter()
                .all(|issue| issue.code == context_manifest::IssueCode::NoTokenReduction) =>
        {
            Err(Failure::ContextLimitUnresolved)
        }
        Err(_) => Err(Failure::InvalidManifest),
    }
}

fn rows_through(
    store: &Service,
    job: &Job,
) -> Result<Vec<ycoding_store::session::Message>, ycoding_store::Error> {
    let snapshot = store.client.snapshot()?;
    let mut rows = Vec::new();
    let mut after = None;
    loop {
        let page = ycoding_store::session::messages(
            &snapshot,
            &job.session_id,
            Bound::Unbounded,
            Bound::Included(job.requested_through_seq),
            IndexOrder::Ascending,
            after.as_ref(),
            128,
        )?;
        let Some(last) = page.last() else {
            return Ok(rows);
        };
        after = Some(last.cursor.clone());
        rows.extend(page.into_iter().map(|entry| entry.record));
    }
}

fn message_id(id: &LosslessString) -> session_message::Id {
    session_message::Id::new(id.to_utf8().unwrap_or_default())
        .expect("stored message identities are valid")
}

fn text(value: &LosslessString) -> String {
    value.to_utf8().unwrap_or_default()
}
