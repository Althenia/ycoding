include!("policy_fixture.rs");

use std::{
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};
use ycoding_core::{
    coordination::{
        self, Service,
        decisions::{CoordinationDecisions, Options as DecisionOptions, Services, id_text},
        runtime::{
            AnswerInput, Decision, DecisionEscalateInput, DecisionOutcome, Decisions,
            EscalateInput, EscalateOutcome, EscalationTarget, EvaluateInput, InspectInput, Options,
            PendingInput, Runtime, SendInput,
        },
    },
    event_feed::{self, Feed, Payload},
    job,
    process::guardrails::{Guardrails, Input as GuardrailInput, Limits, Paths, Settings},
    session::{
        execution::{Execution, Locations, Runner},
        run_coordinator::{DrainRequest, RunFuture},
        store::Service as SessionStore,
    },
    tools::policy::forms::Forms,
};
use ycoding_schema::{
    DomainDecode, DomainEncode, JsonValue, LosslessString, coordination as c, form, parse_json,
    permission, session_id::SessionId,
};
use ycoding_store::session::{Document, SessionTable, Task, TaskTable};

const BOUND: Duration = Duration::from_secs(10);
const OUTSIDE: &str = "touch /outside/private-target";

async fn until(condition: impl Fn() -> bool) {
    tokio::time::timeout(BOUND, async {
        while !condition() {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("condition holds");
}

fn rule(action: &str, resource: &str, effect: &str) -> permission::Rule {
    permission::Rule {
        action: action.into(),
        resource: resource.into(),
        effect: permission::Effect(effect.into()),
    }
}

fn guardrail_settings() -> Settings {
    Settings {
        paths: Paths {
            workdir: "/workspace/project".into(),
            project: "/workspace/project".into(),
            home: "/home/operator".into(),
            tmpdir: None,
            trusted_paths: vec![],
        },
        global_roots: vec![],
        custom: Arc::new(Vec::new),
        enabled: true,
        limits: Limits::default(),
        decide_reviews: false,
        decide_hard_reviews: false,
    }
}

fn task(session_id: &str, parent_id: &str, state: &str) -> Task {
    Task {
        session_id: session_id.into(),
        parent_id: parent_id.into(),
        parent_assistant_message_id: "msg_parent".into(),
        tool_call_id: format!("call_{session_id}").as_str().into(),
        input_id: format!("msg_input_{session_id}").as_str().into(),
        description: "Work".into(),
        agent: "test".into(),
        model: Document::new(parse_json(r#"{"providerID":"local","id":"test"}"#).unwrap()).unwrap(),
        prompt_digest: "0".repeat(64).as_str().into(),
        background: 1,
        delivery: "steer".into(),
        state: state.into(),
        progress: None,
        progress_time: None,
        question_id: None,
        question: None,
        question_data: None,
        question_time: None,
        usage_anchor: None,
        attempt_started: 0,
        owner_pid: None,
        owner_started: None,
        revision: 1,
        time_created: 1,
        time_updated: 1,
    }
}

struct Park;
impl Runner for Park {
    fn drain(&self, _request: DrainRequest) -> RunFuture {
        Box::pin(async {
            std::future::pending::<()>().await;
            Ok(())
        })
    }
}
struct Counted(Arc<AtomicUsize>);
impl Locations for Counted {
    fn get(
        &self,
        _session: &ycoding_schema::session::Info,
    ) -> Result<Arc<dyn Runner>, ycoding_core::session::run_coordinator::Error> {
        self.0.fetch_add(1, Ordering::SeqCst);
        Ok(Arc::new(Park))
    }
}

struct Family {
    fixture: Fixture,
    permissions: ycoding_core::tools::policy::permissions::Permissions,
    guardrails: Guardrails,
    forms: Forms,
    coordination: Service,
    decisions: CoordinationDecisions,
    group: c::GroupId,
    master: SessionId,
    owner: SessionId,
    member: SessionId,
    helper: SessionId,
    nested: SessionId,
    outsider: SessionId,
}

async fn family() -> Family {
    let fixture = Fixture::default();
    fixture
        .rules
        .lock()
        .unwrap()
        .extend([rule("shell", "*", "ask"), rule("edit", "*", "ask")]);
    let manual = ["manual"; 3];
    let master = fixture.session_with("ses_master", None, manual, false, None);
    let owner = fixture.session_with("ses_owner", Some("ses_master"), manual, false, None);
    let member = fixture.session_with("ses_alpha", None, manual, false, None);
    let helper = fixture.session_with("ses_helper", Some("ses_alpha"), manual, false, None);
    let nested = fixture.session_with("ses_nested", Some("ses_helper"), manual, false, None);
    let outsider = fixture.session_with("ses_outsider", None, manual, false, None);
    fixture
        .store
        .submit(|tx| TaskTable::put(tx, &task("ses_owner", "ses_master", "running")))
        .unwrap()
        .wait()
        .unwrap();
    let client = fixture.store.client();
    let coordination = Service::new(client.clone(), Feed::attach(&client));
    let group = coordination
        .create(c::CreateInput {
            name: "Descendants".into(),
            master_session_id: master.clone(),
            member_session_ids: vec![member.clone()],
        })
        .await
        .unwrap();
    coordination
        .set_owner(
            &group.id,
            coordination::OwnerInput {
                session_id: member.clone(),
                owner_session_id: Some(owner.clone()),
                reason: None,
            },
        )
        .await
        .unwrap();
    coordination.activate(&group.id).unwrap();
    let permissions = fixture.permissions();
    let guardrails = Guardrails::new(
        fixture.authority(),
        permissions.clone(),
        guardrail_settings(),
        fixture.publisher(),
    );
    let forms = Forms::new(fixture.authority(), fixture.publisher());
    let services = Services {
        permissions: permissions.clone(),
        forms: forms.clone(),
        guardrails: guardrails.clone(),
        lease: Arc::new(()),
        is_current: Arc::new(|| true),
    };
    let decisions = CoordinationDecisions::new(DecisionOptions {
        coordination: coordination.clone(),
        settings: Arc::new(|| {
            Box::pin(async {
                Ok(c::Settings {
                    enabled: true,
                    categories: vec![
                        c::RequestKind::Permission,
                        c::RequestKind::Review,
                        c::RequestKind::Question,
                    ],
                    actions: None,
                    resources: None,
                    expires_at: None,
                })
            })
        }),
        services: Arc::new(move |_| {
            let services = services.clone();
            Box::pin(async move { Ok(services) })
        }),
        now: None,
    });
    Family {
        fixture,
        permissions,
        guardrails,
        forms,
        coordination,
        decisions,
        group: group.id,
        master,
        owner,
        member,
        helper,
        nested,
        outsider,
    }
}

type Waiting = tokio::task::JoinHandle<Result<(), ycoding_core::tools::policy::permissions::Error>>;

impl Family {
    async fn ask_permission(
        &self,
        id: &str,
        session: &SessionId,
    ) -> (permission::Request, LosslessString, Waiting) {
        let request = permission::Request {
            id: permission::Id::new(id).unwrap(),
            session_id: session.clone(),
            action: "shell".into(),
            resources: vec!["git push origin main".into()],
            save: None,
            metadata: None,
            source: None,
            escalation: None,
            coordination_escalation: None,
        };
        let key = request.id.clone();
        let waiting = tokio::spawn({
            let permissions = self.permissions.clone();
            let request = request.clone();
            async move { permissions.assert(request, None).await }
        });
        until(|| self.permissions.snapshot(&key).is_some()).await;
        let fingerprint = self.permissions.snapshot(&key).unwrap().fingerprint;
        (request, fingerprint, waiting)
    }

    fn review(
        &self,
        session: &SessionId,
    ) -> (
        ycoding_schema::guardrail::Request,
        LosslessString,
        ycoding_core::tools::policy::Wait<
            Result<
                ycoding_core::process::guardrails::Reservation,
                ycoding_core::process::guardrails::Error,
            >,
        >,
    ) {
        let admission = self
            .guardrails
            .assert(GuardrailInput {
                session_id: session.clone(),
                action: "shell".into(),
                resources: vec![OUTSIDE.into()],
                metadata: None,
                skip_review: false,
                holder: None,
                source: None,
            })
            .unwrap();
        let request = admission.request.expect("the outside write is reviewed");
        let fingerprint = self
            .guardrails
            .request_snapshot(session, &request.id)
            .unwrap()
            .unwrap()
            .fingerprint;
        (request, fingerprint, admission.wait.unwrap())
    }

    fn form(&self, id: &str, session: &SessionId) -> form::Info {
        form::Info::decode(
            &parse_json(&format!(
                r#"{{"id":"{id}","sessionID":"{}","title":"Choose the branch","fields":[{{"key":"branch","type":"string","required":true}}]}}"#,
                session.as_lossless().as_str().unwrap()
            ))
            .unwrap(),
        )
        .unwrap()
    }

    fn evaluate_input(
        &self,
        kind: c::RequestKind,
        request_id: LosslessString,
        fingerprint: LosslessString,
        descendants: Vec<SessionId>,
    ) -> EvaluateInput {
        EvaluateInput {
            group_id: self.group.clone(),
            coordinator_session_id: self.master.clone(),
            target_session_id: self.member.clone(),
            descendant_session_ids: descendants,
            request_id,
            kind,
            fingerprint,
            rationale: "Owner-approved within the assignment.".into(),
            confidence: None,
            answer: None,
            decision: None,
        }
    }

    fn escalate_input(
        &self,
        kind: c::RequestKind,
        request_id: LosslessString,
        fingerprint: LosslessString,
        descendants: Vec<SessionId>,
    ) -> DecisionEscalateInput {
        DecisionEscalateInput {
            group_id: self.group.clone(),
            coordinator_session_id: self.master.clone(),
            target_session_id: self.member.clone(),
            descendant_session_ids: descendants,
            request_id,
            kind,
            fingerprint,
            reason: "Needs the user.".into(),
        }
    }
}

async fn joined(waiting: Waiting) -> bool {
    tokio::time::timeout(BOUND, waiting)
        .await
        .unwrap()
        .unwrap()
        .is_ok()
}

fn via(result: &ycoding_core::coordination::runtime::DecisionResult) -> Option<String> {
    result.via.as_ref().and_then(|via| via.to_utf8().ok())
}

#[tokio::test]
async fn an_owner_settles_a_member_subagents_permission_ask_and_outside_review_through_the_member()
{
    let family = family().await;
    let descendants = vec![family.helper.clone()];
    let (approved, fingerprint, waiting) =
        family.ask_permission("per_approved", &family.helper).await;
    let mut input = family.evaluate_input(
        c::RequestKind::Permission,
        id_text(&approved.id),
        fingerprint,
        descendants.clone(),
    );
    input.decision = Some(Decision::Approve);
    let result = family.decisions.evaluate(input).await.unwrap();
    assert_eq!(result.outcome, DecisionOutcome::Allowed, "{result:?}");
    assert!(result.settled);
    assert_eq!(via(&result).as_deref(), Some("coordination"));
    assert!(joined(waiting).await);

    let (declined, fingerprint, waiting) =
        family.ask_permission("per_declined", &family.helper).await;
    let mut input = family.evaluate_input(
        c::RequestKind::Permission,
        id_text(&declined.id),
        fingerprint,
        descendants.clone(),
    );
    input.decision = Some(Decision::Decline);
    let result = family.decisions.evaluate(input).await.unwrap();
    assert_eq!(result.outcome, DecisionOutcome::Denied, "{result:?}");
    assert!(!joined(waiting).await);
    assert!(family.permissions.snapshot(&declined.id).is_none());

    let (request, fingerprint, wait) = family.review(&family.helper);
    assert_eq!(request.session_id, family.helper);
    let mut input = family.evaluate_input(
        c::RequestKind::Review,
        id_text(&request.id),
        fingerprint,
        descendants.clone(),
    );
    input.decision = Some(Decision::Decline);
    let result = family.decisions.evaluate(input).await.unwrap();
    assert_eq!(result.outcome, DecisionOutcome::Denied, "{result:?}");
    assert!(
        tokio::time::timeout(BOUND, wait)
            .await
            .unwrap()
            .unwrap()
            .is_err()
    );

    let (request, fingerprint, wait) = family.review(&family.helper);
    let result = family
        .decisions
        .evaluate(family.evaluate_input(
            c::RequestKind::Review,
            id_text(&request.id),
            fingerprint,
            descendants,
        ))
        .await
        .unwrap();
    assert_eq!(result.outcome, DecisionOutcome::Allowed, "{result:?}");
    tokio::time::timeout(BOUND, wait)
        .await
        .unwrap()
        .unwrap()
        .expect("the approved review grants the action")
        .release();
}

#[tokio::test]
async fn pending_through_the_member_lists_its_subagents_requests_and_a_request_outside_the_family_stays_out_of_reach()
 {
    let family = family().await;
    let (child, _, child_wait) = family.ask_permission("per_child", &family.nested).await;
    let (own, _, own_wait) = family.ask_permission("per_own", &family.member).await;
    let (stranger, stranger_fingerprint, stranger_wait) = family
        .ask_permission("per_stranger", &family.outsider)
        .await;
    let pending = |descendants: Vec<SessionId>| PendingInput {
        group_id: family.group.clone(),
        coordinator_session_id: family.master.clone(),
        target_session_id: family.member.clone(),
        descendant_session_ids: descendants,
        limit: None,
    };
    let listed = family
        .decisions
        .pending(pending(vec![family.helper.clone(), family.nested.clone()]))
        .await
        .unwrap();
    let mut seen = listed
        .iter()
        .map(|item| {
            (
                item.summary.request_id.to_utf8().unwrap(),
                item.summary.request_session_id.clone(),
            )
        })
        .collect::<Vec<_>>();
    seen.sort();
    assert_eq!(
        seen,
        [
            ("per_child".to_owned(), Some(family.nested.clone())),
            ("per_own".to_owned(), None),
        ]
    );
    let own_only = family.decisions.pending(pending(vec![])).await.unwrap();
    assert_eq!(
        own_only
            .iter()
            .map(|item| item.summary.request_id.to_utf8().unwrap())
            .collect::<Vec<_>>(),
        ["per_own"]
    );
    let family_ids = vec![family.helper.clone(), family.nested.clone()];
    let settled = family
        .decisions
        .evaluate(family.evaluate_input(
            c::RequestKind::Permission,
            id_text(&stranger.id),
            stranger_fingerprint.clone(),
            family_ids.clone(),
        ))
        .await
        .unwrap();
    assert_eq!(settled.outcome, DecisionOutcome::Stale);
    assert!(!settled.settled);
    let escalated = family
        .decisions
        .escalate(family.escalate_input(
            c::RequestKind::Permission,
            id_text(&stranger.id),
            stranger_fingerprint,
            family_ids,
        ))
        .await
        .unwrap();
    assert_eq!(escalated.outcome, EscalateOutcome::Stale);
    assert!(
        family
            .permissions
            .snapshot(&stranger.id)
            .unwrap()
            .request
            .coordination_escalation
            .is_none()
    );
    for (waiting, id) in [
        (child_wait, &child.id),
        (own_wait, &own.id),
        (stranger_wait, &stranger.id),
    ] {
        family.permissions.cancel(id);
        let _ = joined(waiting).await;
    }
}

#[tokio::test]
async fn a_master_escalation_of_a_member_subagents_review_reaches_the_human_in_the_requesting_session()
 {
    let family = family().await;
    let (request, fingerprint, wait) = family.review(&family.helper);
    let result = family
        .decisions
        .escalate(family.escalate_input(
            c::RequestKind::Review,
            id_text(&request.id),
            fingerprint.clone(),
            vec![family.helper.clone()],
        ))
        .await
        .unwrap();
    assert_eq!(result.outcome, EscalateOutcome::Escalated, "{result:?}");
    assert_eq!(result.to, Some(EscalationTarget::Client));
    assert_eq!(result.request_session_id, Some(family.helper.clone()));
    assert_eq!(result.coordination_escalation.unwrap().reasons.len(), 1);
    let snapshot = family
        .guardrails
        .request_snapshot(&family.helper, &request.id)
        .unwrap()
        .unwrap();
    assert_eq!(
        snapshot
            .request
            .coordination_escalation
            .unwrap()
            .reasons
            .len(),
        1,
        "the request stays open in the requesting Session"
    );
    assert_eq!(snapshot.fingerprint, fingerprint);
    family.guardrails.cancel(&request.id);
    assert!(
        tokio::time::timeout(BOUND, wait)
            .await
            .unwrap()
            .unwrap()
            .is_err()
    );
}

struct Runtimes {
    runtime: Runtime,
    sessions: SessionStore,
    wakes: Arc<AtomicUsize>,
}

fn runtime(family: &Family) -> Runtimes {
    let sessions = SessionStore::new(family.fixture.store.client());
    let jobs = job::Jobs::new();
    let wakes = Arc::new(AtomicUsize::new(0));
    let execution = Execution::install(
        sessions.clone(),
        Arc::new(Counted(wakes.clone())),
        jobs.clone(),
        None,
    )
    .unwrap();
    let runtime = Runtime::new(Options {
        coordination: family.coordination.clone(),
        sessions: sessions.clone(),
        execution,
        decisions: Arc::new(family.decisions.clone()),
        jobs,
        validate_model: Arc::new(|_, _| Box::pin(async { Ok(()) })),
        model_services: Arc::new(|_| {
            Box::pin(async {
                Err(coordination::Error::refused(
                    "model switching is outside this member family fixture",
                ))
            })
        }),
        creator: None,
    });
    Runtimes {
        runtime,
        sessions,
        wakes,
    }
}

fn notices(sessions: &SessionStore, id: &SessionId) -> Vec<JsonValue> {
    sessions
        .pending_list(id)
        .unwrap()
        .into_iter()
        .filter_map(|row| {
            let JsonValue::Object(data) = row.data else {
                return None;
            };
            data.get(&"metadata".into()).cloned()
        })
        .collect()
}

fn field(value: &JsonValue, name: &str) -> Option<String> {
    let JsonValue::Object(fields) = value else {
        return None;
    };
    match fields.get(&name.into()) {
        Some(JsonValue::String(text)) => text.to_utf8().ok(),
        _ => None,
    }
}

fn ephemeral(data: event_feed::Data) -> Payload {
    Payload::Ephemeral(event_feed::Ephemeral {
        id: "evt_family_request".into(),
        created: 1,
        session: None,
        location: None,
        metadata: None,
        data,
    })
}

async fn raise_form(
    family: &Family,
    runtimes: &Runtimes,
    id: &str,
    session: &SessionId,
) -> form::Id {
    let info = family.form(id, session);
    let key = info.id.clone();
    let wait = family.forms.ask(info.clone()).unwrap();
    std::mem::forget(wait);
    runtimes
        .runtime
        .handle(&ephemeral(event_feed::Data::FormCreated(Box::new(
            form::CreatedData { form: info },
        ))))
        .await
        .unwrap();
    key
}

async fn phase_nested_form(family: &Family, runtimes: &Runtimes) {
    let runtime = &runtimes.runtime;
    let id = raise_form(family, runtimes, "frm_nested_branch", &family.nested).await;
    let request_id = id_text(&id);

    let owner_notices = notices(&runtimes.sessions, &family.owner);
    assert_eq!(owner_notices.len(), 1, "{owner_notices:?}");
    assert_eq!(
        field(&owner_notices[0], "source").as_deref(),
        Some("project_notification")
    );
    assert_eq!(
        field(&owner_notices[0], "memberSessionID").as_deref(),
        Some("ses_alpha")
    );
    assert_eq!(
        field(&owner_notices[0], "event").as_deref(),
        Some("question")
    );
    assert_eq!(
        field(&owner_notices[0], "requestSessionID").as_deref(),
        Some("ses_nested")
    );
    for quiet in [
        &family.master,
        &family.member,
        &family.helper,
        &family.nested,
        &family.outsider,
    ] {
        assert!(notices(&runtimes.sessions, quiet).is_empty(), "{quiet:?}");
    }

    let roster = runtime.roster(&family.master).await.unwrap();
    let alpha = roster
        .members
        .iter()
        .find(|item| item.session_id == family.member)
        .unwrap();
    assert_eq!(alpha.pending.len(), 1);
    assert_eq!(alpha.pending[0].request_id, request_id);
    assert_eq!(
        alpha.pending[0].request_session_id,
        Some(family.nested.clone())
    );
    assert_eq!(alpha.state, c::MemberState::Idle);

    let detail = runtime
        .inspect(
            &family.owner,
            InspectInput {
                session_id: family.member.clone(),
                request_id: request_id.clone(),
            },
        )
        .await
        .unwrap()
        .encode();
    assert_eq!(field(&detail, "kind").as_deref(), Some("question"));
    assert_eq!(
        field(&detail, "requestSessionID").as_deref(),
        Some("ses_nested")
    );
    assert_eq!(field(&detail, "delegation").as_deref(), Some("routine"));
    let fingerprint = field(&detail, "fingerprint").unwrap();

    let sent = runtime
        .send(
            &family.owner,
            SendInput {
                session_id: family.member.clone(),
                text: "Continue the assignment".into(),
                delivery: None,
                message_id: None,
                model: None,
            },
        )
        .await
        .unwrap();
    assert!(!sent.reconciled);

    let escalated = runtime
        .escalate(
            &family.owner,
            EscalateInput {
                session_id: family.member.clone(),
                request_id: request_id.clone(),
                kind: c::RequestKind::Question,
                fingerprint: fingerprint.as_str().into(),
                reason: "The Master knows the release branch".into(),
            },
        )
        .await
        .unwrap();
    assert!(escalated.delivered);
    assert_eq!(escalated.request_session_id, Some(family.nested.clone()));
    assert_eq!(escalated.decision.to, Some(EscalationTarget::Master));
    assert_eq!(
        escalated.decision.request_session_id,
        Some(family.nested.clone())
    );
    let master_notices = notices(&runtimes.sessions, &family.master);
    assert_eq!(master_notices.len(), 1, "{master_notices:?}");
    assert_eq!(
        field(&master_notices[0], "source").as_deref(),
        Some("project_escalation")
    );
    assert_eq!(
        field(&master_notices[0], "event").as_deref(),
        Some("escalated")
    );
    assert_eq!(
        field(&master_notices[0], "requestID").as_deref(),
        request_id.as_str()
    );
    assert_eq!(
        field(&master_notices[0], "requestSessionID").as_deref(),
        Some("ses_nested")
    );

    let answered = runtime
        .answer(
            &family.owner,
            AnswerInput {
                session_id: family.member.clone(),
                request_id: request_id.clone(),
                kind: c::RequestKind::Question,
                fingerprint: fingerprint.as_str().into(),
                rationale: "The assignment names the safe branch".into(),
                confidence: Some(0.95),
                answer: Some(
                    form::Answer::decode(&parse_json(r#"{"branch":"safe"}"#).unwrap()).unwrap(),
                ),
                decision: None,
            },
        )
        .await
        .unwrap();
    assert_eq!(answered.outcome, DecisionOutcome::Allowed, "{answered:?}");
    assert!(answered.settled);
    assert_eq!(via(&answered).as_deref(), Some("coordination"));
    assert!(family.forms.snapshot(&id).is_none());

    let foreign = raise_form(family, runtimes, "frm_outsider_branch", &family.outsider).await;
    let snapshot = family.forms.snapshot(&foreign).unwrap();
    let refused = runtime
        .inspect(
            &family.owner,
            InspectInput {
                session_id: family.member.clone(),
                request_id: id_text(&foreign),
            },
        )
        .await
        .unwrap_err()
        .to_string();
    assert_eq!(
        refused,
        "Request frm_outsider_branch is not pending for Session ses_alpha"
    );
    let stale = runtime
        .answer(
            &family.owner,
            AnswerInput {
                session_id: family.member.clone(),
                request_id: id_text(&foreign),
                kind: c::RequestKind::Question,
                fingerprint: snapshot.fingerprint.clone(),
                rationale: "Not part of this member".into(),
                confidence: Some(0.95),
                answer: Some(
                    form::Answer::decode(&parse_json(r#"{"branch":"safe"}"#).unwrap()).unwrap(),
                ),
                decision: None,
            },
        )
        .await
        .unwrap();
    assert_eq!(stale.outcome, DecisionOutcome::Stale);
    assert!(!stale.settled);
    assert!(family.forms.snapshot(&foreign).is_some());
    let _ = runtimes.wakes.load(Ordering::SeqCst);
}

async fn phase_archived_descendants(family: &Family, runtimes: &Runtimes) {
    family
        .fixture
        .store
        .submit(|tx| {
            let key =
                ycoding_store::tuple_key(&[ycoding_store::KeyPart::String(&"ses_helper".into())]);
            let mut row = tx.get::<SessionTable>(&key)?.unwrap();
            row.time_archived = Some(9);
            SessionTable::put(tx, &row)
        })
        .unwrap()
        .wait()
        .unwrap();
    for (session, name) in [
        (&family.helper, "frm_archived_helper"),
        (&family.nested, "frm_below_archived"),
    ] {
        let id = raise_form(family, runtimes, name, session).await;
        let snapshot = family.forms.snapshot(&id).unwrap();
        for receiver in [&family.master, &family.master, &family.member] {
            assert!(
                notices(&runtimes.sessions, receiver)
                    .iter()
                    .all(|notice| field(notice, "requestID") != id_text(&id).to_utf8().ok()),
                "{name}: {receiver:?}"
            );
        }
        let roster = runtimes.runtime.roster(&family.master).await.unwrap();
        let alpha = roster
            .members
            .iter()
            .find(|item| item.session_id == family.member)
            .unwrap();
        assert!(
            alpha
                .pending
                .iter()
                .all(|item| item.request_id != id_text(&id)),
            "{name}"
        );
        assert!(
            runtimes
                .runtime
                .inspect(
                    &family.master,
                    InspectInput {
                        session_id: family.member.clone(),
                        request_id: id_text(&id),
                    },
                )
                .await
                .is_err()
        );
        let result = runtimes
            .runtime
            .answer(
                &family.master,
                AnswerInput {
                    session_id: family.member.clone(),
                    request_id: id_text(&id),
                    kind: c::RequestKind::Question,
                    fingerprint: snapshot.fingerprint,
                    rationale: "Archived Session".into(),
                    confidence: Some(0.95),
                    answer: Some(
                        form::Answer::decode(&parse_json(r#"{"branch":"safe"}"#).unwrap()).unwrap(),
                    ),
                    decision: None,
                },
            )
            .await
            .unwrap();
        assert_eq!(result.outcome, DecisionOutcome::Stale, "{name}");
        assert!(family.forms.snapshot(&id).is_some(), "{name}");
    }
}

async fn phase_pending_cap(family: &Family, runtimes: &Runtimes) {
    let mut last = None;
    for index in 0..=c::MAX_PENDING {
        let info = family.form(&format!("frm_flood_{index}"), &family.nested);
        last = Some(info.id.clone());
        std::mem::forget(family.forms.ask(info).unwrap());
    }
    let own = family.form("frm_flood_own", &family.member);
    std::mem::forget(family.forms.ask(own).unwrap());
    let roster = runtimes.runtime.roster(&family.master).await.unwrap();
    let alpha = roster
        .members
        .iter()
        .find(|item| item.session_id == family.member)
        .unwrap();
    assert_eq!(alpha.state, c::MemberState::Waiting);
    let last = last.unwrap();
    let snapshot = family.forms.snapshot(&last).unwrap();
    let escalated = runtimes
        .runtime
        .escalate(
            &family.owner,
            EscalateInput {
                session_id: family.member.clone(),
                request_id: id_text(&last),
                kind: c::RequestKind::Question,
                fingerprint: snapshot.fingerprint,
                reason: "The Master knows the release branch".into(),
            },
        )
        .await
        .unwrap();
    assert!(escalated.delivered);
    assert_eq!(escalated.request_session_id, Some(family.nested.clone()));
    assert_eq!(
        escalated.decision.request_session_id,
        Some(family.nested.clone())
    );
}

async fn phase_owned_routing(family: &Family, runtimes: &Runtimes) {
    let (review, _, _review_wait) = family.review(&family.nested);
    let (permission, _, permission_wait) = family
        .ask_permission("per_descendant", &family.helper)
        .await;
    let info = family.form("frm_descendant", &family.helper);
    std::mem::forget(family.forms.ask(info.clone()).unwrap());
    for data in [
        event_feed::Data::GuardrailAsked(Box::new(review.clone())),
        event_feed::Data::PermissionAsked(Box::new(permission.clone())),
        event_feed::Data::FormCreated(Box::new(form::CreatedData { form: info.clone() })),
    ] {
        runtimes.runtime.handle(&ephemeral(data)).await.unwrap();
    }
    let owner_notices = notices(&runtimes.sessions, &family.owner);
    let routed = owner_notices
        .iter()
        .map(|notice| {
            (
                field(notice, "event").unwrap(),
                field(notice, "requestID").unwrap(),
                field(notice, "requestSessionID").unwrap(),
                field(notice, "memberSessionID").unwrap(),
            )
        })
        .collect::<Vec<_>>();
    let expected = [
        (
            "review",
            id_text(&review.id).to_utf8().unwrap(),
            "ses_nested",
        ),
        ("permission", "per_descendant".to_owned(), "ses_helper"),
        ("question", "frm_descendant".to_owned(), "ses_helper"),
    ];
    for (event, id, session) in expected {
        assert!(
            routed.contains(&(
                event.to_owned(),
                id.clone(),
                session.to_owned(),
                "ses_alpha".to_owned()
            )),
            "{event} {id}: {routed:?}"
        );
    }
    let ids = [
        id_text(&review.id).to_utf8().unwrap(),
        "per_descendant".to_owned(),
        "frm_descendant".to_owned(),
    ];
    for quiet in [
        &family.master,
        &family.member,
        &family.helper,
        &family.nested,
        &family.outsider,
    ] {
        assert!(
            notices(&runtimes.sessions, quiet)
                .iter()
                .all(|notice| field(notice, "requestID").is_none_or(|id| !ids.contains(&id))),
            "{quiet:?}"
        );
    }
    family.permissions.cancel(&permission.id);
    let _ = joined(permission_wait).await;
}

async fn phase_unowned_routing(family: &Family, runtimes: &Runtimes) {
    family
        .coordination
        .set_owner(
            &family.group,
            coordination::OwnerInput {
                session_id: family.member.clone(),
                owner_session_id: None,
                reason: None,
            },
        )
        .await
        .unwrap();
    let (review, _, _wait) = family.review(&family.nested);
    runtimes
        .runtime
        .handle(&ephemeral(event_feed::Data::GuardrailAsked(Box::new(
            review.clone(),
        ))))
        .await
        .unwrap();
    let escalations = notices(&runtimes.sessions, &family.master)
        .into_iter()
        .filter(|notice| field(notice, "requestID") == id_text(&review.id).to_utf8().ok())
        .collect::<Vec<_>>();
    assert_eq!(escalations.len(), 1, "{escalations:?}");
    assert_eq!(
        field(&escalations[0], "source").as_deref(),
        Some("project_escalation")
    );
    assert_eq!(field(&escalations[0], "event").as_deref(), Some("review"));
    assert_eq!(field(&escalations[0], "reason").as_deref(), Some("unowned"));
    assert_eq!(
        field(&escalations[0], "requestSessionID").as_deref(),
        Some("ses_nested")
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_members_descendant_requests_route_through_the_member_end_to_end() {
    let family = family().await;
    let runtimes = runtime(&family);
    phase_nested_form(&family, &runtimes).await;
    phase_owned_routing(&family, &runtimes).await;
    phase_pending_cap(&family, &runtimes).await;
    phase_unowned_routing(&family, &runtimes).await;
    phase_archived_descendants(&family, &runtimes).await;
    let _ = runtimes.wakes.load(Ordering::SeqCst);
}

#[test]
fn the_master_instructions_route_descendant_requests_through_the_owner_and_preserve_member_placement()
 {
    let master = coordination::instructions::initial(coordination::Role::Master, true)
        .to_utf8()
        .unwrap();
    for instruction in [
        "A request raised by a member's subagent or deeper descendant is that member's request: it appears with `requestSessionID`, and you `inspect`, `answer` or `escalate` it with the member's `sessionID`.",
        "The supervising owner resolves the target Project folder or designated worktree before enrollment.",
        "Pass exactly one placement: `directory` with an absolute or home-relative path for an explicit folder, including a non-Git folder or repository subdirectory; `projectID` for a repository Project's canonical checkout; or `name` with an explicit `repository` for a new managed worktree.",
        "Attach, assign, send, model, release and remove never change the Session's ID, parent or Location or move or recreate it.",
        "Never create a project work Session under the Master Session as a child or descendant; member Sessions are independently bound root Sessions, and only lightweight supervisor subagents live under the Master.",
    ] {
        assert_eq!(master.matches(instruction).count(), 1, "{instruction}");
    }
}

#[test]
fn the_project_tool_description_names_descendant_requests_and_member_autonomy() {
    use ycoding_core::tools::{builtin::project::Project, registry::Tool};
    let project = Project {
        runtime: Default::default(),
    };
    let definition = project.definition("project");
    let description = definition.description.to_utf8().unwrap();
    for text in [
        "A pending request raised by a member's subagent or any deeper descendant Session is listed under that member with requestSessionID naming the requesting Session; inspect, answer and escalate it with the member's sessionID. It neither makes the member waiting nor blocks send.",
        "A request from a member's descendant stays open in its requesting Session, returned as requestSessionID, and the reasons attach to that Session's prompt.",
        "the member takes your effective permissions, guardrails and answers modes when it joins.",
        "Questions, forms, permission asks and guardrail reviews raised by a member's descendant Sessions are member events whose notifications carry requestSessionID.",
        "Attaching the same Session with the same owner again returns reconciled true and changes nothing; a different owner is refused, so use assign to change it.",
    ] {
        assert!(description.contains(text), "{text}");
    }
}
