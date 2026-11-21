use super::{Authority, Effect, Publisher, Reviews, SessionAuthority, Wait, decision, state};
use crate::coordination::decisions::{
    Appended, Applicability, Claim, EscalateRequest, Escalated, Prior, Reconsider, Reconsidered,
    Rejections, Snapshot, Source, append, coordination_decline_feedback, deferred_review,
    denied_feedback, explicit_rejected, id_text, permission_matches, reviewed,
};
use crate::coordination::{
    Error as CoordError,
    runtime::{Decision, DecisionOutcome},
};
use crate::session::review::{self, FingerprintInput, GrantKind};
use std::{
    collections::{BTreeMap, BTreeSet, VecDeque},
    ops::Bound,
    sync::{Arc, Mutex, OnceLock},
    time::{SystemTime, UNIX_EPOCH},
};
use tokio::sync::oneshot;
use ycoding_schema::{
    DomainDecode, DomainEncode, JsonValue, LosslessString, ObjectEncoder, guardrail, permission,
    permission_saved, project_id::ProjectId, session_id::SessionId, session_review,
};
use ycoding_store::{
    Client, KeyPart, TableSpec,
    project::{Permission, PermissionTable},
    tuple_key,
};

#[derive(Debug)]
pub enum Error {
    Authority(state::Error),
    Store(ycoding_store::Error),
    Publish(String),
    Duplicate,
    NotFound,
    Blocked {
        rules: permission::Ruleset,
        permission: LosslessString,
        resources: Vec<LosslessString>,
        coordinator: bool,
    },
    Declined,
    Corrected(LosslessString),
    Deferred {
        item_id: session_review::Id,
    },
    ReviewFull {
        limit: usize,
    },
    Review(review::Error),
    ReviewUnavailable,
    DeferredReview(Box<DeferredReview>),
}

#[derive(Debug)]
pub struct DeferredReview {
    pub request_id: permission::Id,
    pub session_id: SessionId,
    pub outcome: review::DeferOutcome,
    pub action: LosslessString,
    pub resources: Vec<LosslessString>,
}
impl From<state::Error> for Error {
    fn from(value: state::Error) -> Self {
        Self::Authority(value)
    }
}
impl From<ycoding_store::Error> for Error {
    fn from(value: ycoding_store::Error) -> Self {
        Self::Store(value)
    }
}

#[derive(Clone)]
pub struct SavedPermissions {
    pub store: Client,
}

impl SavedPermissions {
    pub fn list(&self, project: Option<&ProjectId>) -> Result<Vec<permission_saved::Info>, Error> {
        let snapshot = self.store.snapshot()?;
        let mut after = None;
        let mut result = vec![];
        loop {
            let rows = snapshot.scan::<PermissionTable>(
                after.as_deref().map_or(Bound::Unbounded, Bound::Excluded),
                Bound::Unbounded,
                128,
            )?;
            if rows.is_empty() {
                return Ok(result);
            }
            after = rows.last().map(PermissionTable::primary_key);
            for row in rows.into_iter().filter(|row| {
                project.is_none_or(|project| project.as_lossless() == &row.project_id)
            }) {
                result.push(permission_saved::Info {
                    id: permission_saved::Id(row.id),
                    project_id: ProjectId::new(row.project_id).expect("unrestricted project ID"),
                    action: row.action,
                    resource: row.resource,
                });
            }
        }
    }

    pub fn add(
        &self,
        project: &ProjectId,
        action: &LosslessString,
        resources: &[LosslessString],
    ) -> Result<(), Error> {
        if resources.is_empty() {
            return Ok(());
        }
        let project = project.as_lossless().clone();
        let action = action.clone();
        let resources = resources.to_vec();
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock after epoch")
            .as_millis() as i64;
        self.store
            .submit(move |tx| {
                for resource in resources {
                    let unique = tuple_key(&[
                        KeyPart::String(&project),
                        KeyPart::String(&action),
                        KeyPart::String(&resource),
                    ]);
                    if !tx
                        .index::<PermissionTable>(
                            "permission_project_action_resource_idx",
                            &unique,
                            None,
                            1,
                        )?
                        .is_empty()
                    {
                        continue;
                    }
                    tx.put::<PermissionTable>(&Permission {
                        id: state::decode_id::<permission::Id>("per_", 0).into_lossless(),
                        project_id: project.clone(),
                        action: action.clone(),
                        resource,
                        time_created: now,
                        time_updated: now,
                    })?;
                }
                Ok(())
            })?
            .wait()?;
        Ok(())
    }

    pub fn remove(&self, id: &permission_saved::Id) -> Result<(), Error> {
        let key = tuple_key(&[KeyPart::String(&id.0)]);
        self.store
            .submit(move |tx| {
                tx.delete::<PermissionTable>(&key)?;
                Ok(())
            })?
            .wait()?;
        Ok(())
    }

    fn rules(&self, project: &ProjectId) -> Result<permission::Ruleset, Error> {
        Ok(self
            .list(Some(project))?
            .into_iter()
            .map(|item| permission::Rule {
                action: item.action,
                resource: item.resource,
                effect: permission::Effect("allow".into()),
            })
            .collect())
    }
}

struct Pending {
    order: u64,
    request: permission::Request,
    agent: Option<LosslessString>,
    sender: oneshot::Sender<Result<(), Error>>,
}
type ScopeCheck = Arc<dyn Fn(&SessionId) -> bool + Send + Sync>;

struct Inner {
    authority: Authority,
    saved: SavedPermissions,
    project: ProjectId,
    publish: Publisher,
    pending: Mutex<BTreeMap<permission::Id, Pending>>,
    reconsidering: Arc<Mutex<BTreeSet<permission::Id>>>,
    rejections: Rejections,
    approvals: Mutex<Approvals>,
    context: OnceLock<Arc<crate::coordination::decision_context::Service>>,
    reviews: OnceLock<(Reviews, LosslessString)>,
    assessor: OnceLock<crate::process::guardrails::decision::Adapter>,
    scope_check: OnceLock<ScopeCheck>,
}

const MAX_CALL_APPROVALS: usize = 8;
const MAX_APPROVAL_CALLS: usize = 256;

#[derive(Default)]
struct Approvals {
    order: VecDeque<String>,
    calls: BTreeMap<String, Vec<JsonValue>>,
}
#[derive(Clone)]
pub struct Permissions(Arc<Inner>);
pub struct Admission {
    pub id: permission::Id,
    pub effect: Effect,
    pub wait: Option<Wait<Result<(), Error>>>,
}

impl Permissions {
    pub(crate) fn native_identity(&self) -> usize {
        Arc::as_ptr(&self.0) as usize
    }
    pub(crate) fn reply_native(
        &self,
        id: &permission::Id,
        fingerprint: &str,
        allow: bool,
        gate: &crate::dots::authority::Gate,
    ) -> Result<(), Error> {
        let mut pending = self
            .0
            .pending
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let item = pending
            .get(id)
            .filter(|item| crate::dots::authority::fingerprint(&item.request) == fingerprint)
            .ok_or(Error::NotFound)?;
        let service = self.clone();
        let request = item.request.clone();
        let agent = item.agent.clone();
        gate.receipt_checked(
            &self.0.authority.store,
            &item.request.session_id,
            ObjectEncoder::new()
                .field("kind", "permission")
                .field("requestID", id)
                .field("fingerprint", fingerprint)
                .finish(),
            Some(if allow { "once" } else { "reject" }),
            move || {
                if !allow {
                    return Ok(true);
                }
                let authority = service
                    .configured(&request, agent.as_ref())
                    .map_err(|_| "Permission authority is unavailable".to_owned())?;
                Ok(decision(
                    &request.action,
                    &request.resources,
                    &authority.configured,
                    &[],
                ) != Effect::Deny)
            },
        )
        .map_err(|_| Error::NotFound)?;
        let published = state::emit::<permission::Replied>(
            &self.0.publish,
            &permission::RepliedData {
                session_id: item.request.session_id.clone(),
                request_id: id.clone(),
                reply: permission::Reply(if allow { "once" } else { "reject" }.into()),
            },
        );
        self.record_reply(&item.request, if allow { "once" } else { "reject" });
        let item = pending.remove(id).expect("pending request held by lock");
        let result = match &published {
            Err(error) => Err(Error::Publish(error.clone())),
            Ok(()) if allow => self.recheck(&item.request, item.agent.as_ref()),
            Ok(()) => Err(Error::Declined),
        };
        let _ = item.sender.send(result);
        published.map_err(Error::Publish)
    }
    pub fn new(authority: Authority, project: ProjectId, publish: Publisher) -> Self {
        Self(Arc::new(Inner {
            saved: SavedPermissions {
                store: authority.store.clone(),
            },
            authority,
            project,
            publish,
            pending: Mutex::new(BTreeMap::new()),
            reconsidering: Arc::new(Mutex::new(BTreeSet::new())),
            rejections: Rejections::default(),
            approvals: Mutex::new(Approvals::default()),
            context: OnceLock::new(),
            reviews: OnceLock::new(),
            assessor: OnceLock::new(),
            scope_check: OnceLock::new(),
        }))
    }

    pub fn with_scope_check(
        self,
        check: impl Fn(&SessionId) -> bool + Send + Sync + 'static,
    ) -> Result<Self, Error> {
        self.0
            .scope_check
            .set(Arc::new(check))
            .map_err(|_| Error::Duplicate)?;
        Ok(self)
    }

    pub fn with_context(
        self,
        context: Arc<crate::coordination::decision_context::Service>,
    ) -> Self {
        let _ = self.0.context.set(context);
        self
    }

    fn record_reply(&self, request: &permission::Request, reply: &str) {
        let key = Rejections::key(
            &request.session_id,
            fingerprint(request, &self.workdir()).as_lossless(),
        );
        self.0.rejections.record(key, reply == "reject");
        if reply != "reject" {
            self.record_approval(request, reply);
        }
    }

    fn record_approval(&self, request: &permission::Request, reply: &str) {
        let Some(source) = request.source.as_ref() else {
            return;
        };
        let call = call_key(&request.session_id, &source.message_id, &source.call_id);
        let entry = ObjectEncoder::new()
            .field("gate", "permission")
            .field("source", "explicit")
            .field("outcome", "allow")
            .field("reply", reply)
            .field("action", &request.action)
            .field(
                "resources",
                &request
                    .resources
                    .iter()
                    .take(20)
                    .map(|resource| {
                        LosslessString::from_utf16(resource.code_units().take(1000).collect())
                    })
                    .collect::<Vec<_>>(),
            )
            .finish();
        let mut approvals = self
            .0
            .approvals
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let mut recorded = approvals.calls.remove(&call).unwrap_or_default();
        approvals.order.retain(|item| item != &call);
        recorded.drain(..recorded.len().saturating_sub(MAX_CALL_APPROVALS - 1));
        recorded.push(entry);
        approvals.calls.insert(call.clone(), recorded);
        approvals.order.push_back(call);
        if approvals.order.len() > MAX_APPROVAL_CALLS
            && let Some(oldest) = approvals.order.pop_front()
        {
            approvals.calls.remove(&oldest);
        }
    }

    pub(crate) fn call_approvals(
        &self,
        session: &SessionId,
        message: &LosslessString,
        call: &LosslessString,
    ) -> Vec<JsonValue> {
        self.0
            .approvals
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .calls
            .get(&call_key(session, message, call))
            .cloned()
            .unwrap_or_default()
    }

    fn workdir(&self) -> LosslessString {
        self.0
            .reviews
            .get()
            .map(|(_, workdir)| workdir.clone())
            .unwrap_or_default()
    }

    fn prior(
        &self,
        request: &permission::Request,
        deferred: bool,
    ) -> Result<Vec<Prior>, CoordError> {
        let workdir = self.workdir();
        let expected = admission_fingerprint(request, &workdir, deferred)
            .as_lossless()
            .clone();
        let historical = historical_fingerprint(request, &workdir);
        let mut prior = Vec::new();
        prior.extend(
            self.0
                .rejections
                .prior(&Rejections::key(&request.session_id, &expected)),
        );
        prior.extend(reviewed(
            &self
                .0
                .authority
                .store
                .snapshot()
                .map_err(CoordError::Store)?,
            &request.session_id,
            session_review::Kind::Permission,
            |payload| permission_matches(payload, &expected, historical.as_ref()),
        )?);
        Ok(prior)
    }

    fn explicit_rejection(
        &self,
        request: &permission::Request,
        deferred: bool,
    ) -> Result<bool, Error> {
        self.prior(request, deferred)
            .map(|prior| explicit_rejected(&prior))
            .map_err(admission_error)
    }

    fn context_digest(&self, session: &SessionId) -> Result<Option<String>, Error> {
        self.0
            .context
            .get()
            .map(|context| {
                context
                    .authority_digest(session)
                    .map_err(|error| Error::Publish(error.to_string()))
            })
            .transpose()
    }

    fn applicability(
        &self,
        request: &permission::Request,
        authority: &SessionAuthority,
        deferred: bool,
    ) -> Result<Applicability, CoordError> {
        let prior = self.prior(request, deferred)?;
        let saved = self
            .0
            .saved
            .rules(&self.0.project)
            .map_err(coordination_error)?;
        let agent_rules =
            (self.0.authority.agents)(authority.agent.as_ref()).map_or(1, |(_, rules)| rules.len());
        let rules = [authority.configured.as_slice(), saved.as_slice()].concat();
        let rules = request
            .resources
            .iter()
            .take(20)
            .map(|resource| {
                let matched = rules.iter().enumerate().rev().find(|(_, rule)| {
                    super::wildcard(&request.action, &rule.action)
                        && super::wildcard(resource, &rule.resource)
                });
                let (rule, origin) = match matched {
                    Some((index, rule)) => (
                        rule.clone(),
                        if index < agent_rules {
                            "agent"
                        } else if index < authority.configured.len() {
                            "ceiling"
                        } else {
                            "saved"
                        },
                    ),
                    None => (
                        permission::Rule {
                            action: request.action.clone(),
                            resource: "*".into(),
                            effect: permission::Effect("ask".into()),
                        },
                        "unmatched",
                    ),
                };
                ObjectEncoder::new()
                    .field(
                        "resource",
                        &LosslessString::from_utf16(resource.code_units().take(1000).collect()),
                    )
                    .field(
                        "rule",
                        &ObjectEncoder::new()
                            .field("action", &rule.action)
                            .field("resource", &rule.resource)
                            .field("effect", &rule.effect)
                            .finish(),
                    )
                    .field("origin", origin)
                    .finish()
            })
            .collect::<Vec<_>>();
        Ok(Applicability::new(
            "permission",
            vec![("rules", JsonValue::Array(rules))],
            prior,
        ))
    }

    pub fn with_decision(
        self,
        evaluator: Arc<dyn crate::process::guardrails::decision::Evaluator>,
        decide_reviews: bool,
    ) -> Self {
        let _ = self
            .0
            .assessor
            .set(crate::process::guardrails::decision::Adapter {
                evaluator,
                redact: Arc::new(crate::process::guardrails::redact_value),
                policy: crate::process::guardrails::decision::ReviewPolicy {
                    decide_reviews,
                    decide_hard_reviews: true,
                },
                limits: crate::process::guardrails::decision::Limits::default(),
            });
        self
    }

    pub fn with_reviews(self, reviews: Reviews, workdir: LosslessString) -> Self {
        let _ = self.0.reviews.set((reviews, workdir));
        self
    }

    pub fn reconcile_autonomy(&self, session: &SessionId) -> Result<(), Error> {
        if !self
            .0
            .authority
            .session(session, None)?
            .autonomy
            .can_yolo_permission()
        {
            return Ok(());
        }
        let mut pending = self
            .0
            .pending
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let ids = pending
            .iter()
            .filter(|(_, item)| &item.request.session_id == session)
            .map(|(id, _)| id.clone())
            .collect::<Vec<_>>();
        for id in ids {
            let item = pending.get(&id).expect("pending permission held by lock");
            if !self
                .0
                .authority
                .session(session, None)?
                .autonomy
                .can_yolo_permission()
            {
                break;
            }
            let denied = self.coordinator_denied(&item.request)?;
            let reply = if denied { "reject" } else { "once" };
            let blocked = denied.then(|| Error::Corrected(format!(
                "Permission denied: {}. This Session is a Project coordinator; member Sessions make Project changes.",
                item.request.action.to_utf8().unwrap_or_default()
            ).as_str().into()));
            self.assessed(
                &item.request,
                Assessment {
                    outcome: if denied { "deny" } else { "allow" },
                    via: if denied { "coordination" } else { "yolo" },
                    reply: Some(reply),
                    escalation: None,
                    coordination: None,
                },
            )?;
            state::emit::<permission::Replied>(
                &self.0.publish,
                &permission::RepliedData {
                    session_id: session.clone(),
                    request_id: id.clone(),
                    reply: permission::Reply(reply.into()),
                },
            )
            .map_err(Error::Publish)?;
            let item = pending
                .remove(&id)
                .expect("pending permission held by lock");
            let _ = item.sender.send(match blocked {
                Some(error) => Err(error),
                None => Ok(()),
            });
        }
        Ok(())
    }

    pub async fn defer_pending(&self, session: &SessionId) -> Result<usize, Error> {
        self.reconcile_autonomy(session)?;
        let Some((reviews, workdir)) = self.0.reviews.get().cloned() else {
            return Ok(0);
        };
        let items = {
            let mut pending = self
                .0
                .pending
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            let ids = pending
                .iter()
                .filter(|(_, item)| &item.request.session_id == session)
                .map(|(id, _)| id.clone())
                .collect::<Vec<_>>();
            ids.iter()
                .filter_map(|id| pending.remove(id))
                .collect::<Vec<_>>()
        };
        let mut deferred = 0;
        for item in items {
            let outcome = defer(
                &self.0.publish,
                &reviews,
                &item.request,
                fingerprint(&item.request, &workdir),
                session_review::Reason::DeferEntry,
                true,
            )
            .await;
            if matches!(outcome, Err(Error::Deferred { .. })) {
                deferred += 1;
            }
            let _ = item.sender.send(outcome);
        }
        Ok(deferred)
    }

    fn configured(
        &self,
        request: &permission::Request,
        agent: Option<&LosslessString>,
    ) -> Result<SessionAuthority, Error> {
        if self
            .0
            .scope_check
            .get()
            .is_some_and(|check| !check(&request.session_id))
        {
            return Err(Error::Declined);
        }
        let mut authority = self.0.authority.session(&request.session_id, agent)?;
        authority.configured.extend(self.coordinator_rules(
            &request.session_id,
            &request.action,
            &request.resources,
        )?);
        Ok(authority)
    }

    fn recheck(
        &self,
        request: &permission::Request,
        agent: Option<&LosslessString>,
    ) -> Result<(), Error> {
        let authority = self.configured(request, agent)?;
        if self.rule_effect(request, &authority)? == Effect::Deny {
            return Err(Error::Blocked {
                rules: authority
                    .configured
                    .into_iter()
                    .filter(|rule| super::wildcard(&request.action, &rule.action))
                    .collect(),
                permission: request.action.clone(),
                resources: request.resources.clone(),
                coordinator: self.coordinator_denied(request)?,
            });
        }
        Ok(())
    }

    fn coordinator_rules(
        &self,
        session: &SessionId,
        action: &LosslessString,
        resources: &[LosslessString],
    ) -> Result<Vec<permission::Rule>, Error> {
        let snapshot = self.0.authority.store.snapshot()?;
        Ok(
            if crate::coordination::authority::coordinating(&snapshot, session)? {
                crate::coordination::authority::execution_rules(action, resources)
            } else {
                vec![]
            },
        )
    }

    fn coordinator_denied(&self, request: &permission::Request) -> Result<bool, Error> {
        Ok(decision(
            &request.action,
            &request.resources,
            &self.coordinator_rules(&request.session_id, &request.action, &request.resources)?,
            &[],
        ) == Effect::Deny)
    }

    pub fn evaluate_effective(
        &self,
        session: &SessionId,
        agent: Option<&LosslessString>,
        action: &LosslessString,
        resource: &LosslessString,
    ) -> Result<Effect, Error> {
        let authority = self.0.authority.session(session, agent)?;
        let coordinator =
            self.coordinator_rules(session, action, std::slice::from_ref(resource))?;
        if decision(action, std::slice::from_ref(resource), &coordinator, &[]) == Effect::Deny {
            return Ok(Effect::Deny);
        }
        if authority.autonomy.can_yolo_permission() {
            return Ok(Effect::Allow);
        }
        if decision(
            action,
            std::slice::from_ref(resource),
            &authority.configured,
            &[],
        ) == Effect::Deny
        {
            return Ok(Effect::Deny);
        }
        Ok(decision(
            action,
            std::slice::from_ref(resource),
            &authority.configured,
            &self.0.saved.rules(&self.0.project)?,
        ))
    }

    pub fn ask(
        &self,
        request: permission::Request,
        agent: Option<LosslessString>,
    ) -> Result<Admission, Error> {
        self.admit(request, agent, false, true, false)
    }

    fn rule_effect(
        &self,
        request: &permission::Request,
        authority: &SessionAuthority,
    ) -> Result<Effect, Error> {
        if self.coordinator_denied(request)? {
            return Ok(Effect::Deny);
        }
        if authority.autonomy.can_yolo_permission() {
            return Ok(Effect::Allow);
        }
        if decision(
            &request.action,
            &request.resources,
            &authority.configured,
            &[],
        ) == Effect::Deny
        {
            return Ok(Effect::Deny);
        }
        Ok(decision(
            &request.action,
            &request.resources,
            &authority.configured,
            &self.0.saved.rules(&self.0.project)?,
        ))
    }

    fn admit(
        &self,
        request: permission::Request,
        agent: Option<LosslessString>,
        assess: bool,
        consume_review: bool,
        deferred: bool,
    ) -> Result<Admission, Error> {
        let authority = self.configured(&request, agent.as_ref())?;
        let effect = self.rule_effect(&request, &authority)?;
        if effect == Effect::Allow && authority.autonomy.can_yolo_permission() {
            self.assessed(
                &request,
                Assessment {
                    outcome: "allow",
                    via: "yolo",
                    reply: Some("once"),
                    escalation: None,
                    coordination: None,
                },
            )?;
        }
        let explicit = request
            .metadata
            .as_ref()
            .and_then(|metadata| metadata.get(&"requireExplicitDecision".into()))
            == Some(&JsonValue::Bool(true));
        let effect = if effect == Effect::Ask
            && authority.autonomy.can_auto_permission()
            && !explicit
            && !self.explicit_rejection(&request, deferred)?
        {
            self.assessed(
                &request,
                Assessment {
                    outcome: "allow",
                    via: "auto-permission",
                    reply: Some("once"),
                    escalation: None,
                    coordination: None,
                },
            )?;
            Effect::Allow
        } else {
            effect
        };
        let reviews = self.0.reviews.get().cloned();
        let effect = match &reviews {
            Some((reviews, workdir))
                if effect == Effect::Ask
                    && consume_review
                    && reviews
                        .service
                        .consume_now(
                            &request.session_id,
                            GrantKind::Permission,
                            &admission_fingerprint(&request, workdir, deferred),
                            now(),
                        )
                        .map_err(Error::Review)? =>
            {
                Effect::Allow
            }
            _ => effect,
        };
        let id = request.id.clone();
        if effect == Effect::Ask
            && assess
            && !explicit
            && authority.autonomy.can_yolo_permission()
            && self.0.assessor.get().is_some()
        {
            let (sender, receiver) = oneshot::channel();
            let service = self.clone();
            let cancellation = crate::tools::code_mode::Cancellation::default();
            let cancel = cancellation.clone();
            let task = tokio::spawn(async move {
                let outcome = service
                    .assess(request, agent, &cancellation, deferred)
                    .await;
                let _ = sender.send(outcome);
            });
            let task = state::Task::new(task, move || cancel.cancel());
            return Ok(Admission {
                id,
                effect,
                wait: Some(Wait::new(receiver, move || drop(task))),
            });
        }
        if effect == Effect::Ask && deferred {
            let (reviews, workdir) = reviews.ok_or(Error::ReviewUnavailable)?;
            let mut request = request;
            if !explicit && authority.autonomy.can_yolo_permission() {
                request.escalation = Some(guardrail::Escalation {
                    authority: Some(guardrail::Authority::Yolo),
                    reason: Some(guardrail::EscalationReason::Unavailable),
                    choice: None,
                    confidence: None,
                    grades: None,
                });
            }
            return Err(defer_explicit(&reviews, &request, &workdir));
        }
        if effect == Effect::Ask
            && authority.autonomy.deferred
            && let Some((reviews, workdir)) = reviews
        {
            let (sender, receiver) = oneshot::channel();
            let publish = self.0.publish.clone();
            let digest = fingerprint(&request, &workdir);
            tokio::spawn(async move {
                let outcome = defer(
                    &publish,
                    &reviews,
                    &request,
                    digest,
                    session_review::Reason::Disabled,
                    false,
                )
                .await;
                let _ = sender.send(outcome);
            });
            return Ok(Admission {
                id,
                effect,
                wait: Some(Wait::new(receiver, || {})),
            });
        }
        if effect != Effect::Ask {
            return Ok(Admission {
                id,
                effect,
                wait: None,
            });
        }
        let (sender, receiver) = oneshot::channel();
        let mut pending = self
            .0
            .pending
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if pending.contains_key(&id) {
            return Err(Error::Duplicate);
        }
        pending.insert(
            id.clone(),
            Pending {
                order: state::next_order(),
                request: request.clone(),
                agent,
                sender,
            },
        );
        if let Err(error) = state::emit::<permission::Asked>(&self.0.publish, &request) {
            pending.remove(&id);
            return Err(Error::Publish(error));
        }
        Ok(Admission {
            id,
            effect,
            wait: Some(Wait::new(receiver, || {})),
        })
    }

    pub async fn assert(
        &self,
        request: permission::Request,
        agent: Option<LosslessString>,
    ) -> Result<(), Error> {
        self.assert_with_review(request, agent, true).await
    }

    pub async fn assert_deferred(
        &self,
        request: permission::Request,
        agent: Option<LosslessString>,
    ) -> Result<(), Error> {
        self.assert_inner(request, agent, true, true).await
    }

    pub(crate) async fn assert_with_review(
        &self,
        request: permission::Request,
        agent: Option<LosslessString>,
        consume_review: bool,
    ) -> Result<(), Error> {
        self.assert_inner(request, agent, consume_review, false)
            .await
    }

    async fn assert_inner(
        &self,
        request: permission::Request,
        agent: Option<LosslessString>,
        consume_review: bool,
        deferred: bool,
    ) -> Result<(), Error> {
        let action = request.action.clone();
        let resources = request.resources.clone();
        let configured = self.configured(&request, agent.as_ref())?.configured;
        let coordinator = self.coordinator_denied(&request)?;
        let admission = self.admit(
            request.clone(),
            agent.clone(),
            true,
            consume_review,
            deferred,
        )?;
        if admission.effect == Effect::Deny {
            return Err(Error::Blocked {
                rules: configured
                    .into_iter()
                    .filter(|rule| super::wildcard(&action, &rule.action))
                    .collect(),
                permission: action,
                resources,
                coordinator,
            });
        }
        if let Some(wait) = admission.wait {
            let service = self.clone();
            let id = admission.id;
            wait.on_cancel(move || service.cancel(&id))
                .await
                .map_err(|_| Error::Declined)??;
        }
        self.recheck(&request, agent.as_ref())
    }

    async fn assess(
        &self,
        mut request: permission::Request,
        agent: Option<LosslessString>,
        cancellation: &crate::tools::code_mode::Cancellation,
        deferred: bool,
    ) -> Result<(), Error> {
        use crate::process::guardrails::decision::Grading;
        let adapter = self.0.assessor.get().ok_or(Error::Declined)?;
        let authority = self.configured(&request, agent.as_ref())?;
        let fence = crate::session::autonomy::inherited_in(
            &self.0.authority.store.snapshot()?,
            &request.session_id,
        )
        .ok();
        let reviews = self.0.reviews.get().cloned();
        let workdir = self.workdir();
        let key = assessment_key(&request, &workdir, deferred);
        let applicability = self
            .applicability(&request, &authority, deferred)
            .map_err(admission_error)?;
        let digest = self.context_digest(&request.session_id)?;
        let mut evidence = evidence(&request, &workdir);
        if let JsonValue::Object(object) = &mut evidence {
            object.insert("applicability".into(), applicability.value().clone());
        }
        let grading = adapter
            .assess_permission(
                evidence,
                &request.resources,
                authority.autonomy.can_yolo_permission(),
                &key,
                crate::resources::decision::Invocation {
                    session_id: &request.session_id,
                    input_id: None,
                    cancellation,
                    attribution: crate::session::usage_attribution::Attribution::Unset,
                    purpose: Some(crate::resources::decision::Purpose::Permission),
                    authority: None,
                    invocation_key: None,
                },
            )
            .await;
        if matches!(grading, Grading::Cancelled) {
            return Err(Error::Declined);
        }
        let authority = self.configured(&request, agent.as_ref())?;
        match self.rule_effect(&request, &authority)? {
            Effect::Deny => {
                let coordinator = self.coordinator_denied(&request)?;
                return Err(Error::Blocked {
                    coordinator,
                    rules: authority
                        .configured
                        .into_iter()
                        .filter(|rule| super::wildcard(&request.action, &rule.action))
                        .collect(),
                    permission: request.action,
                    resources: request.resources,
                });
            }
            Effect::Allow => return Ok(()),
            Effect::Ask => {}
        }
        let settled = matches!(&grading, Grading::Settled { .. });
        let stale = settled
            && ((matches!(&grading, Grading::Settled { provenance, .. } if provenance.authority == Some(ycoding_schema::guardrail::Authority::Yolo))
                && crate::session::autonomy::inherited_in(
                    &self.0.authority.store.snapshot()?,
                    &request.session_id,
                )
                .ok()
                    != fence)
                || self
                    .applicability(&request, &authority, deferred)
                    .map_err(admission_error)?
                    .digest()
                    != applicability.digest()
                || self.context_digest(&request.session_id)? != digest);
        let held = settled
            && !stale
            && matches!(&grading, Grading::Settled { reply, .. } if *reply == ycoding_schema::guardrail::Reply::Once)
            && applicability.rejected();
        let escalation = match grading {
            _ if stale => Some(ycoding_schema::guardrail::Escalation {
                authority: Some(ycoding_schema::guardrail::Authority::Yolo),
                reason: Some(ycoding_schema::guardrail::EscalationReason::Escalated),
                choice: None,
                confidence: None,
                grades: None,
            }),
            Grading::Settled { provenance, .. } if held => {
                Some(ycoding_schema::guardrail::Escalation {
                    reason: Some(ycoding_schema::guardrail::EscalationReason::Escalated),
                    ..provenance
                })
            }
            Grading::Settled { reply, provenance } => {
                let allow = reply == ycoding_schema::guardrail::Reply::Once;
                self.assessed(
                    &request,
                    Assessment {
                        outcome: if allow { "allow" } else { "deny" },
                        via: via(provenance.authority),
                        reply: Some(if allow { "once" } else { "reject" }),
                        escalation: Some(&provenance),
                        coordination: None,
                    },
                )?;
                return if allow {
                    Ok(())
                } else {
                    Err(Error::Corrected(denied_feedback(false, &provenance)))
                };
            }
            Grading::Escalated { provenance, .. } => Some(provenance),
            Grading::Skipped(_) | Grading::Cancelled => None,
        };
        request.escalation = escalation.clone();
        if deferred {
            if cancellation.is_cancelled() {
                return Err(Error::Declined);
            }
            let (reviews, workdir) = reviews.ok_or(Error::ReviewUnavailable)?;
            return Err(defer_explicit(&reviews, &request, &workdir));
        }
        if authority.autonomy.deferred
            && let Some((reviews, workdir)) = reviews
        {
            let reason = escalation
                .as_ref()
                .and_then(|escalation| escalation.reason)
                .map_or(session_review::Reason::Disabled, review_reason);
            let digest = fingerprint(&request, &workdir);
            return defer(&self.0.publish, &reviews, &request, digest, reason, false).await;
        }
        if let Some(escalation) = &escalation {
            self.assessed(
                &request,
                Assessment {
                    outcome: "escalate",
                    via: via(escalation.authority),
                    reply: None,
                    escalation: Some(escalation),
                    coordination: None,
                },
            )?;
        }
        let (sender, receiver) = oneshot::channel();
        let id = request.id.clone();
        {
            let mut pending = self
                .0
                .pending
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            if pending.contains_key(&id) {
                return Err(Error::Duplicate);
            }
            pending.insert(
                id.clone(),
                Pending {
                    order: state::next_order(),
                    request: request.clone(),
                    agent,
                    sender,
                },
            );
            if let Err(error) = state::emit::<permission::Asked>(&self.0.publish, &request) {
                pending.remove(&id);
                return Err(Error::Publish(error));
            }
        }
        let outcome = tokio::select! {
            biased;
            _ = cancellation.cancelled() => {
                self.cancel(&id);
                Err(Error::Declined)
            }
            outcome = receiver => outcome.unwrap_or(Err(Error::Declined)),
        };
        outcome
    }

    fn assessed(
        &self,
        request: &permission::Request,
        assessment: Assessment<'_>,
    ) -> Result<(), Error> {
        let mut data = ObjectEncoder::new()
            .field("sessionID", &request.session_id)
            .field("requestID", &request.id)
            .field("outcome", assessment.outcome)
            .field("via", assessment.via)
            .optional("reply", &assessment.reply.map(LosslessString::from));
        if let Some(escalation) = assessment.escalation {
            data = data
                .optional("authority", &escalation.authority)
                .optional("reason", &escalation.reason)
                .optional("choice", &escalation.choice)
                .optional("confidence", &escalation.confidence)
                .optional("grades", &escalation.grades);
        }
        let source = request.source.as_ref().filter(|source| {
            source
                .message_id
                .as_str()
                .is_some_and(|id| id.starts_with("msg_"))
        });
        let data = data
            .optional(
                "source",
                &source.map(|source| {
                    ObjectEncoder::new()
                        .field("messageID", &source.message_id)
                        .field("callID", &source.call_id)
                        .finish()
                }),
            )
            .optional(
                "actor",
                &assessment
                    .coordination
                    .map(|_| LosslessString::from("coordinator")),
            )
            .optional(
                "coordinatorSessionID",
                &assessment
                    .coordination
                    .map(|source| source.coordinator_session_id.clone()),
            )
            .optional(
                "groupID",
                &assessment
                    .coordination
                    .and_then(|source| source.group_id.clone()),
            )
            .optional(
                "rationale",
                &assessment
                    .coordination
                    .map(|source| source.rationale.clone()),
            )
            .finish();
        let event = ycoding_store::session::NewEvent {
            id: crate::session::projector::random_event_id()?
                .as_lossless()
                .clone(),
            aggregate_id: request.session_id.as_lossless().clone(),
            created: now(),
            type_: "session.permission.assessed.1".into(),
            data,
        };
        self.0
            .authority
            .store
            .submit(move |tx| crate::session::projector::append(tx, &event).map(|_| ()))
            .and_then(|receipt| receipt.wait())?;
        Ok(())
    }

    pub fn reply(
        &self,
        id: &permission::Id,
        reply: permission::Reply,
        message: Option<LosslessString>,
    ) -> Result<(), Error> {
        let mut pending = self
            .0
            .pending
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let item = pending.get(id).ok_or(Error::NotFound)?;
        if reply.0.as_str() != Some("reject") {
            self.recheck(&item.request, item.agent.as_ref())?;
        }
        let session_id = item.request.session_id.clone();
        state::emit::<permission::Replied>(
            &self.0.publish,
            &permission::RepliedData {
                session_id: session_id.clone(),
                request_id: id.clone(),
                reply: reply.clone(),
            },
        )
        .map_err(Error::Publish)?;
        if let Some(text) = reply.0.as_str() {
            self.record_reply(&item.request, text);
        }
        let always = reply.0.as_str() == Some("always");
        if always && let Some(save) = &item.request.save {
            self.0
                .saved
                .add(&self.0.project, &item.request.action, save)?;
        }
        let saved = if always
            && item
                .request
                .save
                .as_ref()
                .is_some_and(|save| !save.is_empty())
        {
            Some(self.0.saved.rules(&self.0.project)?)
        } else {
            None
        };
        let item = pending.remove(id).expect("pending request held by lock");
        let reject = reply.0.as_str() == Some("reject");
        let result = if reject {
            Err(message
                .filter(|message| !message.is_empty())
                .map_or(Error::Declined, Error::Corrected))
        } else {
            self.recheck(&item.request, item.agent.as_ref())
        };
        let _ = item.sender.send(result);
        let ids = pending
            .iter()
            .filter_map(|(id, item)| {
                if reject {
                    return (item.request.session_id == session_id).then(|| id.clone());
                }
                let saved = saved.as_ref()?;
                let authority = self.configured(&item.request, item.agent.as_ref()).ok()?;
                (decision(
                    &item.request.action,
                    &item.request.resources,
                    &authority.configured,
                    saved,
                ) == Effect::Allow)
                    .then(|| id.clone())
            })
            .collect::<Vec<_>>();
        for id in ids {
            let item = pending.get(&id).expect("collected pending ID");
            state::emit::<permission::Replied>(
                &self.0.publish,
                &permission::RepliedData {
                    session_id: item.request.session_id.clone(),
                    request_id: id.clone(),
                    reply: permission::Reply(if reject { "reject" } else { "always" }.into()),
                },
            )
            .map_err(Error::Publish)?;
            let item = pending.remove(&id).expect("pending request held by lock");
            let result = if reject {
                Err(Error::Declined)
            } else {
                self.recheck(&item.request, item.agent.as_ref())
            };
            let _ = item.sender.send(result);
        }
        Ok(())
    }

    pub fn reject(
        &self,
        id: &permission::Id,
        message: Option<LosslessString>,
    ) -> Result<(), Error> {
        let mut pending = self
            .0
            .pending
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let item = pending.get(id).ok_or(Error::NotFound)?;
        state::emit::<permission::Replied>(
            &self.0.publish,
            &permission::RepliedData {
                session_id: item.request.session_id.clone(),
                request_id: id.clone(),
                reply: permission::Reply("reject".into()),
            },
        )
        .map_err(Error::Publish)?;
        self.record_reply(&item.request, "reject");
        let item = pending.remove(id).expect("pending request held by lock");
        let _ = item.sender.send(Err(message
            .filter(|message| !message.is_empty())
            .map_or(Error::Declined, Error::Corrected)));
        Ok(())
    }

    pub fn agent_selected(&self, session: &SessionId, agent: &LosslessString) -> Result<(), Error> {
        let ids = self
            .0
            .pending
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .iter()
            .filter(|(_, item)| {
                &item.request.session_id == session && item.agent.as_ref() != Some(agent)
            })
            .map(|(id, _)| id.clone())
            .collect::<Vec<_>>();
        for id in ids {
            let mut pending = self
                .0
                .pending
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            let Some(item) = pending.get(&id) else {
                continue;
            };
            state::emit::<permission::Replied>(
                &self.0.publish,
                &permission::RepliedData {
                    session_id: item.request.session_id.clone(),
                    request_id: id.clone(),
                    reply: permission::Reply("reject".into()),
                },
            )
            .map_err(Error::Publish)?;
            if let Some(item) = pending.remove(&id) {
                let _ = item.sender.send(Err(Error::Declined));
            }
        }
        Ok(())
    }

    fn fingerprint_of(&self, request: &permission::Request) -> LosslessString {
        fingerprint(request, &self.workdir()).as_lossless().clone()
    }
    pub fn snapshot(&self, id: &permission::Id) -> Option<Snapshot<permission::Request>> {
        self.0
            .pending
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .get(id)
            .map(|item| Snapshot {
                order: item.order,
                fingerprint: self.fingerprint_of(&item.request),
                request: item.request.clone(),
            })
    }
    pub fn snapshots(
        &self,
        session: &SessionId,
        limit: usize,
    ) -> Vec<Snapshot<permission::Request>> {
        self.snapshots_in(std::slice::from_ref(session), limit)
    }
    pub fn snapshots_in(
        &self,
        sessions: &[SessionId],
        limit: usize,
    ) -> Vec<Snapshot<permission::Request>> {
        let mut snapshots = self
            .0
            .pending
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .values()
            .filter(|item| sessions.contains(&item.request.session_id))
            .map(|item| Snapshot {
                order: item.order,
                fingerprint: self.fingerprint_of(&item.request),
                request: item.request.clone(),
            })
            .collect::<Vec<_>>();
        snapshots.sort_by_key(|snapshot| snapshot.order);
        snapshots.truncate(limit);
        snapshots
    }
    pub async fn reconsider(
        &self,
        id: &permission::Id,
        input: Reconsider<permission::Request>,
    ) -> Result<Reconsidered, CoordError> {
        let fingerprint = &input.fingerprint;
        let stale = Reconsidered::stale(fingerprint);
        let (request, agent, order) = {
            let pending = self
                .0
                .pending
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            let Some(item) = pending
                .get(id)
                .filter(|item| &self.fingerprint_of(&item.request) == fingerprint)
            else {
                return Ok(stale);
            };
            (item.request.clone(), item.agent.clone(), item.order)
        };
        let Some(_claim) = Claim::acquire(&self.0.reconsidering, id.clone()) else {
            return Ok(Reconsidered::escalated(
                fingerprint,
                "native-assessment-in-progress",
            ));
        };
        let authority = match self.configured(&request, agent.as_ref()) {
            Ok(authority) => authority,
            Err(Error::Authority(state::Error::NotFound(_))) => return Ok(stale),
            Err(error) => return Err(coordination_error(error)),
        };
        if authority.autonomy.can_yolo_permission()
            && !self
                .coordinator_denied(&request)
                .map_err(coordination_error)?
        {
            self.reconcile_autonomy(&request.session_id)
                .map_err(coordination_error)?;
            return Ok(Reconsidered::settled(
                fingerprint,
                DecisionOutcome::Allowed,
                "yolo",
            ));
        }
        if !(input.gate.validate)(request.clone()).await {
            return Ok(Reconsidered::escalated(fingerprint, "delegation-invalid"));
        }
        let explicit = request
            .metadata
            .as_ref()
            .and_then(|metadata| metadata.get(&"requireExplicitDecision".into()))
            == Some(&ycoding_schema::JsonValue::Bool(true));
        if input.decision == Some(Decision::Decline) {
            let rationale = input.source.rationale.clone();
            return self
                .settle(id, order, &input, move |_, _, _| {
                    Ok(Verdict::Settle {
                        outcome: DecisionOutcome::Denied,
                        via: "coordination",
                        assessed_via: "coordination",
                        reply: "reject",
                        error: Some(Error::Corrected(coordination_decline_feedback(
                            false, &rationale,
                        ))),
                        provenance: None,
                    })
                })
                .await;
        }
        let initial = self
            .rule_effect(&request, &authority)
            .map_err(coordination_error)?;
        if initial != Effect::Ask {
            return self
                .settle(id, order, &input, |effect, _, _| {
                    Ok(match effect {
                        Effect::Ask => Verdict::Escalate("permission-ask"),
                        Effect::Allow => Verdict::rules(true),
                        Effect::Deny => Verdict::rules(false),
                    })
                })
                .await;
        }
        if explicit {
            return Ok(Reconsidered::escalated(
                fingerprint,
                "explicit-decision:request",
            ));
        }
        if input.decision == Some(Decision::Approve) {
            return self
                .settle(id, order, &input, |effect, _, _| {
                    Ok(match effect {
                        Effect::Deny => Verdict::rules(false),
                        Effect::Allow => Verdict::rules(true),
                        Effect::Ask => Verdict::Settle {
                            outcome: DecisionOutcome::Allowed,
                            via: "coordination",
                            assessed_via: "coordination",
                            reply: "once",
                            error: None,
                            provenance: None,
                        },
                    })
                })
                .await;
        }
        if !authority.autonomy.can_auto_permission() {
            return Ok(Reconsidered::escalated(
                fingerprint,
                "native-assessment-unavailable",
            ));
        }
        let service = self.clone();
        self.settle(id, order, &input, move |effect, current, authority| {
            Ok(match effect {
                Effect::Deny => Verdict::rules(false),
                Effect::Ask if service.applicability(current, authority, false)?.rejected() => {
                    Verdict::Escalate("explicit-rejected")
                }
                Effect::Allow => Verdict::rules(true),
                Effect::Ask => Verdict::Settle {
                    outcome: DecisionOutcome::Allowed,
                    via: "auto-permission",
                    assessed_via: "auto-permission",
                    reply: "once",
                    error: None,
                    provenance: None,
                },
            })
        })
        .await
    }
    async fn settle(
        &self,
        id: &permission::Id,
        order: u64,
        input: &Reconsider<permission::Request>,
        decide: impl FnOnce(
            Effect,
            &permission::Request,
            &SessionAuthority,
        ) -> Result<Verdict, CoordError>,
    ) -> Result<Reconsidered, CoordError> {
        let fingerprint = &input.fingerprint;
        let candidate = self
            .snapshot(id)
            .filter(|snapshot| snapshot.order == order && &snapshot.fingerprint == fingerprint);
        let Some(candidate) = candidate else {
            return Ok(Reconsidered::stale(fingerprint));
        };
        if !(input.gate.validate)(candidate.request).await {
            return Ok(Reconsidered::escalated(fingerprint, "delegation-invalid"));
        }
        let mut pending = self
            .0
            .pending
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let Some(item) = pending.get(id).filter(|item| {
            item.order == order && &self.fingerprint_of(&item.request) == fingerprint
        }) else {
            return Ok(Reconsidered::stale(fingerprint));
        };
        if !(input.gate.current)() {
            return Ok(Reconsidered::escalated(fingerprint, "delegation-invalid"));
        }
        let request = item.request.clone();
        let authority = self
            .configured(&request, item.agent.as_ref())
            .map_err(coordination_error)?;
        let effect = self
            .rule_effect(&request, &authority)
            .map_err(coordination_error)?;
        if effect == Effect::Ask
            && input.decision != Some(Decision::Decline)
            && request
                .metadata
                .as_ref()
                .and_then(|metadata| metadata.get(&"requireExplicitDecision".into()))
                == Some(&JsonValue::Bool(true))
        {
            return Ok(Reconsidered::escalated(
                fingerprint,
                "explicit-decision:request",
            ));
        }
        let (outcome, via, assessed_via, reply, error, provenance) =
            match decide(effect, &request, &authority)? {
                Verdict::Escalate(reason) => {
                    return Ok(Reconsidered::escalated(fingerprint, reason));
                }
                Verdict::Settle {
                    outcome,
                    via,
                    assessed_via,
                    reply,
                    error,
                    provenance,
                } => (outcome, via, assessed_via, reply, error, provenance),
            };
        self.assessed(
            &request,
            Assessment {
                outcome: if reply == "once" { "allow" } else { "deny" },
                via: assessed_via,
                reply: Some(reply),
                escalation: provenance.as_ref(),
                coordination: Some(&input.source),
            },
        )
        .map_err(coordination_error)?;
        state::emit::<permission::Replied>(
            &self.0.publish,
            &permission::RepliedData {
                session_id: request.session_id.clone(),
                request_id: id.clone(),
                reply: permission::Reply(reply.into()),
            },
        )
        .map_err(CoordError::refused)?;
        if reply == "once" {
            self.record_approval(&request, reply);
        }
        let item = pending.remove(id).expect("pending request held by lock");
        let result = match error {
            Some(error) => Err(error),
            None => self.recheck(&item.request, item.agent.as_ref()),
        };
        let _ = item.sender.send(result);
        Ok(Reconsidered::settled(fingerprint, outcome, via))
    }
    pub fn escalate(
        &self,
        id: &permission::Id,
        input: EscalateRequest,
    ) -> Result<Escalated, CoordError> {
        let mut pending = self
            .0
            .pending
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let Some(item) = pending.get_mut(id) else {
            drop(pending);
            return Ok(self
                .0
                .reviews
                .get()
                .and_then(|(reviews, _)| {
                    deferred_review(reviews, &input.session_id, |payload| match payload {
                        session_review::Payload::Permission(payload)
                            if &payload.request_id == id
                                && payload.fingerprint.as_lossless() == &input.fingerprint =>
                        {
                            Some(payload.coordination_escalation.clone())
                        }
                        _ => None,
                    })
                })
                .unwrap_or_else(Escalated::stale));
        };
        if item.request.session_id != input.session_id
            || self.fingerprint_of(&item.request) != input.fingerprint
            || !(input.current)()
        {
            return Ok(Escalated::stale());
        }
        let appended = append(item.request.coordination_escalation.as_ref(), &input.source);
        let Appended::Added(value) = &appended else {
            return Ok(Escalated::appended(appended));
        };
        let value = value.clone();
        item.request.coordination_escalation = Some(value.clone());
        let request = item.request.clone();
        state::emit::<ycoding_schema::coordination::event::RequestEscalated>(
            &self.0.publish,
            &ycoding_schema::coordination::RequestEscalatedData {
                session_id: request.session_id.clone(),
                root_session_id: None,
                kind: ycoding_schema::coordination::RequestKind::Permission,
                request_id: id_text(id),
                coordination_escalation: value,
            },
        )
        .map_err(CoordError::refused)?;
        if input.handoff {
            self.assessed(
                &request,
                Assessment {
                    outcome: "escalate",
                    via: "coordination",
                    reply: None,
                    escalation: Some(&ycoding_schema::guardrail::Escalation {
                        authority: None,
                        reason: Some(ycoding_schema::guardrail::EscalationReason::Escalated),
                        choice: None,
                        confidence: None,
                        grades: None,
                    }),
                    coordination: Some(&input.source),
                },
            )
            .map_err(coordination_error)?;
        }
        Ok(Escalated::appended(appended))
    }

    pub fn list(&self) -> Vec<permission::Request> {
        self.list_ordered()
            .into_iter()
            .map(|(_, request)| request)
            .collect()
    }
    pub fn list_ordered(&self) -> Vec<(u64, permission::Request)> {
        let mut pending = self
            .0
            .pending
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .values()
            .map(|item| (item.order, item.request.clone()))
            .collect::<Vec<_>>();
        pending.sort_by_key(|(order, _)| *order);
        pending
    }
    pub fn for_session(&self, session: &SessionId) -> Vec<permission::Request> {
        self.list()
            .into_iter()
            .filter(|request| &request.session_id == session)
            .collect()
    }
    pub fn get(&self, id: &permission::Id) -> Option<permission::Request> {
        self.0
            .pending
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .get(id)
            .map(|item| item.request.clone())
    }
    pub fn cancel(&self, id: &permission::Id) {
        let item = self
            .0
            .pending
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .remove(id);
        if let Some(item) = item {
            let _ = state::emit::<permission::Cancelled>(
                &self.0.publish,
                &permission::CancelledData {
                    session_id: item.request.session_id.clone(),
                    request_id: item.request.id.clone(),
                },
            );
            let _ = item.sender.send(Err(Error::Declined));
        }
    }
    pub fn shutdown(&self) {
        let pending = {
            let mut pending = self
                .0
                .pending
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            std::mem::take(&mut *pending)
        };
        for (_, item) in pending {
            let _ = state::emit::<permission::Cancelled>(
                &self.0.publish,
                &permission::CancelledData {
                    session_id: item.request.session_id.clone(),
                    request_id: item.request.id.clone(),
                },
            );
            let _ = item.sender.send(Err(Error::Declined));
        }
    }
}

fn fingerprint(
    request: &permission::Request,
    workdir: &LosslessString,
) -> session_review::Fingerprint {
    review::fingerprint(&FingerprintInput {
        action: request.action.clone(),
        resources: request.resources.clone(),
        workdir: workdir.clone(),
        rule_ids: vec![],
        hard_review: false,
        metadata: request.metadata.clone(),
    })
}

fn admission_fingerprint(
    request: &permission::Request,
    workdir: &LosslessString,
    deferred: bool,
) -> session_review::Fingerprint {
    if !deferred {
        return fingerprint(request, workdir);
    }
    review::deferred_fingerprint(&FingerprintInput {
        action: request.action.clone(),
        resources: request.resources.clone(),
        workdir: workdir.clone(),
        rule_ids: vec![],
        hard_review: false,
        metadata: request.metadata.clone(),
    })
}

fn defer_explicit(
    reviews: &Reviews,
    request: &permission::Request,
    workdir: &LosslessString,
) -> Error {
    let outcome = reviews.service.defer_open_now(review::OpenInput {
        session_id: request.session_id.clone(),
        kind: session_review::Kind::Permission,
        reason: request
            .escalation
            .as_ref()
            .and_then(|value| value.reason)
            .map_or(session_review::Reason::Disabled, review_reason),
        choice: request
            .escalation
            .as_ref()
            .and_then(|value| value.choice)
            .map(|value| match value.encode() {
                JsonValue::String(value) => value,
                _ => unreachable!("choice is text"),
            }),
        confidence: request
            .escalation
            .as_ref()
            .and_then(|value| value.confidence),
        grades: request
            .escalation
            .as_ref()
            .and_then(|value| value.grades.clone()),
        origin: session_review::Origin::Request {
            request_id: request.id.as_lossless().clone(),
            executor: true,
        },
        payload: session_review::Payload::Permission(session_review::PermissionPayload {
            action: redacted(&request.action),
            resources: request.resources.iter().map(redacted).collect(),
            save: request.save.clone().filter(|save| !save.is_empty()),
            fingerprint: admission_fingerprint(request, workdir, true),
            fingerprint_version: session_review::FingerprintVersion::V2,
            request_id: request.id.clone(),
            coordination_escalation: crate::process::guardrails::redacted_escalation(
                request.coordination_escalation.as_ref(),
            ),
        }),
        limit: reviews.limit,
        conversion: false,
        created: now(),
    });
    match outcome {
        Ok(outcome) => Error::DeferredReview(Box::new(DeferredReview {
            request_id: request.id.clone(),
            session_id: request.session_id.clone(),
            outcome,
            action: request.action.clone(),
            resources: request.resources.iter().map(redacted).collect(),
        })),
        Err(error) => Error::Review(error),
    }
}

fn redacted(value: &LosslessString) -> LosslessString {
    match crate::process::guardrails::redact_value(&JsonValue::String(value.clone())) {
        JsonValue::String(value) => value,
        _ => unreachable!("redacted text"),
    }
}

async fn defer(
    publish: &Publisher,
    reviews: &Reviews,
    request: &permission::Request,
    fingerprint: session_review::Fingerprint,
    reason: session_review::Reason,
    conversion: bool,
) -> Result<(), Error> {
    let origin = request
        .source
        .as_ref()
        .and_then(|source| {
            session_review::Origin::decode(
                &ObjectEncoder::new()
                    .field("messageID", &source.message_id)
                    .field("callID", &source.call_id)
                    .finish(),
            )
            .ok()
        })
        .unwrap_or_else(|| super::request_origin(&request.id));
    let item_id = match reviews
        .defer(
            &request.session_id,
            session_review::Kind::Permission,
            reason,
            origin,
            session_review::Payload::Permission(session_review::PermissionPayload {
                action: request.action.clone(),
                resources: request.resources.clone(),
                save: request.save.clone().filter(|save| !save.is_empty()),
                fingerprint,
                fingerprint_version: session_review::FingerprintVersion::V2,
                request_id: request.id.clone(),
                coordination_escalation: crate::process::guardrails::redacted_escalation(
                    request.coordination_escalation.as_ref(),
                ),
            }),
            conversion,
        )
        .await
    {
        Ok(item_id) => item_id,
        Err(review::Error::Full { limit, .. }) => return Err(Error::ReviewFull { limit }),
        Err(error) => return Err(Error::Review(error)),
    };
    state::emit::<permission::Deferred>(
        publish,
        &permission::DeferredData {
            session_id: request.session_id.clone(),
            request_id: request.id.clone(),
            item_id: item_id.clone(),
        },
    )
    .map_err(Error::Publish)?;
    Err(Error::Deferred { item_id })
}

fn call_key(session: &SessionId, message: &LosslessString, call: &LosslessString) -> String {
    let text =
        |value: &LosslessString| String::from_utf16_lossy(&value.code_units().collect::<Vec<_>>());
    format!(
        "{}\0{}\0{}",
        text(session.as_lossless()),
        text(message),
        text(call)
    )
}

fn assessment_key(
    request: &permission::Request,
    workdir: &LosslessString,
    deferred: bool,
) -> String {
    format!(
        "{}\0{}",
        ycoding_schema::stringify_json(&admission_fingerprint(request, workdir, deferred).encode()),
        request
            .source
            .as_ref()
            .map(|source| format!(
                "{}\0{}",
                source.message_id.to_utf8().unwrap_or_default(),
                source.call_id.to_utf8().unwrap_or_default()
            ))
            .unwrap_or_default()
    )
}

fn evidence(request: &permission::Request, workdir: &LosslessString) -> JsonValue {
    let bounded = |value: &LosslessString, limit: usize| {
        LosslessString::from_utf16(value.code_units().take(limit).collect())
    };
    ObjectEncoder::new()
        .field("action", &request.action)
        .field(
            "resources",
            &request
                .resources
                .iter()
                .take(20)
                .map(|resource| bounded(resource, 1000))
                .collect::<Vec<_>>(),
        )
        .optional(
            "save",
            &request.save.as_ref().map(|save| {
                save.iter()
                    .take(20)
                    .map(|resource| bounded(resource, 1000))
                    .collect::<Vec<_>>()
            }),
        )
        .optional(
            "metadata",
            &request.metadata.as_ref().map(|metadata| {
                let mut kept = ycoding_schema::JsonObject::new();
                for (key, value) in metadata.iter() {
                    let value = match value {
                        JsonValue::String(text) => JsonValue::String(bounded(text, 500)),
                        JsonValue::Bool(_) | JsonValue::Number(_) => value.clone(),
                        _ => continue,
                    };
                    kept.insert(key.clone(), value);
                }
                JsonValue::Object(kept)
            }),
        )
        .field("workdir", workdir)
        .finish()
}

fn historical_fingerprint(
    request: &permission::Request,
    workdir: &LosslessString,
) -> Option<LosslessString> {
    let metadata = request.metadata.as_ref()?;
    if metadata.get(&"requireExplicitDecision".into()) != Some(&JsonValue::Bool(true)) {
        return None;
    }
    let mut kept = ycoding_schema::JsonObject::new();
    for (key, value) in metadata.iter() {
        if key.as_str() != Some("requireExplicitDecision") {
            kept.insert(key.clone(), value.clone());
        }
    }
    kept.insert("requireHuman".into(), JsonValue::Bool(true));
    Some(
        review::fingerprint(&FingerprintInput {
            action: request.action.clone(),
            resources: request.resources.clone(),
            workdir: workdir.clone(),
            rule_ids: vec![],
            hard_review: false,
            metadata: Some(kept),
        })
        .as_lossless()
        .clone(),
    )
}

enum Verdict {
    Escalate(&'static str),
    Settle {
        outcome: DecisionOutcome,
        via: &'static str,
        assessed_via: &'static str,
        reply: &'static str,
        error: Option<Error>,
        provenance: Option<guardrail::Escalation>,
    },
}

impl Verdict {
    fn rules(allow: bool) -> Self {
        Self::Settle {
            outcome: if allow {
                DecisionOutcome::Allowed
            } else {
                DecisionOutcome::Denied
            },
            via: "permission-rules",
            assessed_via: "coordination",
            reply: if allow { "once" } else { "reject" },
            error: (!allow).then_some(Error::Declined),
            provenance: None,
        }
    }
}

fn admission_error(error: CoordError) -> Error {
    match error {
        CoordError::Store(error) => Error::Store(error),
        other => Error::Publish(other.to_string()),
    }
}

fn coordination_error(error: Error) -> CoordError {
    match error {
        Error::Store(error) => CoordError::Store(error),
        other => CoordError::refused(format!("{other:?}")),
    }
}

struct Assessment<'a> {
    outcome: &'static str,
    via: &'static str,
    reply: Option<&'static str>,
    escalation: Option<&'a ycoding_schema::guardrail::Escalation>,
    coordination: Option<&'a Source>,
}

fn via(authority: Option<ycoding_schema::guardrail::Authority>) -> &'static str {
    match authority {
        Some(ycoding_schema::guardrail::Authority::Yolo) => "yolo",
        _ => "baseline",
    }
}

fn review_reason(reason: ycoding_schema::guardrail::EscalationReason) -> session_review::Reason {
    use ycoding_schema::guardrail::EscalationReason as From;
    match reason {
        From::Unavailable => session_review::Reason::Unavailable,
        From::InvalidRequest => session_review::Reason::InvalidRequest,
        From::ProviderFailed => session_review::Reason::ProviderFailed,
        From::Timeout => session_review::Reason::Timeout,
        From::InputTooLarge => session_review::Reason::InputTooLarge,
        From::InvalidOutput => session_review::Reason::InvalidOutput,
        From::Refused => session_review::Reason::Refused,
        From::TruncatedOutput => session_review::Reason::TruncatedOutput,
        From::UnsupportedOutput => session_review::Reason::UnsupportedOutput,
        From::Escalated => session_review::Reason::Escalated,
        From::LowConfidence => session_review::Reason::LowConfidence,
        From::ConflictingGrades => session_review::Reason::ConflictingGrades,
    }
}

fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock after epoch")
        .as_millis() as i64
}
