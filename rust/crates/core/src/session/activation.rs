use super::{prompt_cache::sha256, store::Service};
use crate::resources::recall::{
    candidate::{Candidate, Method, MethodScore, Reason},
    document::{Kind, Scope},
};
use std::collections::BTreeMap;
use ycoding_schema::{
    JsonValue, LosslessString, ObjectEncoder, recall, schema::NonNegativeInt, session,
    session_message,
};
use ycoding_store::{Error, session::NewEvent};

const MAX_ITEMS: usize = 64;

pub fn precedence(method: Method) -> u8 {
    match method {
        Method::Explicit => 0,
        Method::Cue => 1,
        Method::Exact => 2,
        Method::Rrf => 3,
        Method::Bm25 => 4,
        Method::Semantic => 5,
    }
}

pub fn order<T>(candidates: &mut [(Candidate, T)]) {
    candidates.sort_by(|(a, _), (b, _)| {
        precedence(a.method)
            .cmp(&precedence(b.method))
            .then_with(|| a.order(b))
    });
    let mut ranks = BTreeMap::new();
    for (candidate, _) in candidates.iter_mut() {
        let rank = ranks.entry(candidate.method).or_insert(0usize);
        let method = candidate.method;
        if let Some(score) = candidate
            .scores
            .iter_mut()
            .find(|score| score.method == method)
        {
            score.rank = *rank;
        }
        *rank += 1;
    }
}

pub fn method(method: Method) -> recall::Method {
    match method {
        Method::Explicit => recall::Method::Explicit,
        Method::Cue => recall::Method::Cue,
        Method::Exact => recall::Method::Exact,
        Method::Bm25 => recall::Method::Bm25,
        Method::Semantic => recall::Method::Semantic,
        Method::Rrf => recall::Method::Rrf,
    }
}

fn kind(kind: Kind) -> recall::Kind {
    match kind {
        Kind::Concept | Kind::Experience => recall::Kind::Memory,
        Kind::Skill => recall::Kind::Skill,
    }
}

fn scores(candidate: &Candidate) -> Option<recall::Scores> {
    let value = |method| candidate.score(method).map(|score| score.score);
    let scores = recall::Scores {
        bm25: value(Method::Bm25),
        semantic: value(Method::Semantic),
        rrf: value(Method::Rrf),
        rank: candidate
            .score(candidate.method)
            .and_then(|score| NonNegativeInt::new(score.rank as i64).ok()),
    };
    (scores.bm25.is_some()
        || scores.semantic.is_some()
        || scores.rrf.is_some()
        || scores.rank.is_some())
    .then_some(scores)
}

pub fn source(id: &str, content: &str) -> recall::Source {
    recall::Source {
        id: id.into(),
        revision: format!("sha256:{}", sha256(content)).into(),
    }
}

pub fn item(
    candidate: &Candidate,
    source: recall::Source,
    rejection: Option<recall::Rejection>,
    tokens: i64,
) -> recall::Item {
    recall::Item {
        kind: kind(candidate.kind),
        id: candidate.id.as_str().into(),
        stage: match rejection {
            Some(_) => recall::Stage::Rejected,
            None => recall::Stage::Selected,
        },
        method: method(candidate.method),
        scores: scores(candidate),
        reason: candidate.reason.as_str().into(),
        rejection,
        source,
        okf: None,
        artifact: None,
        tokens: NonNegativeInt::new(tokens.max(0)).ok(),
    }
}

pub fn candidate(id: &str, method: Method, reason: Reason, score: f64, content: &str) -> Candidate {
    Candidate {
        id: id.into(),
        kind: Kind::Skill,
        scope: Scope::Project,
        content_hash: sha256(content),
        method,
        scores: vec![MethodScore {
            method,
            score,
            rank: 0,
        }],
        reason,
        bytes: content.len(),
        aliases: Vec::new(),
    }
}

pub struct TraceCue {
    pub kind: recall::CueKind,
    pub subject: Option<String>,
}

pub struct Trace {
    pub items: Vec<recall::Item>,
    pub cues: Vec<TraceCue>,
    pub started: std::time::Instant,
}

impl Trace {
    pub fn new() -> Self {
        Self {
            items: Vec::new(),
            cues: Vec::new(),
            started: std::time::Instant::now(),
        }
    }

    pub fn cue(&mut self, kind: recall::CueKind, subject: Option<String>) {
        if self
            .cues
            .iter()
            .any(|cue| cue.kind == kind && cue.subject == subject)
        {
            return;
        }
        self.cues.push(TraceCue { kind, subject });
    }

    pub fn trigger(&self) -> recall::Trigger {
        let has = |kind| self.cues.iter().any(|cue| cue.kind == kind);
        if has(recall::CueKind::Explicit) {
            recall::Trigger::Explicit
        } else if has(recall::CueKind::Compaction) {
            recall::Trigger::Compaction
        } else if has(recall::CueKind::Recovery) {
            recall::Trigger::Recovery
        } else if self.cues.is_empty() {
            recall::Trigger::Prompt
        } else {
            recall::Trigger::Cue
        }
    }
}

pub fn injected(items: Vec<recall::Item>) -> Vec<recall::Item> {
    items
        .into_iter()
        .map(|item| match item.stage {
            recall::Stage::Selected => recall::Item {
                stage: recall::Stage::Injected,
                ..item
            },
            _ => item,
        })
        .collect()
}

pub fn restored(items: Vec<recall::Item>) -> Vec<recall::Item> {
    items
        .into_iter()
        .map(|item| match item.stage {
            recall::Stage::Selected | recall::Stage::Injected => recall::Item {
                stage: recall::Stage::Restored,
                ..item
            },
            _ => item,
        })
        .collect()
}

pub struct Recording<'a> {
    pub session: &'a session::Id,
    pub identity: &'a str,
    pub trigger: recall::Trigger,
    pub cue: Option<&'a str>,
    pub items: Vec<recall::Item>,
    pub elapsed_ms: i64,
    pub budget: Option<usize>,
}

fn count(value: i64) -> Result<NonNegativeInt, Error> {
    NonNegativeInt::new(value.max(0)).map_err(|_| Error::Rejected("Invalid recall count"))
}

fn abstention(items: &[recall::Item]) -> recall::Abstention {
    let rejected = |reason| {
        items
            .iter()
            .any(|item| item.rejection == Some(reason) && item.method == recall::Method::Explicit)
    };
    if rejected(recall::Rejection::Missing)
        || rejected(recall::Rejection::Denied)
        || rejected(recall::Rejection::Disabled)
    {
        recall::Abstention::ExplicitUnavailable
    } else if items
        .iter()
        .any(|item| item.rejection == Some(recall::Rejection::OverBudget))
    {
        recall::Abstention::OutOfBudget
    } else if items
        .iter()
        .any(|item| item.rejection == Some(recall::Rejection::BelowThreshold))
    {
        recall::Abstention::BelowThreshold
    } else {
        recall::Abstention::NoMatch
    }
}

pub fn recorded(recording: Recording<'_>, now: i64) -> Result<(String, NewEvent), Error> {
    let mut items = recording.items;
    items.truncate(MAX_ITEMS);
    let mut methods = Vec::new();
    for item in &items {
        if !methods.contains(&item.method) {
            methods.push(item.method);
        }
    }
    let delivered = |stage| items.iter().any(|item| item.stage == stage);
    let outcome = if delivered(recall::Stage::Injected) {
        recall::Outcome::Injected
    } else if delivered(recall::Stage::Restored) {
        recall::Outcome::Restored
    } else {
        recall::Outcome::Abstained
    };
    let tokens = items
        .iter()
        .filter(|item| {
            matches!(
                item.stage,
                recall::Stage::Injected | recall::Stage::Restored
            )
        })
        .filter_map(|item| item.tokens)
        .map(|tokens| tokens.get())
        .sum::<i64>();
    let abstained = (outcome == recall::Outcome::Abstained).then(|| abstention(&items));
    let canonical = items
        .iter()
        .map(|item| {
            format!(
                "{}:{}:{}:{}",
                item.kind.as_str(),
                item.id.to_utf8().unwrap_or_default(),
                item.source.revision.to_utf8().unwrap_or_default(),
                item.stage.as_str()
            )
        })
        .collect::<Vec<_>>()
        .join("|");
    let key = sha256(&format!(
        "{}|{}|{}|{canonical}",
        recording.identity,
        recording.trigger.as_str(),
        recording.cue.unwrap_or_default()
    ));
    let data = ObjectEncoder::new()
        .field("sessionID", recording.session)
        .field("key", &LosslessString::from(key.as_str()))
        .field("trigger", &recording.trigger)
        .optional("cueID", &recording.cue.map(LosslessString::from))
        .field("methods", &recall::Methods(methods))
        .field("outcome", &outcome)
        .optional("abstention", &abstained)
        .field("items", &recall::Items(items))
        .field("elapsedMs", &count(recording.elapsed_ms)?)
        .field("injectedTokens", &count(tokens)?)
        .optional(
            "budgetTokens",
            &recording
                .budget
                .and_then(|budget| NonNegativeInt::new(budget as i64).ok()),
        )
        .finish();
    Ok((
        key.clone(),
        event("session.recall.recorded.1", recording.session, now, data)?,
    ))
}

pub struct Cue<'a> {
    pub session: &'a session::Id,
    pub kind: recall::CueKind,
    pub subject: Option<&'a str>,
    pub message: Option<&'a session_message::Id>,
    pub identity: &'a str,
}

pub fn cue_id(cue: &Cue<'_>) -> String {
    let digest = sha256(&format!(
        "{}|{}|{}",
        cue.kind.as_str(),
        cue.subject.unwrap_or_default(),
        cue.identity
    ));
    format!("cue_{}", &digest[..32])
}

pub fn detected(cue: &Cue<'_>, now: i64) -> Result<(String, NewEvent), Error> {
    let id = cue_id(cue);
    let subject = cue.subject.map(|subject| {
        let mut end = subject.len().min(512);
        while !subject.is_char_boundary(end) {
            end -= 1;
        }
        LosslessString::from(&subject[..end])
    });
    let data = ObjectEncoder::new()
        .field("sessionID", cue.session)
        .field("cueID", &LosslessString::from(id.as_str()))
        .field("kind", &cue.kind)
        .optional("subject", &subject)
        .optional("messageID", &cue.message.cloned())
        .finish();
    Ok((id, event("session.cue.detected.1", cue.session, now, data)?))
}

fn event(type_: &str, session: &session::Id, now: i64, data: JsonValue) -> Result<NewEvent, Error> {
    Ok(NewEvent {
        id: super::projector::random_event_id()?.as_lossless().clone(),
        aggregate_id: session.as_lossless().clone(),
        created: now,
        type_: type_.into(),
        data,
    })
}

fn once_key(session: &session::Id, kind: &str, key: &str) -> LosslessString {
    use ycoding_schema::DomainEncode;
    format!(
        "recall-once:{}:{kind}:{key}",
        ycoding_schema::stringify_json(&session.encode())
    )
    .into()
}

pub async fn append_once(
    store: &Service,
    session: &session::Id,
    kind: &'static str,
    key: String,
    event: NewEvent,
) -> Result<bool, Error> {
    let marker = once_key(session, kind, &key);
    let now = event.created;
    store
        .client
        .submit(move |tx| {
            if tx
                .get::<ycoding_store::resources::KvTable>(&super::key(&marker))?
                .is_some()
            {
                return Ok(false);
            }
            ycoding_store::resources::set_kv(
                tx,
                &marker,
                &ycoding_store::session::Document::new(JsonValue::Bool(true))?,
                now,
            )?;
            super::projector::append(tx, &event)?;
            Ok(true)
        })?
        .await
}

pub async fn record(store: &Service, recording: Recording<'_>, now: i64) -> Result<bool, Error> {
    let session = recording.session.clone();
    let (key, event) = recorded(recording, now)?;
    append_once(store, &session, "recall", key, event).await
}

pub async fn detect(store: &Service, cue: Cue<'_>, now: i64) -> Result<String, Error> {
    let (id, event) = detected(&cue, now)?;
    append_once(store, cue.session, "cue", id.clone(), event).await?;
    Ok(id)
}

pub async fn publish(
    store: &Service,
    session: &session::Id,
    identity: &str,
    message: Option<&session_message::Id>,
    trace: Trace,
    now: i64,
) -> Result<(), Error> {
    let trigger = trace.trigger();
    let restore = matches!(
        trigger,
        recall::Trigger::Compaction | recall::Trigger::Recovery
    );
    let mut cue_id = None;
    for cue in &trace.cues {
        let id = detect(
            store,
            Cue {
                session,
                kind: cue.kind,
                subject: cue.subject.as_deref(),
                message,
                identity,
            },
            now,
        )
        .await?;
        cue_id.get_or_insert(id);
    }
    if trace.items.is_empty() {
        return Ok(());
    }
    let items = if restore {
        restored(trace.items)
    } else {
        injected(trace.items)
    };
    record(
        store,
        Recording {
            session,
            identity,
            trigger,
            cue: cue_id.as_deref(),
            items,
            elapsed_ms: trace.started.elapsed().as_millis() as i64,
            budget: Some(2048),
        },
        now,
    )
    .await?;
    Ok(())
}

pub fn memory_item(
    id: &str,
    digest: &str,
    reason: &str,
    score: f64,
    rank: usize,
    content: &str,
) -> recall::Item {
    let exact = reason != "lexical";
    recall::Item {
        kind: recall::Kind::Memory,
        id: id.into(),
        stage: recall::Stage::Candidate,
        method: if exact {
            recall::Method::Exact
        } else {
            recall::Method::Bm25
        },
        scores: Some(recall::Scores {
            bm25: Some(score),
            semantic: None,
            rrf: None,
            rank: NonNegativeInt::new(rank as i64).ok(),
        }),
        reason: reason.into(),
        rejection: None,
        source: recall::Source {
            id: id.into(),
            revision: format!("sha256:{digest}").into(),
        },
        okf: None,
        artifact: None,
        tokens: NonNegativeInt::new(super::context_pressure::estimate(content)).ok(),
    }
}

pub fn delivered(item: recall::Item, _budget: usize) -> recall::Item {
    recall::Item {
        stage: recall::Stage::Injected,
        ..item
    }
}

pub fn refused(item: recall::Item, rejection: recall::Rejection) -> recall::Item {
    recall::Item {
        stage: recall::Stage::Rejected,
        rejection: Some(rejection),
        ..item
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ycoding_schema::{DomainDecode, parse_json, session_event};

    fn ranked(id: &str, method: Method, score: f64) -> (Candidate, ()) {
        (candidate(id, method, Reason::Lexical, score, id), ())
    }

    fn decoded(event: &NewEvent, sequence: i64) -> session_event::PublicDurableEvent {
        let envelope = parse_json(&format!(
            r#"{{"id":"evt_a","created":1,"type":"{}","durable":{{"aggregateID":"ses_a","seq":{sequence},"version":1}},"data":{}}}"#,
            event.type_.as_str().unwrap().trim_end_matches(".1"),
            ycoding_schema::stringify_json(&event.data)
        ))
        .unwrap();
        session_event::PublicDurableEvent::decode(&envelope).unwrap()
    }

    #[test]
    fn explicit_precedes_cue_precedes_ranked_and_ranks_restart_per_method() {
        let mut items = vec![
            ranked("bm-low", Method::Bm25, 4.0),
            ranked("cue-b", Method::Cue, 1.0),
            ranked("bm-high", Method::Bm25, 9.0),
            ranked("explicit", Method::Explicit, 1.0),
            ranked("cue-a", Method::Cue, 1.0),
        ];
        order(&mut items);
        let ids = items.iter().map(|(c, _)| c.id.as_str()).collect::<Vec<_>>();
        assert_eq!(ids, ["explicit", "cue-a", "cue-b", "bm-high", "bm-low"]);
        let ranks = items
            .iter()
            .map(|(c, _)| c.score(c.method).unwrap().rank)
            .collect::<Vec<_>>();
        assert_eq!(ranks, [0, 0, 1, 0, 1]);
    }

    #[test]
    fn recorded_event_decodes_and_is_keyed_by_input_identity() {
        let session = session::Id::new("ses_a").unwrap();
        let build = |identity: &str| {
            let mut items = vec![ranked("alpha", Method::Bm25, 5.0)];
            order(&mut items);
            let source = source("alpha", "alpha");
            let item = item(&items[0].0, source, None, 12);
            recorded(
                Recording {
                    session: &session,
                    identity,
                    trigger: recall::Trigger::Prompt,
                    cue: None,
                    items: injected(vec![item]),
                    elapsed_ms: 3,
                    budget: Some(2048),
                },
                1,
            )
            .unwrap()
        };
        let (first, event) = build("input-1");
        assert_eq!(first, build("input-1").0);
        assert_ne!(first, build("input-2").0);
        decoded(&event, 1);
        let data = ycoding_schema::stringify_json(&event.data);
        assert!(data.contains(r#""outcome":"injected""#));
        assert!(data.contains(r#""injectedTokens":12"#));
        assert!(data.contains(r#""method":"bm25""#));
    }

    #[test]
    fn rejected_only_records_abstain_with_the_reason() {
        let session = session::Id::new("ses_a").unwrap();
        let mut items = vec![ranked("alpha", Method::Bm25, 5.0)];
        order(&mut items);
        let rejected = item(
            &items[0].0,
            source("alpha", "alpha"),
            Some(recall::Rejection::OverBudget),
            40,
        );
        let (_, event) = recorded(
            Recording {
                session: &session,
                identity: "input-1",
                trigger: recall::Trigger::Prompt,
                cue: None,
                items: vec![rejected],
                elapsed_ms: 0,
                budget: Some(8),
            },
            1,
        )
        .unwrap();
        decoded(&event, 1);
        let data = ycoding_schema::stringify_json(&event.data);
        assert!(data.contains(r#""outcome":"abstained""#));
        assert!(data.contains(r#""abstention":"out_of_budget""#));
        assert!(data.contains(r#""injectedTokens":0"#));
    }

    #[test]
    fn cue_detection_event_decodes_with_stable_id_and_bounded_subject() {
        let session = session::Id::new("ses_a").unwrap();
        let long = "x".repeat(2000);
        let cue = Cue {
            session: &session,
            kind: recall::CueKind::Command,
            subject: Some(&long),
            message: None,
            identity: "input-1",
        };
        let (id, event) = detected(&cue, 1).unwrap();
        assert_eq!(id, cue_id(&cue));
        decoded(&event, 1);
    }

    #[test]
    fn trigger_prefers_explicit_then_lifecycle_then_cue() {
        let mut trace = Trace::new();
        assert_eq!(trace.trigger(), recall::Trigger::Prompt);
        trace.cue(recall::CueKind::Path, Some("a".into()));
        assert_eq!(trace.trigger(), recall::Trigger::Cue);
        trace.cue(recall::CueKind::Compaction, None);
        assert_eq!(trace.trigger(), recall::Trigger::Compaction);
        trace.cue(recall::CueKind::Explicit, Some("s".into()));
        assert_eq!(trace.trigger(), recall::Trigger::Explicit);
    }
}
