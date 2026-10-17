use std::{
    ops::Bound,
    path::PathBuf,
    sync::{Arc, Mutex},
};
use ycoding_core::session::{
    autonomy,
    pending::Request,
    revert,
    review::{
        ChildAnswer, Claim, Conflict, DecideInput, Delivery, DeliveryError, DeliveryFuture, Error,
        FingerprintInput, GrantKind, OpenInput, RecoveryResolution, Service, WithdrawReason,
        fingerprint, prompt_id,
    },
    review_fold, store,
};
use ycoding_schema::{
    DomainDecode, DomainEncode, JsonValue, LosslessString, ObjectEncoder, guardrail, model,
    parse_json, session, session_message,
    session_orchestration::QuestionId,
    session_pending,
    session_review::{self, Decision, Fingerprint, Item, Kind, Origin, Payload, Reason},
    stringify_json,
};
use ycoding_store::{
    Catalog, Error as StoreError, IndexOrder, IndexQuery, KeyPart, Metadata, Options, Store,
    TableDeclaration, analytics, project,
    session::{
        self as tables, Document, Event, EventTable, MessageTable, NewEvent, PendingTable,
        SessionTable, Task, TaskTable,
    },
    tuple_key,
};

const CATALOG: Catalog = Catalog::new(
    1,
    &[
        TableDeclaration::of::<project::ProjectTable>(),
        TableDeclaration::of::<project::WorkspaceTable>(),
        TableDeclaration::of::<project::PermissionTable>(),
        TableDeclaration::of::<tables::SequenceTable>(),
        TableDeclaration::of::<tables::EventTable>(),
        TableDeclaration::of::<tables::SessionTable>(),
        TableDeclaration::of::<tables::MessageTable>(),
        TableDeclaration::of::<tables::TodoTable>(),
        TableDeclaration::of::<tables::TodoStateTable>(),
        TableDeclaration::of::<tables::PendingTable>(),
        TableDeclaration::of::<tables::TaskTable>(),
        TableDeclaration::of::<tables::NotificationTable>(),
        TableDeclaration::of::<tables::RevisionTable>(),
        TableDeclaration::of::<tables::ContextStateTable>(),
        TableDeclaration::of::<tables::InstructionEntryTable>(),
        TableDeclaration::of::<tables::InstructionBlobTable>(),
        TableDeclaration::of::<tables::InstructionStateTable>(),
        TableDeclaration::of::<ycoding_store::resources::CredentialTable>(),
        TableDeclaration::of::<ycoding_store::resources::ConsentTable>(),
        TableDeclaration::of::<ycoding_store::resources::RequestTable>(),
        TableDeclaration::of::<ycoding_store::resources::UsageAnalyticsRequestTable>(),
        TableDeclaration::of::<ycoding_store::resources::SequenceTable>(),
        TableDeclaration::of::<tables::FileChangeTable>(),
        TableDeclaration::of::<ycoding_store::resources::UsageTable>(),
        TableDeclaration::of::<ycoding_store::resources::ContinuationGenerationTable>(),
        TableDeclaration::of::<ycoding_store::resources::ContinuationTable>(),
        TableDeclaration::of::<ycoding_store::resources::StateBlobTable>(),
        TableDeclaration::of::<ycoding_store::resources::StateLinkTable>(),
        TableDeclaration::of::<tables::ManifestTable>(),
        TableDeclaration::of::<tables::JobTable>(),
        TableDeclaration::of::<tables::ExclusionTable>(),
        TableDeclaration::of::<analytics::DeliveryTable>(),
        TableDeclaration::of::<analytics::IntentTable>(),
    ],
);

const ROOT: &str = "ses_root";
const CHILD: &str = "ses_child";
const GRANDCHILD: &str = "ses_grandchild";
const OTHER: &str = "ses_other";
const FORM: &str =
    r#"{"type":"form","title":"Plan","fields":[{"key":"plan","type":"string","required":true}]}"#;
const QUESTIONS: &str = r#"{"type":"question","questions":[{"header":"Plan","question":"Which plan?","options":[]},{"header":"Scope","question":"Which scope?","options":[]}]}"#;
const SUBAGENT: &str = r#"{"type":"subagent_question","text":"Need literal evidence"}"#;
const RECOVERY: &str =
    r#"{"type":"recovery","tools":[{"messageID":"msg_tool","callID":"call_edit","name":"edit"}]}"#;
const REQUEST: &str = r#"{"requestID":"frm_plan"}"#;

fn record(id: &str, parent: Option<&str>) -> tables::Session {
    tables::Session {
        id: id.into(),
        project_id: "prj_one".into(),
        workspace_id: None,
        parent_id: parent.map(Into::into),
        fork_session_id: None,
        fork_message_id: None,
        fork_seq: None,
        directory: "/project".into(),
        path: None,
        title: format!("Title {id}").into(),
        cost: 0.0,
        tokens_input: 0,
        tokens_output: 0,
        tokens_reasoning: 0,
        tokens_cache_read: 0,
        tokens_cache_write: 0,
        revert: None,
        permission: None,
        autonomy: None,
        autonomy_revision: 0,
        orchestration_revision: 0,
        agent: None,
        model: None,
        profile_binding: None,
        daybreak: None,
        time_created: 1,
        time_updated: 1,
        time_archived: None,
        time_active: None,
        time_pinned: None,
        time_suspended: None,
        usage_pruned_through: None,
    }
}

fn seed(store: &Store) {
    store
        .submit(|tx| {
            project::ProjectTable::insert(
                tx,
                &project::Project {
                    id: "prj_one".into(),
                    worktree: "/project".into(),
                    vcs: None,
                    name: None,
                    icon_url: None,
                    icon_url_override: None,
                    icon_color: None,
                    time_created: 1,
                    time_updated: 1,
                    time_initialized: None,
                    sandboxes: vec![],
                    commands: None,
                },
            )?;
            SessionTable::insert(tx, &record(ROOT, None))?;
            SessionTable::insert(tx, &record(CHILD, Some(ROOT)))?;
            SessionTable::insert(tx, &record(GRANDCHILD, Some(CHILD)))?;
            SessionTable::insert(tx, &record(OTHER, None))
        })
        .unwrap()
        .wait()
        .unwrap();
}

fn disposable() -> Store {
    let store = Store::disposable(Options::core(), CATALOG, Metadata::new([7; 16], 1)).unwrap();
    seed(&store);
    store
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum Mode {
    Commit,
    Refuse,
    WithdrawFirst,
}

struct Recorder {
    client: ycoding_store::Client,
    mode: Mutex<Mode>,
    answers: Mutex<Vec<ChildAnswer>>,
    recoveries: Mutex<Vec<RecoveryResolution>>,
    woken: Mutex<Vec<session::Id>>,
}

impl Recorder {
    fn new(store: &Store) -> Arc<Self> {
        Arc::new(Self {
            client: store.client(),
            mode: Mutex::new(Mode::Commit),
            answers: Mutex::default(),
            recoveries: Mutex::default(),
            woken: Mutex::default(),
        })
    }

    fn set(&self, mode: Mode) {
        *self.mode.lock().unwrap() = mode;
    }

    async fn settle(&self, claim: Claim) -> Result<(), DeliveryError> {
        let mode = *self.mode.lock().unwrap();
        if mode == Mode::Refuse {
            return Err(DeliveryError::Conflict("Question is not open".into()));
        }
        if mode == Mode::WithdrawFirst {
            let session = claim.session_id().as_lossless().clone();
            let item = claim.item_id().clone();
            self.client
                .submit(move |tx| {
                    raw(
                        tx,
                        &session,
                        "evt_withdraw_first",
                        "session.review.withdrawn.1",
                        ObjectEncoder::new()
                            .field("sessionID", &session)
                            .field("itemID", &item)
                            .field("reason", "task_closed")
                            .finish(),
                    )
                })
                .map_err(DeliveryError::Store)?
                .await
                .map_err(DeliveryError::Store)?;
        }
        self.client
            .submit(move |tx| claim.commit(tx, 40))
            .map_err(DeliveryError::Store)?
            .await
            .map_err(DeliveryError::Store)?;
        Ok(())
    }
}

impl Delivery for Recorder {
    fn wake(&self, session_id: &session::Id) {
        self.woken.lock().unwrap().push(session_id.clone());
    }

    fn answer_child<'a>(&'a self, answer: ChildAnswer) -> DeliveryFuture<'a> {
        Box::pin(async move {
            let claim = answer.claim.clone();
            self.settle(claim).await?;
            self.answers.lock().unwrap().push(answer);
            Ok(())
        })
    }

    fn resolve_recovery<'a>(&'a self, resolution: RecoveryResolution) -> DeliveryFuture<'a> {
        Box::pin(async move {
            let claim = resolution.claim.clone();
            self.settle(claim).await?;
            self.recoveries.lock().unwrap().push(resolution);
            Ok(())
        })
    }
}

struct Fixture {
    store: Store,
    sessions: store::Service,
    delivery: Arc<Recorder>,
    reviews: Service,
}

fn fixture() -> Fixture {
    with_store(disposable())
}

fn with_store(store: Store) -> Fixture {
    let sessions = store::Service::new(store.client());
    let delivery = Recorder::new(&store);
    let reviews = Service::new(sessions.clone(), delivery.clone());
    Fixture {
        store,
        sessions,
        delivery,
        reviews,
    }
}

fn id(value: &str) -> session::Id {
    session::Id::new(value).unwrap()
}

fn json(text: &str) -> JsonValue {
    parse_json(text).unwrap()
}

fn decode<T: DomainDecode>(text: &str) -> T {
    T::decode(&json(text)).unwrap()
}

fn literal<T: DomainDecode>(text: &str) -> T {
    T::decode(&JsonValue::String(text.into())).unwrap()
}

fn text(value: &LosslessString) -> String {
    value.to_utf8().unwrap()
}

fn field<'a>(value: &'a JsonValue, key: &str) -> Option<&'a JsonValue> {
    match value {
        JsonValue::Object(object) => object.get(&key.into()),
        _ => None,
    }
}

fn string(value: Option<&JsonValue>) -> String {
    match value {
        Some(JsonValue::String(text)) => text.to_utf8().unwrap(),
        other => panic!("expected string, got {other:?}"),
    }
}

fn digest(byte: char) -> Fingerprint {
    literal(&byte.to_string().repeat(64))
}

fn open(session: &str, kind: &str, reason: &str, origin: &str, payload: &str) -> OpenInput {
    OpenInput {
        session_id: id(session),
        kind: literal(kind),
        reason: literal(reason),
        choice: None,
        confidence: None,
        grades: None,
        origin: decode(origin),
        payload: decode(payload),
        limit: 16,
        conversion: false,
        created: 10,
    }
}

fn form(session: &str) -> OpenInput {
    open(session, "question", "free_text", REQUEST, FORM)
}

fn guardrail_payload(hard: bool, directories: &[&str], grant: &Fingerprint) -> String {
    format!(
        r#"{{"type":"guardrail","action":"shell","resources":["git reset --hard"],"ruleIDs":["review"],"reason":"Review","hardReview":{hard},"directories":{},"fingerprint":"{}","requestID":"grq_review"}}"#,
        stringify_json(&JsonValue::Array(
            directories
                .iter()
                .map(|value| JsonValue::String((*value).into()))
                .collect()
        )),
        text(grant.as_lossless())
    )
}

fn permission_payload(save: bool, grant: &Fingerprint) -> String {
    format!(
        r#"{{"type":"permission","action":"edit","resources":["file"],{}"fingerprint":"{}","requestID":"per_review"}}"#,
        if save { r#""save":["file"],"# } else { "" },
        text(grant.as_lossless())
    )
}

fn guardrail(session: &str, hard: bool, directories: &[&str], grant: &Fingerprint) -> OpenInput {
    open(
        session,
        "guardrail",
        "sleep_entry",
        r#"{"requestID":"grq_review"}"#,
        &guardrail_payload(hard, directories, grant),
    )
}

fn permission(session: &str, save: bool, grant: &Fingerprint) -> OpenInput {
    open(
        session,
        "permission",
        "sleep_entry",
        r#"{"requestID":"per_review"}"#,
        &permission_payload(save, grant),
    )
}

fn decision(session: &str, item: &Item, value: &str) -> DecideInput {
    DecideInput {
        session_id: id(session),
        item_id: item.deferral.item_id.clone(),
        decision: decode::<Decision>(value),
        now: 20,
    }
}

fn ids(items: &[Item]) -> Vec<session_review::Id> {
    items
        .iter()
        .map(|item| item.deferral.item_id.clone())
        .collect()
}

fn raw(
    tx: &mut ycoding_store::Write<'_>,
    aggregate: &LosslessString,
    event_id: &str,
    type_: &str,
    data: JsonValue,
) -> Result<(), StoreError> {
    tables::append(
        tx,
        &NewEvent {
            id: event_id.into(),
            aggregate_id: aggregate.clone(),
            created: 30,
            type_: type_.into(),
            data,
        },
        None,
    )
    .map(|_| ())
}

fn events(store: &Store, session: &str, type_: &str) -> Vec<Event> {
    let snapshot = store.snapshot().unwrap();
    let prefix = tuple_key(&[
        KeyPart::String(&session.into()),
        KeyPart::String(&type_.into()),
    ]);
    let mut after = None;
    let mut found = Vec::new();
    loop {
        let page = snapshot
            .index_range::<EventTable>(
                "event_aggregate_type_seq_idx",
                IndexQuery {
                    lower: Bound::Unbounded,
                    upper: Bound::Unbounded,
                    prefix: Some(&prefix),
                    order: IndexOrder::Ascending,
                    after: after.as_ref(),
                    limit: 128,
                },
            )
            .unwrap();
        let Some(last) = page.last() else {
            return found;
        };
        after = Some(last.cursor.clone());
        found.extend(page.into_iter().map(|entry| entry.record));
    }
}

fn pending(store: &Store, item: &session_review::Id) -> Option<tables::Pending> {
    store
        .snapshot()
        .unwrap()
        .get::<PendingTable>(&tuple_key(&[KeyPart::String(
            prompt_id(item).as_lossless(),
        )]))
        .unwrap()
}

fn prompt_text(store: &Store, item: &session_review::Id) -> String {
    string(field(
        &pending(store, item).expect("admitted decision").data,
        "text",
    ))
}

fn system_texts(store: &Store, session: &str) -> Vec<String> {
    let prefix = tuple_key(&[KeyPart::String(&session.into())]);
    store
        .snapshot()
        .unwrap()
        .index_range::<MessageTable>(
            "session_message_session_seq_idx",
            IndexQuery {
                lower: Bound::Unbounded,
                upper: Bound::Unbounded,
                prefix: Some(&prefix),
                order: IndexOrder::Ascending,
                after: None,
                limit: 1024,
            },
        )
        .unwrap()
        .into_iter()
        .filter_map(|entry| match entry.record.info().unwrap() {
            session_message::Info::System(system) => Some(text(&system.text)),
            _ => None,
        })
        .collect()
}

fn update_session(store: &Store, session: &'static str, change: fn(&mut tables::Session)) {
    store
        .submit(move |tx| {
            let mut row = tx
                .get::<SessionTable>(&tuple_key(&[KeyPart::String(&session.into())]))?
                .unwrap();
            change(&mut row);
            SessionTable::put(tx, &row)
        })
        .unwrap()
        .wait()
        .unwrap();
}

fn task(
    store: &Store,
    child: &'static str,
    parent: &'static str,
    state: &'static str,
    question: Option<&'static str>,
) {
    store
        .submit(move |tx| {
            TaskTable::put(
                tx,
                &Task {
                    session_id: child.into(),
                    parent_id: parent.into(),
                    parent_assistant_message_id: format!("msg_parent_{child}").into(),
                    tool_call_id: format!("call_{child}").into(),
                    input_id: format!("msg_input_{child}").into(),
                    description: "Review child".into(),
                    agent: "build".into(),
                    model: Document::from_domain(
                        &model::Ref::decode(
                            &parse_json(r#"{"id":"model","providerID":"test"}"#).unwrap(),
                        )
                        .unwrap(),
                    )?,
                    prompt_digest: "digest".into(),
                    background: 1,
                    delivery: "steer".into(),
                    state: state.into(),
                    progress: None,
                    progress_time: None,
                    question_id: question.map(Into::into),
                    question: question.map(|_| "Need literal evidence".into()),
                    question_data: None,
                    question_time: question.map(|_| 5),
                    attempt_started: 0,
                    owner_pid: None,
                    owner_started: None,
                    revision: 1,
                    time_created: 1,
                    time_updated: 1,
                    usage_anchor: None,
                },
            )
        })
        .unwrap()
        .wait()
        .unwrap();
}

fn conflict(error: Error) -> Conflict {
    match error {
        Error::Conflict { reason, .. } => reason,
        other => panic!("expected conflict, got {other:?}"),
    }
}

fn changed(error: &StoreError) -> bool {
    matches!(
        error,
        StoreError::Domain {
            kind: "review_changed",
            ..
        }
    )
}

fn user_request(session: &str, message: &str, created: i64) -> Request {
    Request {
        id: session_message::Id::new(message).unwrap(),
        session_id: id(session),
        input: session_pending::Message::decode(
            &ObjectEncoder::new()
                .field("type", "user")
                .field(
                    "data",
                    &ObjectEncoder::new().field("text", message).finish(),
                )
                .field("delivery", "steer")
                .finish(),
        )
        .unwrap(),
        event_id: ycoding_schema::event::Id::new(format!("evt_{message}")).unwrap(),
        created,
    }
}

struct Idle;
impl revert::Runs for Idle {
    fn active(&self) -> Vec<session::Id> {
        Vec::new()
    }
    fn wake(&self, _: &session::Id) -> Result<(), String> {
        Ok(())
    }
}

fn temporary(name: &str) -> PathBuf {
    let directory = std::env::temp_dir().join(format!(
        "ycoding-review-{name}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&directory).unwrap();
    directory
}

#[test]
fn fingerprints_and_prompt_identities_match_the_frozen_digests() {
    assert_eq!(
        text(
            fingerprint(&FingerprintInput {
                action: "edit".into(),
                resources: vec!["file".into()],
                workdir: "/project".into(),
                rule_ids: vec![],
                hard_review: false,
                metadata: None,
            })
            .as_lossless()
        ),
        "55260cf81213b5f1e12311ca43b6c747f4f1ee653ea37e5efd12d1e410703bae"
    );
    let ordered = |rule_ids: [&str; 4], metadata: &str| {
        fingerprint(&FingerprintInput {
            action: "shell".into(),
            resources: vec!["git reset --hard".into(), "b".into()],
            workdir: "/project".into(),
            rule_ids: rule_ids.into_iter().map(Into::into).collect(),
            hard_review: true,
            metadata: match json(metadata) {
                JsonValue::Object(object) => Some(object),
                _ => unreachable!(),
            },
        })
    };
    let expected = "234a517b664d5f73c431b2d30e374e00bee659ebf7bbc467a95fc647ab535b6f";
    let first = ordered(
        ["\u{10000}", "\u{E000}", "b", "a"],
        r#"{"\uE000":1.5,"\uD800\uDC00":[1,"x"],"z":{"b":true,"a":null}}"#,
    );
    let second = ordered(
        ["a", "b", "\u{E000}", "\u{10000}"],
        r#"{"z":{"a":null,"b":true},"\uD800\uDC00":[1,"x"],"\uE000":1.5}"#,
    );
    assert_eq!(text(first.as_lossless()), expected);
    assert_eq!(first, second);
    assert_ne!(
        ordered(
            ["a", "b", "\u{E000}", "\u{10000}"],
            r#"{"z":{"a":null,"b":false}}"#
        ),
        first
    );
    assert_eq!(
        text(prompt_id(&session_review::Id::new("rvw_vector").unwrap()).as_lossless()),
        "msg_review_e6364d1cc30270d18818d296"
    );
}

#[tokio::test]
async fn open_items_list_across_the_family_with_derived_attribution() {
    let f = fixture();
    task(&f.store, CHILD, ROOT, "running", None);
    let mut graded = form(ROOT);
    graded.choice = Some("escalate".into());
    graded.confidence = Some(decode::<guardrail::Confidence>("0.6"));
    graded.grades = Some(decode(
        r#"[{"choice":"approve","confidence":0.6,"evidence":"Scoped"},{"choice":"escalate","confidence":0.7,"evidence":"Unclear"}]"#,
    ));
    let first = f.reviews.open(graded).await.unwrap();
    let mut later = form(CHILD);
    later.created = 12;
    let second = f.reviews.open(later).await.unwrap();
    let third = f.reviews.open(form(GRANDCHILD)).await.unwrap();
    f.reviews.open(form(OTHER)).await.unwrap();

    let listed = f.reviews.list(&id(GRANDCHILD)).unwrap();
    assert_eq!(
        ids(&listed),
        ids(&[first.clone(), second.clone(), third.clone()])
    );
    for (item, owner) in listed.iter().zip([ROOT, CHILD, GRANDCHILD]) {
        assert_eq!(text(item.session_id.as_lossless()), owner);
        assert_eq!(text(item.root_session_id.as_lossless()), ROOT);
        assert_eq!(text(&item.session_title), format!("Title {owner}"));
    }
    assert_eq!(
        listed[0].deferral.choice.as_ref().map(text).as_deref(),
        Some("escalate")
    );
    assert_eq!(listed[0].deferral.confidence, first.deferral.confidence);
    assert_eq!(listed[0].deferral.grades.as_ref().map(Vec::len), Some(2));
    assert_eq!(listed[1].created.get(), 12);
    let child = listed[1].child.as_ref().expect("managed child attribution");
    assert_eq!(text(&child.description), "Review child");
    assert!(listed[0].child.is_none() && listed[2].child.is_none());

    let deferred = events(&f.store, CHILD, "session.review.deferred.1");
    assert_eq!(deferred.len(), 1);
    assert_eq!(deferred[0].created, 12);
    for derived in ["rootSessionID", "sessionTitle", "created", "child"] {
        assert!(field(&deferred[0].data, derived).is_none(), "{derived}");
    }
    update_session(&f.store, CHILD, |row| row.title = "Renamed".into());
    assert_eq!(
        text(&f.reviews.list(&id(ROOT)).unwrap()[1].session_title),
        "Renamed"
    );

    assert!(f.reviews.has_open(&id(GRANDCHILD)).unwrap());
    assert!(matches!(
        f.reviews.list(&id("ses_missing")),
        Err(Error::SessionNotFound(_))
    ));
}

#[tokio::test]
async fn open_rejects_a_payload_that_does_not_match_its_kind_without_recording() {
    let f = fixture();
    let error = f
        .reviews
        .open(open(ROOT, "guardrail", "escalated", REQUEST, FORM))
        .await
        .unwrap_err();
    assert!(matches!(error, Error::InvalidDeferral(_)), "{error:?}");
    assert!(events(&f.store, ROOT, "session.review.deferred.1").is_empty());
    assert!(matches!(
        f.reviews.open(form("ses_missing")).await,
        Err(Error::SessionNotFound(_))
    ));
}

#[tokio::test]
async fn the_family_cap_counts_every_member_and_exempts_sleep_entry_conversions() {
    let f = fixture();
    let mut capped = form(ROOT);
    capped.limit = 1;
    f.reviews.open(capped.clone()).await.unwrap();
    let mut child = form(GRANDCHILD);
    child.limit = 1;
    let error = f.reviews.open(child.clone()).await.unwrap_err();
    assert!(matches!(error, Error::Full { limit: 1, .. }), "{error:?}");
    assert!(events(&f.store, GRANDCHILD, "session.review.deferred.1").is_empty());
    child.conversion = true;
    f.reviews.open(child).await.unwrap();
    assert_eq!(f.reviews.list(&id(ROOT)).unwrap().len(), 2);
    let mut other = form(OTHER);
    other.limit = 1;
    f.reviews.open(other).await.unwrap();
}

#[tokio::test]
async fn concurrent_opens_cannot_exceed_the_family_cap() {
    let f = fixture();
    let mut first = form(ROOT);
    first.limit = 1;
    let mut second = form(CHILD);
    second.limit = 1;
    let (left, right) = tokio::join!(f.reviews.open(first), f.reviews.open(second));
    assert_eq!(
        [left.is_ok(), right.is_ok()]
            .into_iter()
            .filter(|ok| *ok)
            .count(),
        1
    );
    assert!(matches!(
        left.err().or(right.err()),
        Some(Error::Full { limit: 1, .. })
    ));
    assert_eq!(f.reviews.list(&id(ROOT)).unwrap().len(), 1);
}

#[tokio::test]
async fn a_form_decision_is_admitted_once_as_a_review_steer_without_waking_the_family() {
    let f = fixture();
    let autonomy = autonomy::Service::new(f.store.client());
    autonomy.set_sleep(&id(ROOT), true).await.unwrap();
    let item = f.reviews.open(form(CHILD)).await.unwrap();
    f.reviews
        .decide(decision(
            ROOT,
            &item,
            r#"{"kind":"question","answers":{"plan":"A"}}"#,
        ))
        .await
        .unwrap();

    let admitted = pending(&f.store, &item.deferral.item_id).expect("admitted decision");
    assert_eq!(text(&admitted.session_id), CHILD);
    assert_eq!(admitted.type_.as_str(), Some("user"));
    assert_eq!(
        admitted.delivery.as_ref().and_then(|value| value.as_str()),
        Some("steer")
    );
    assert_eq!(
        string(field(&admitted.data, "text")),
        format!(
            r#"The user answered deferred form {} "Plan": {{"plan":"A"}}. Continue with the work that depended on it."#,
            text(item.deferral.item_id.as_lossless())
        )
    );
    let review = field(field(&admitted.data, "metadata").unwrap(), "review").unwrap();
    assert_eq!(
        string(field(review, "itemID")),
        text(item.deferral.item_id.as_lossless())
    );
    assert_eq!(string(field(review, "kind")), "question");
    assert_eq!(events(&f.store, CHILD, "session.review.decided.1").len(), 1);
    assert_eq!(events(&f.store, CHILD, "session.input.admitted.1").len(), 1);
    assert!(autonomy.get(&id(ROOT)).unwrap().is_asleep());
    assert_eq!(*f.delivery.woken.lock().unwrap(), vec![id(CHILD)]);
    assert!(f.reviews.list(&id(ROOT)).unwrap().is_empty());
    assert!(!f.reviews.has_open(&id(ROOT)).unwrap());

    for repeated in [
        r#"{"kind":"question","answers":{"plan":"A"}}"#,
        r#"{"kind":"question","answers":{"plan":"B"}}"#,
    ] {
        let error = f
            .reviews
            .decide(decision(ROOT, &item, repeated))
            .await
            .unwrap_err();
        assert_eq!(conflict(error), Conflict::Decided);
    }
    assert_eq!(events(&f.store, CHILD, "session.review.decided.1").len(), 1);
    assert_eq!(events(&f.store, CHILD, "session.input.admitted.1").len(), 1);
}

#[tokio::test]
async fn decisions_validate_kind_answers_and_live_form_rules_before_settlement() {
    let f = fixture();
    let bounded = f
        .reviews
        .open(open(
            ROOT,
            "question",
            "free_text",
            REQUEST,
            r#"{"type":"form","title":"Bounded","fields":[{"key":"count","type":"integer","required":true,"minimum":1,"maximum":3},{"key":"plan","type":"string","required":true,"options":[{"value":"safe","label":"Safe"}],"custom":false},{"key":"detail","type":"string","required":true,"when":[{"key":"count","op":"eq","value":3}]}]}"#,
        ))
        .await
        .unwrap();
    for invalid in [
        r#"{"kind":"guardrail","reply":"once"}"#,
        r#"{"kind":"question","answers":[["A"]]}"#,
        r#"{"kind":"question","answers":{}}"#,
        r#"{"kind":"question","answers":{"count":0,"plan":"safe"}}"#,
        r#"{"kind":"question","answers":{"count":"1","plan":"safe"}}"#,
        r#"{"kind":"question","answers":{"count":1,"plan":"other"}}"#,
        r#"{"kind":"question","answers":{"count":3,"plan":"safe"}}"#,
        r#"{"kind":"question","answers":{"count":1,"plan":"safe","detail":"hidden"}}"#,
        r#"{"kind":"question","answers":{"count":1,"plan":"safe","unknown":true}}"#,
    ] {
        let error = f
            .reviews
            .decide(decision(ROOT, &bounded, invalid))
            .await
            .unwrap_err();
        assert!(
            matches!(error, Error::InvalidDecision { .. }),
            "{invalid}: {error:?}"
        );
        assert_eq!(f.reviews.list(&id(ROOT)).unwrap().len(), 1, "{invalid}");
    }
    assert!(events(&f.store, ROOT, "session.review.decided.1").is_empty());
    assert!(pending(&f.store, &bounded.deferral.item_id).is_none());
    f.reviews
        .decide(decision(
            ROOT,
            &bounded,
            r#"{"kind":"question","answers":{"count":3,"plan":"safe","detail":"literal"}}"#,
        ))
        .await
        .unwrap();

    let questions = f
        .reviews
        .open(open(ROOT, "question", "free_text", REQUEST, QUESTIONS))
        .await
        .unwrap();
    for invalid in [
        r#"{"kind":"question","answers":[["A"]]}"#,
        r#"{"kind":"question","answers":{"plan":"A"}}"#,
    ] {
        assert!(matches!(
            f.reviews.decide(decision(ROOT, &questions, invalid)).await,
            Err(Error::InvalidDecision { .. })
        ));
    }
    f.reviews
        .decide(decision(
            ROOT,
            &questions,
            r#"{"kind":"question","answers":[["/literal input"],["a","b"]]}"#,
        ))
        .await
        .unwrap();
    assert_eq!(
        prompt_text(&f.store, &questions.deferral.item_id),
        format!(
            r#"Decision on deferred questions {} (asked while the user slept): "Which plan?"="/literal input", "Which scope?"="a, b". Continue with the work that depended on it."#,
            text(questions.deferral.item_id.as_lossless())
        )
    );

    let tool = f
        .reviews
        .open(open(
            ROOT,
            "question",
            "free_text",
            REQUEST,
            r#"{"type":"form","title":"Questions","fields":[{"key":"q0","type":"string","description":"Paste the failing input"}],"questionTool":true}"#,
        ))
        .await
        .unwrap();
    f.reviews
        .decide(decision(
            ROOT,
            &tool,
            r#"{"kind":"question","answers":{"q0":"/literal input"}}"#,
        ))
        .await
        .unwrap();
    assert!(
        prompt_text(&f.store, &tool.deferral.item_id)
            .contains(r#""Paste the failing input"="/literal input""#)
    );

    let dismissed = f.reviews.open(form(ROOT)).await.unwrap();
    f.reviews
        .decide(decision(
            ROOT,
            &dismissed,
            r#"{"kind":"question","dismissed":true}"#,
        ))
        .await
        .unwrap();
    assert_eq!(
        prompt_text(&f.store, &dismissed.deferral.item_id),
        format!(
            "The user dismissed deferred question {} without answering; proceed on your own judgment.",
            text(dismissed.deferral.item_id.as_lossless())
        )
    );
}

#[tokio::test]
async fn decisions_resolve_only_within_the_owning_family_and_unarchived_owners() {
    let f = fixture();
    let item = f.reviews.open(form(CHILD)).await.unwrap();
    assert!(matches!(
        f.reviews
            .decide(decision(
                OTHER,
                &item,
                r#"{"kind":"question","dismissed":true}"#
            ))
            .await,
        Err(Error::NotFound(_))
    ));
    assert!(matches!(
        f.reviews
            .decide(decision(
                "ses_missing",
                &item,
                r#"{"kind":"question","dismissed":true}"#
            ))
            .await,
        Err(Error::SessionNotFound(_))
    ));
    update_session(&f.store, CHILD, |row| row.time_archived = Some(5));
    assert!(f.reviews.list(&id(ROOT)).unwrap().is_empty());
    let error = f
        .reviews
        .decide(decision(
            ROOT,
            &item,
            r#"{"kind":"question","dismissed":true}"#,
        ))
        .await
        .unwrap_err();
    assert_eq!(conflict(error), Conflict::Archived);
    update_session(&f.store, CHILD, |row| row.time_archived = None);
    assert_eq!(f.reviews.list(&id(ROOT)).unwrap().len(), 1);
    f.reviews
        .decide(decision(
            ROOT,
            &item,
            r#"{"kind":"question","dismissed":true}"#,
        ))
        .await
        .unwrap();
}

#[tokio::test]
async fn concurrent_decisions_settle_one_item_exactly_once() {
    let f = fixture();
    let item = f.reviews.open(form(ROOT)).await.unwrap();
    let (left, right) = tokio::join!(
        f.reviews.decide(decision(
            ROOT,
            &item,
            r#"{"kind":"question","answers":{"plan":"A"}}"#
        )),
        f.reviews.decide(decision(
            ROOT,
            &item,
            r#"{"kind":"question","answers":{"plan":"B"}}"#
        ))
    );
    assert_eq!(
        [left.is_ok(), right.is_ok()]
            .into_iter()
            .filter(|ok| *ok)
            .count(),
        1
    );
    assert_eq!(
        conflict(left.err().or(right.err()).unwrap()),
        Conflict::Decided
    );
    assert_eq!(events(&f.store, ROOT, "session.review.decided.1").len(), 1);
    assert_eq!(events(&f.store, ROOT, "session.input.admitted.1").len(), 1);
}

#[tokio::test]
async fn guardrail_decisions_grant_once_record_family_directories_and_reject_hard_always() {
    let f = fixture();
    let grant = digest('a');
    let hard = f
        .reviews
        .open(guardrail(CHILD, true, &[], &grant))
        .await
        .unwrap();
    let error = f
        .reviews
        .decide(decision(
            ROOT,
            &hard,
            r#"{"kind":"guardrail","reply":"always"}"#,
        ))
        .await
        .unwrap_err();
    assert!(matches!(error, Error::InvalidDecision { .. }), "{error:?}");
    f.reviews
        .decide(decision(
            ROOT,
            &hard,
            r#"{"kind":"guardrail","reply":"once"}"#,
        ))
        .await
        .unwrap();
    assert_eq!(
        prompt_text(&f.store, &hard.deferral.item_id),
        format!(
            "The user approved deferred guardrail item {} once: shell on git reset --hard. Re-issue exactly that action now if it is still needed; the approval covers one identical request from this Session.",
            text(hard.deferral.item_id.as_lossless())
        )
    );
    assert!(events(&f.store, ROOT, "session.guardrail.approved.1").is_empty());

    let scoped = f
        .reviews
        .open(guardrail(
            CHILD,
            false,
            &["/outside", "/shared"],
            &digest('b'),
        ))
        .await
        .unwrap();
    f.reviews
        .decide(decision(
            ROOT,
            &scoped,
            r#"{"kind":"guardrail","reply":"always"}"#,
        ))
        .await
        .unwrap();
    assert!(
        prompt_text(&f.store, &scoped.deferral.item_id)
            .ends_with(" Directories /outside, /shared are approved for this Session family.")
    );
    let approved = events(&f.store, ROOT, "session.guardrail.approved.1");
    assert_eq!(approved.len(), 1);
    assert_eq!(
        field(&approved[0].data, "directories"),
        Some(&json(r#"["/outside","/shared"]"#))
    );
    assert!(events(&f.store, CHILD, "session.guardrail.approved.1").is_empty());

    let rejected = f
        .reviews
        .open(guardrail(CHILD, false, &[], &digest('c')))
        .await
        .unwrap();
    f.reviews
        .decide(decision(
            ROOT,
            &rejected,
            r#"{"kind":"guardrail","reply":"reject"}"#,
        ))
        .await
        .unwrap();
    assert_eq!(
        prompt_text(&f.store, &rejected.deferral.item_id),
        format!(
            "The user rejected deferred guardrail item {} (shell). Do not retry it; choose another approach or report the blocker to the user.",
            text(rejected.deferral.item_id.as_lossless())
        )
    );
    assert!(
        !f.reviews
            .consume(&id(CHILD), GrantKind::Guardrail, &digest('c'), 30)
            .await
            .unwrap()
    );
}

#[tokio::test]
async fn permission_always_saves_project_rules_in_the_decision_commit() {
    let f = fixture();
    let saved = f
        .reviews
        .open(permission(CHILD, true, &digest('d')))
        .await
        .unwrap();
    f.reviews
        .decide(decision(
            ROOT,
            &saved,
            r#"{"kind":"permission","reply":"always"}"#,
        ))
        .await
        .unwrap();
    let rules = f
        .store
        .snapshot()
        .unwrap()
        .scan::<project::PermissionTable>(Bound::Unbounded, Bound::Unbounded, 16)
        .unwrap();
    assert_eq!(
        rules
            .iter()
            .map(|rule| (
                text(&rule.project_id),
                text(&rule.action),
                text(&rule.resource)
            ))
            .collect::<Vec<_>>(),
        [("prj_one".to_owned(), "edit".to_owned(), "file".to_owned())]
    );
    assert_eq!(
        prompt_text(&f.store, &saved.deferral.item_id),
        format!(
            "The user approved deferred permission item {} always: edit on file. Re-issue exactly that action now if it is still needed; the approval covers one identical request from this Session.",
            text(saved.deferral.item_id.as_lossless())
        )
    );
    let unsaved = f
        .reviews
        .open(permission(CHILD, false, &digest('e')))
        .await
        .unwrap();
    f.reviews
        .decide(decision(
            ROOT,
            &unsaved,
            r#"{"kind":"permission","reply":"once"}"#,
        ))
        .await
        .unwrap();
    assert_eq!(
        f.store
            .snapshot()
            .unwrap()
            .scan::<project::PermissionTable>(Bound::Unbounded, Bound::Unbounded, 16)
            .unwrap()
            .len(),
        1
    );
}

#[tokio::test]
async fn grants_are_exact_session_bound_and_consumed_once() {
    let f = fixture();
    let grant = digest('f');
    let undecided = f
        .reviews
        .open(permission(ROOT, false, &digest('9')))
        .await
        .unwrap();
    assert!(
        !f.reviews
            .consume(&id(ROOT), GrantKind::Permission, &digest('9'), 30)
            .await
            .unwrap()
    );
    let item = f
        .reviews
        .open(permission(ROOT, false, &grant))
        .await
        .unwrap();
    f.reviews
        .decide(decision(
            ROOT,
            &item,
            r#"{"kind":"permission","reply":"once"}"#,
        ))
        .await
        .unwrap();
    assert!(
        !f.reviews
            .consume(&id(CHILD), GrantKind::Permission, &grant, 30)
            .await
            .unwrap()
    );
    assert!(
        !f.reviews
            .consume(&id(ROOT), GrantKind::Guardrail, &grant, 30)
            .await
            .unwrap()
    );
    assert!(
        !f.reviews
            .consume(&id(ROOT), GrantKind::Permission, &digest('0'), 30)
            .await
            .unwrap()
    );
    let session_id = id(ROOT);
    let (left, right) = tokio::join!(
        f.reviews
            .consume(&session_id, GrantKind::Permission, &grant, 30),
        f.reviews
            .consume(&session_id, GrantKind::Permission, &grant, 30)
    );
    assert_eq!(
        [left.unwrap(), right.unwrap()]
            .into_iter()
            .filter(|used| *used)
            .count(),
        1
    );
    assert!(
        !f.reviews
            .consume(&id(ROOT), GrantKind::Permission, &grant, 30)
            .await
            .unwrap()
    );
    let consumed = events(&f.store, ROOT, "session.review.consumed.1");
    assert_eq!(consumed.len(), 1);
    assert_eq!(
        string(field(&consumed[0].data, "itemID")),
        text(item.deferral.item_id.as_lossless())
    );
    let snapshot = f.store.snapshot().unwrap();
    let folded = review_fold::fold(&snapshot, &[ROOT.into()]).unwrap();
    let state = |target: &Item| {
        folded
            .iter()
            .find(|entry| entry.item_id == target.deferral.item_id)
            .map(|entry| (entry.decision.is_some(), entry.consumed))
    };
    assert_eq!(state(&item), Some((true, true)));
    assert_eq!(state(&undecided), Some((false, false)));
}

#[tokio::test]
async fn a_task_close_withdraws_only_that_sessions_open_items_and_projects_notices() {
    let f = fixture();
    let kept = f.reviews.open(form(ROOT)).await.unwrap();
    let removed = f.reviews.open(form(CHILD)).await.unwrap();
    let decided = f
        .reviews
        .open(permission(CHILD, false, &digest('1')))
        .await
        .unwrap();
    f.reviews
        .decide(decision(
            ROOT,
            &decided,
            r#"{"kind":"permission","reply":"once"}"#,
        ))
        .await
        .unwrap();
    assert_eq!(
        f.reviews
            .withdraw(&id(CHILD), WithdrawReason::TaskClosed, 30)
            .await
            .unwrap(),
        1
    );
    assert_eq!(ids(&f.reviews.list(&id(ROOT)).unwrap()), ids(&[kept]));
    let error = f
        .reviews
        .decide(decision(
            ROOT,
            &removed,
            r#"{"kind":"question","dismissed":true}"#,
        ))
        .await
        .unwrap_err();
    assert_eq!(conflict(error), Conflict::Withdrawn);
    assert!(system_texts(&f.store, CHILD).contains(&format!(
        "Review item {} withdrawn: its subagent task closed. Any unused approval from this item is invalid.",
        text(removed.deferral.item_id.as_lossless())
    )));
    assert_eq!(
        f.reviews
            .withdraw(&id(CHILD), WithdrawReason::TaskClosed, 31)
            .await
            .unwrap(),
        0
    );
}

#[tokio::test]
async fn withdrawal_selection_after_a_boundary_is_fenced_against_concurrent_review_changes() {
    let f = fixture();
    for (message, created) in [("msg_first", 2), ("msg_second", 3)] {
        f.sessions
            .admit_input(user_request(ROOT, message, created))
            .await
            .unwrap();
    }
    f.sessions.promote_steers(&id(ROOT), 4).await.unwrap();
    let origin =
        |message: &str, call: &str| format!(r#"{{"messageID":"{message}","callID":"{call}"}}"#);
    let kept = f
        .reviews
        .open(open(
            ROOT,
            "question",
            "free_text",
            &origin("msg_first", "call_a"),
            FORM,
        ))
        .await
        .unwrap();
    let later = f
        .reviews
        .open(open(
            ROOT,
            "question",
            "free_text",
            &origin("msg_second", "call_b"),
            FORM,
        ))
        .await
        .unwrap();
    let boundary = f
        .store
        .snapshot()
        .unwrap()
        .get::<MessageTable>(&tuple_key(&[KeyPart::String(&"msg_first".into())]))
        .unwrap()
        .unwrap()
        .seq;

    let stale =
        review_fold::withdrawals(&f.store.snapshot().unwrap(), &id(ROOT), boundary, false, 30)
            .unwrap();
    assert_eq!(
        stale.item_ids(),
        std::slice::from_ref(&later.deferral.item_id)
    );
    f.reviews
        .decide(decision(
            ROOT,
            &later,
            r#"{"kind":"question","dismissed":true}"#,
        ))
        .await
        .unwrap();
    let error = f
        .store
        .submit(move |tx| stale.append(tx))
        .unwrap()
        .await
        .unwrap_err();
    assert!(changed(&error), "{error:?}");
    assert!(events(&f.store, ROOT, "session.review.withdrawn.1").is_empty());

    let fresh =
        review_fold::withdrawals(&f.store.snapshot().unwrap(), &id(ROOT), boundary, true, 31)
            .unwrap();
    assert_eq!(
        fresh.item_ids(),
        [
            kept.deferral.item_id.clone(),
            later.deferral.item_id.clone()
        ]
    );
    assert_eq!(
        f.store
            .submit(move |tx| fresh.append(tx))
            .unwrap()
            .await
            .unwrap(),
        2
    );
}

#[tokio::test]
async fn withdraw_after_removes_only_later_origins_including_unconsumed_grants() {
    let f = fixture();
    for (message, created) in [("msg_first", 2), ("msg_second", 3)] {
        f.sessions
            .admit_input(user_request(ROOT, message, created))
            .await
            .unwrap();
    }
    f.sessions.promote_steers(&id(ROOT), 4).await.unwrap();
    let origin =
        |message: &str, call: &str| format!(r#"{{"messageID":"{message}","callID":"{call}"}}"#);
    let kept = f
        .reviews
        .open(open(
            ROOT,
            "question",
            "free_text",
            &origin("msg_first", "call_a"),
            FORM,
        ))
        .await
        .unwrap();
    f.reviews
        .open(open(
            ROOT,
            "question",
            "free_text",
            &origin("msg_second", "call_b"),
            FORM,
        ))
        .await
        .unwrap();
    let grant = digest('2');
    let granted = f
        .reviews
        .open(open(
            ROOT,
            "permission",
            "sleep_entry",
            &origin("msg_second", "call_c"),
            &permission_payload(false, &grant),
        ))
        .await
        .unwrap();
    f.reviews
        .decide(decision(
            ROOT,
            &granted,
            r#"{"kind":"permission","reply":"once"}"#,
        ))
        .await
        .unwrap();
    let withdrawn = f
        .reviews
        .withdraw_after(
            &id(ROOT),
            &session_message::Id::new("msg_first").unwrap(),
            30,
        )
        .await
        .unwrap();
    assert_eq!(withdrawn, 2);
    assert_eq!(ids(&f.reviews.list(&id(ROOT)).unwrap()), ids(&[kept]));
    assert!(
        !f.reviews
            .consume(&id(ROOT), GrantKind::Permission, &grant, 31)
            .await
            .unwrap()
    );
}

async fn revert_withdraws(implicit: bool) {
    let f = fixture();
    for (message, created) in [("msg_keep", 2), ("msg_remove", 3)] {
        f.sessions
            .admit_input(user_request(ROOT, message, created))
            .await
            .unwrap();
    }
    f.sessions.promote_steers(&id(ROOT), 4).await.unwrap();
    let origin =
        |message: &str, call: &str| format!(r#"{{"messageID":"{message}","callID":"{call}"}}"#);
    let kept = f
        .reviews
        .open(open(
            ROOT,
            "question",
            "free_text",
            &origin("msg_keep", "kept"),
            FORM,
        ))
        .await
        .unwrap();
    let removed = f
        .reviews
        .open(open(
            ROOT,
            "question",
            "free_text",
            &origin("msg_remove", "removed"),
            FORM,
        ))
        .await
        .unwrap();
    let grant = digest('3');
    let granted = f
        .reviews
        .open(open(
            ROOT,
            "permission",
            "sleep_entry",
            &origin("msg_remove", "grant"),
            &permission_payload(false, &grant),
        ))
        .await
        .unwrap();
    f.reviews
        .decide(decision(
            ROOT,
            &granted,
            r#"{"kind":"permission","reply":"once"}"#,
        ))
        .await
        .unwrap();
    f.sessions
        .publish(NewEvent {
            id: "evt_stage_review".into(),
            aggregate_id: ROOT.into(),
            created: 50,
            type_: "session.revert.staged.1".into(),
            data: json(
                r#"{"sessionID":"ses_root","revert":{"messageID":"msg_remove","files":[]}}"#,
            ),
        })
        .await
        .unwrap();
    if implicit {
        f.sessions
            .admit_input(user_request(ROOT, "msg_replacement", 51))
            .await
            .unwrap();
    } else {
        revert::commit_idle(&f.sessions, &Idle, &id(ROOT), 51)
            .await
            .unwrap();
    }
    assert_eq!(ids(&f.reviews.list(&id(ROOT)).unwrap()), ids(&[kept]));
    assert!(
        !f.reviews
            .consume(&id(ROOT), GrantKind::Permission, &grant, 52)
            .await
            .unwrap()
    );
    let error = f
        .reviews
        .decide(decision(
            ROOT,
            &removed,
            r#"{"kind":"question","dismissed":true}"#,
        ))
        .await
        .unwrap_err();
    assert_eq!(conflict(error), Conflict::Withdrawn);
    let notices = system_texts(&f.store, ROOT);
    for item in [&removed, &granted] {
        assert!(
            notices.contains(&format!(
                "Review item {} withdrawn: its originating message was reverted. Any unused approval from this item is invalid.",
                text(item.deferral.item_id.as_lossless())
            )),
            "{notices:?}"
        );
    }
}

#[tokio::test]
async fn an_explicit_revert_commit_withdraws_reverted_reviews_and_grants_atomically() {
    revert_withdraws(false).await;
}

#[tokio::test]
async fn prompt_admission_reverts_withdraw_reverted_reviews_and_grants_atomically() {
    revert_withdraws(true).await;
}

#[tokio::test]
async fn a_staged_revert_commits_before_a_decision_on_a_reverted_item() {
    let f = fixture();
    f.sessions
        .admit_input(user_request(ROOT, "msg_remove", 2))
        .await
        .unwrap();
    f.sessions.promote_steers(&id(ROOT), 3).await.unwrap();
    let removed = f
        .reviews
        .open(open(
            ROOT,
            "question",
            "free_text",
            r#"{"messageID":"msg_remove","callID":"call_removed"}"#,
            FORM,
        ))
        .await
        .unwrap();
    f.sessions
        .publish(NewEvent {
            id: "evt_stage_decide".into(),
            aggregate_id: ROOT.into(),
            created: 50,
            type_: "session.revert.staged.1".into(),
            data: json(
                r#"{"sessionID":"ses_root","revert":{"messageID":"msg_remove","files":[]}}"#,
            ),
        })
        .await
        .unwrap();
    let error = f
        .reviews
        .decide(decision(
            ROOT,
            &removed,
            r#"{"kind":"question","answers":{"plan":"A"}}"#,
        ))
        .await
        .unwrap_err();
    assert_eq!(conflict(error), Conflict::Withdrawn);
    assert!(pending(&f.store, &removed.deferral.item_id).is_none());
    assert!(events(&f.store, ROOT, "session.review.decided.1").is_empty());
}

#[tokio::test]
async fn child_question_decisions_are_human_only_and_commit_through_the_delivery_claim() {
    let f = fixture();
    task(&f.store, CHILD, ROOT, "waiting", Some("qst_review"));
    let item = f
        .reviews
        .open(open(
            CHILD,
            "subagent_question",
            "sleep_entry",
            r#"{"questionID":"qst_review"}"#,
            SUBAGENT,
        ))
        .await
        .unwrap();
    let question = QuestionId("qst_review".into());
    let snapshot = f.store.snapshot().unwrap();
    assert!(review_fold::owns_question(&snapshot, &id(CHILD), &question).unwrap());
    assert!(
        !review_fold::owns_question(&snapshot, &id(CHILD), &QuestionId("qst_other".into()))
            .unwrap()
    );
    drop(snapshot);

    f.delivery.set(Mode::Refuse);
    for _ in 0..2 {
        let error = f
            .reviews
            .decide(decision(
                ROOT,
                &item,
                r#"{"kind":"subagent_question","text":"Human evidence"}"#,
            ))
            .await
            .unwrap_err();
        assert!(matches!(conflict(error), Conflict::Delivery(_)));
        assert_eq!(
            ids(&f.reviews.list(&id(ROOT)).unwrap()),
            ids(std::slice::from_ref(&item))
        );
    }
    assert!(events(&f.store, CHILD, "session.review.decided.1").is_empty());

    f.delivery.set(Mode::Commit);
    f.reviews
        .decide(decision(
            ROOT,
            &item,
            r#"{"kind":"subagent_question","text":"/literal review answer","data":{"choice":"A"}}"#,
        ))
        .await
        .unwrap();
    {
        let answers = f.delivery.answers.lock().unwrap();
        assert_eq!(answers.len(), 1);
        assert_eq!(answers[0].parent_id, id(ROOT));
        assert_eq!(answers[0].child_id, id(CHILD));
        assert_eq!(answers[0].question_id, question);
        assert_eq!(text(&answers[0].text), "/literal review answer");
        assert_eq!(
            answers[0].data.as_ref().map(DomainEncode::encode),
            Some(json(r#"{"choice":"A"}"#))
        );
        assert_eq!(answers[0].claim.item_id(), &item.deferral.item_id);
    }
    assert_eq!(events(&f.store, CHILD, "session.review.decided.1").len(), 1);
    assert!(pending(&f.store, &item.deferral.item_id).is_none());
    assert!(f.reviews.list(&id(ROOT)).unwrap().is_empty());
    let error = f
        .reviews
        .decide(decision(
            ROOT,
            &item,
            r#"{"kind":"subagent_question","text":"Again"}"#,
        ))
        .await
        .unwrap_err();
    assert_eq!(conflict(error), Conflict::Decided);
    assert_eq!(f.delivery.answers.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn a_dismissed_child_question_answers_with_the_dismissal_and_no_data() {
    let f = fixture();
    task(&f.store, CHILD, ROOT, "waiting", Some("qst_review"));
    let item = f
        .reviews
        .open(open(
            CHILD,
            "subagent_question",
            "sleep_entry",
            r#"{"questionID":"qst_review"}"#,
            SUBAGENT,
        ))
        .await
        .unwrap();
    f.reviews
        .decide(decision(
            ROOT,
            &item,
            r#"{"kind":"subagent_question","dismissed":true}"#,
        ))
        .await
        .unwrap();
    let answers = f.delivery.answers.lock().unwrap();
    assert_eq!(
        text(&answers[0].text),
        format!(
            "The user dismissed deferred question {} without answering; proceed on your own judgment.",
            text(item.deferral.item_id.as_lossless())
        )
    );
    assert!(answers[0].data.is_none());
}

#[tokio::test]
async fn a_claim_rejects_commit_after_a_concurrent_review_change() {
    let f = fixture();
    task(&f.store, CHILD, ROOT, "waiting", Some("qst_review"));
    let item = f
        .reviews
        .open(open(
            CHILD,
            "subagent_question",
            "sleep_entry",
            r#"{"questionID":"qst_review"}"#,
            SUBAGENT,
        ))
        .await
        .unwrap();
    f.delivery.set(Mode::WithdrawFirst);
    let error = f
        .reviews
        .decide(decision(
            ROOT,
            &item,
            r#"{"kind":"subagent_question","text":"Late"}"#,
        ))
        .await
        .unwrap_err();
    assert_eq!(conflict(error), Conflict::Withdrawn);
    assert!(events(&f.store, CHILD, "session.review.decided.1").is_empty());
    assert!(f.delivery.answers.lock().unwrap().is_empty());
}

#[tokio::test]
async fn a_stopped_restart_recovery_accepts_exactly_one_later_continue() {
    let f = fixture();
    task(&f.store, CHILD, ROOT, "waiting", Some("qst_recovery"));
    let item = f
        .reviews
        .open(open(
            CHILD,
            "recovery",
            "restart",
            r#"{"questionID":"qst_recovery"}"#,
            RECOVERY,
        ))
        .await
        .unwrap();
    assert!(
        review_fold::owns_question(
            &f.store.snapshot().unwrap(),
            &id(CHILD),
            &QuestionId("qst_recovery".into())
        )
        .unwrap()
    );
    f.reviews
        .decide(decision(
            ROOT,
            &item,
            r#"{"kind":"recovery","choice":"stop"}"#,
        ))
        .await
        .unwrap();
    assert!(f.reviews.list(&id(ROOT)).unwrap().is_empty());
    assert_eq!(
        review_fold::stopped_recovery(&f.store.snapshot().unwrap(), &id(CHILD)).unwrap(),
        Some(item.deferral.item_id.clone())
    );
    let error = f
        .reviews
        .decide(decision(
            ROOT,
            &item,
            r#"{"kind":"recovery","choice":"stop"}"#,
        ))
        .await
        .unwrap_err();
    assert_eq!(conflict(error), Conflict::Decided);
    f.reviews
        .decide(decision(
            ROOT,
            &item,
            r#"{"kind":"recovery","choice":"continue"}"#,
        ))
        .await
        .unwrap();
    assert_eq!(
        review_fold::stopped_recovery(&f.store.snapshot().unwrap(), &id(CHILD)).unwrap(),
        None
    );
    let error = f
        .reviews
        .decide(decision(
            ROOT,
            &item,
            r#"{"kind":"recovery","choice":"continue"}"#,
        ))
        .await
        .unwrap_err();
    assert_eq!(conflict(error), Conflict::Decided);
    let recoveries = f.delivery.recoveries.lock().unwrap();
    assert_eq!(
        recoveries
            .iter()
            .map(|entry| entry.choice.as_str())
            .collect::<Vec<_>>(),
        ["stop", "continue"]
    );
    assert_eq!(events(&f.store, CHILD, "session.review.decided.1").len(), 2);
    assert!(pending(&f.store, &item.deferral.item_id).is_none());
}

#[tokio::test]
async fn reconciliation_delivers_a_persisted_decision_once() {
    let f = fixture();
    let item = f.reviews.open(form(ROOT)).await.unwrap();
    let data = ObjectEncoder::new()
        .field("sessionID", ROOT)
        .field("itemID", &item.deferral.item_id)
        .field(
            "decision",
            &decode::<Decision>(r#"{"kind":"question","answers":{"plan":"A"}}"#),
        )
        .finish();
    f.store
        .submit(move |tx| {
            raw(
                tx,
                &ROOT.into(),
                "evt_legacy_decided",
                "session.review.decided.1",
                data,
            )
        })
        .unwrap()
        .await
        .unwrap();
    task(&f.store, CHILD, ROOT, "waiting", Some("qst_review"));
    let child = f
        .reviews
        .open(open(
            CHILD,
            "subagent_question",
            "sleep_entry",
            r#"{"questionID":"qst_review"}"#,
            SUBAGENT,
        ))
        .await
        .unwrap();
    let data = ObjectEncoder::new()
        .field("sessionID", CHILD)
        .field("itemID", &child.deferral.item_id)
        .field(
            "decision",
            &decode::<Decision>(
                r#"{"kind":"subagent_question","text":"Recovered human evidence"}"#,
            ),
        )
        .finish();
    f.store
        .submit(move |tx| {
            raw(
                tx,
                &CHILD.into(),
                "evt_legacy_child",
                "session.review.decided.1",
                data,
            )
        })
        .unwrap()
        .await
        .unwrap();

    assert_eq!(f.reviews.reconcile(60).await.unwrap(), 2);
    assert!(prompt_text(&f.store, &item.deferral.item_id).contains(r#"{"plan":"A"}"#));
    assert_eq!(
        text(&f.delivery.answers.lock().unwrap()[0].text),
        "Recovered human evidence"
    );
    task(&f.store, CHILD, ROOT, "running", None);
    assert_eq!(f.reviews.reconcile(61).await.unwrap(), 0);
    assert_eq!(events(&f.store, ROOT, "session.input.admitted.1").len(), 1);
    assert_eq!(events(&f.store, ROOT, "session.review.decided.1").len(), 1);
    assert_eq!(events(&f.store, CHILD, "session.review.decided.1").len(), 1);
    assert_eq!(f.delivery.answers.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn a_grant_survives_restart_and_is_consumed_once() {
    let directory = temporary("restart");
    let path = directory.join("core.redb");
    let grant = digest('4');
    {
        let store =
            Store::initialize(&path, Options::core(), CATALOG, Metadata::new([7; 16], 1)).unwrap();
        seed(&store);
        let f = with_store(store);
        let item = f
            .reviews
            .open(guardrail(ROOT, true, &[], &grant))
            .await
            .unwrap();
        f.reviews
            .decide(decision(
                ROOT,
                &item,
                r#"{"kind":"guardrail","reply":"once"}"#,
            ))
            .await
            .unwrap();
        f.reviews.open(form(CHILD)).await.unwrap();
        let Fixture {
            store,
            sessions,
            delivery,
            reviews,
        } = f;
        drop((sessions, delivery, reviews));
        store.shutdown().unwrap();
    }
    let f = with_store(Store::open(&path, Options::core(), CATALOG).unwrap());
    assert_eq!(f.reviews.list(&id(ROOT)).unwrap().len(), 1);
    assert!(
        f.reviews
            .consume(&id(ROOT), GrantKind::Guardrail, &grant, 70)
            .await
            .unwrap()
    );
    assert!(
        !f.reviews
            .consume(&id(ROOT), GrantKind::Guardrail, &grant, 71)
            .await
            .unwrap()
    );
    let Fixture {
        store,
        sessions,
        delivery,
        reviews,
    } = f;
    drop((sessions, delivery, reviews));
    store.shutdown().unwrap();
    std::fs::remove_dir_all(directory).unwrap();
}

#[tokio::test]
async fn review_mutations_stay_within_the_transaction_budget_over_long_family_history() {
    let f = fixture();
    let total = 34_000usize;
    for chunk in (0..total).collect::<Vec<_>>().chunks(4_000) {
        let chunk = chunk.to_vec();
        f.store
            .submit(move |tx| {
                for index in chunk {
                    let item = format!("rvw_history_{index:06}");
                    raw(
                        tx,
                        &ROOT.into(),
                        &format!("evt_history_deferred_{index}"),
                        "session.review.deferred.1",
                        ObjectEncoder::new()
                            .field("sessionID", ROOT)
                            .field("itemID", item.as_str())
                            .field("kind", "question")
                            .field("reason", "free_text")
                            .field("origin", &json(REQUEST))
                            .field("payload", &json(FORM))
                            .finish(),
                    )?;
                    raw(
                        tx,
                        &ROOT.into(),
                        &format!("evt_history_withdrawn_{index}"),
                        "session.review.withdrawn.1",
                        ObjectEncoder::new()
                            .field("sessionID", ROOT)
                            .field("itemID", item.as_str())
                            .field("reason", "task_closed")
                            .finish(),
                    )?;
                }
                Ok(())
            })
            .unwrap()
            .await
            .unwrap();
    }
    let mut limited = form(CHILD);
    limited.limit = 1;
    let item = f.reviews.open(limited.clone()).await.unwrap();
    assert!(matches!(
        f.reviews.open(limited).await,
        Err(Error::Full { limit: 1, .. })
    ));
    assert_eq!(
        ids(&f.reviews.list(&id(ROOT)).unwrap()),
        ids(std::slice::from_ref(&item))
    );
    let grant = digest('5');
    let granted = f
        .reviews
        .open(permission(ROOT, false, &grant))
        .await
        .unwrap();
    f.reviews
        .decide(decision(
            ROOT,
            &granted,
            r#"{"kind":"permission","reply":"once"}"#,
        ))
        .await
        .unwrap();
    assert!(
        f.reviews
            .consume(&id(ROOT), GrantKind::Permission, &grant, 80)
            .await
            .unwrap()
    );
    f.reviews
        .decide(decision(
            ROOT,
            &item,
            r#"{"kind":"question","answers":{"plan":"A"}}"#,
        ))
        .await
        .unwrap();
    assert_eq!(
        f.reviews
            .withdraw(&id(ROOT), WithdrawReason::TaskClosed, 81)
            .await
            .unwrap(),
        0
    );
    assert_eq!(f.reviews.reconcile(82).await.unwrap(), 0);
    assert!(!f.reviews.has_open(&id(ROOT)).unwrap());
}

#[test]
fn review_kinds_reasons_and_origins_decode_from_the_frozen_wire_values() {
    assert_eq!(literal::<Kind>("subagent_question"), Kind::SubagentQuestion);
    assert_eq!(literal::<Reason>("sleep_entry"), Reason::SleepEntry);
    assert!(matches!(decode::<Origin>(REQUEST), Origin::Request { .. }));
    assert!(matches!(decode::<Payload>(RECOVERY), Payload::Recovery(_)));
}
