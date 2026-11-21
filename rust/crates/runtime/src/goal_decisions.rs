use crate::locations::WeakLocations;
use std::sync::Arc;
use ycoding_core::{
    coordination::{decision_context, decisions::Settings},
    session::{
        autonomy,
        execution::Execution,
        goal::{self as goal_agent},
        goal_decisions::{
            self as goal, AuthorityProof, BoxFuture, GoalDecisions, Locate, Located, ProofFuture,
            Synthesize,
        },
        orchestration, store,
    },
    tools::code_mode::Cancellation,
    ycoding_schema::session,
    ycoding_store::Client,
};

pub(crate) struct Bindings {
    pub client: Client,
    pub autonomy: autonomy::Service,
    pub execution: &'static Execution,
    pub orchestration: orchestration::Service,
    pub locations: WeakLocations,
    pub settings: Settings,
}

pub(crate) fn bind(bindings: Bindings) -> GoalDecisions {
    GoalDecisions::new(goal::Options {
        proof: Arc::new(StoreProof(decision_context::Service::new(
            bindings.client.clone(),
        ))),
        synthesize: Arc::new(GoalAgent {
            locations: bindings.locations.clone(),
            sessions: store::Service::new(bindings.client.clone()),
        }),
        client: bindings.client,
        autonomy: bindings.autonomy,
        locate: locate(bindings.locations, bindings.execution),
        execution: Arc::new(LocalExecution(bindings.execution)),
        orchestration: bindings.orchestration,
        settings: bindings.settings,
        now: None,
    })
}

struct GoalAgent {
    locations: WeakLocations,
    sessions: store::Service,
}

impl Synthesize for GoalAgent {
    fn synthesize(
        &self,
        owner: &session::Id,
        prompt: String,
    ) -> BoxFuture<'_, Result<String, String>> {
        let owner = owner.clone();
        Box::pin(async move {
            let locations = self
                .locations
                .upgrade()
                .ok_or_else(|| "provider-failed".to_owned())?;
            let (session, _) = locations
                .session(&owner)
                .map_err(|_| "provider-failed".to_owned())?;
            let services = locations
                .location(
                    session.location.directory.as_lossless(),
                    session
                        .location
                        .workspace_id
                        .as_ref()
                        .map(|workspace| workspace.as_lossless()),
                )
                .map_err(|_| "provider-failed".to_owned())?;
            let composed = services
                .production
                .as_ref()
                .ok_or_else(|| "provider-failed".to_owned())?;
            let environment = goal_agent::Environment {
                location: session.location.clone(),
                agents: services.agents.clone(),
                generate: Arc::new(composed.runner.clone()),
            };
            let goals = goal_agent::Service::new(
                self.sessions.clone(),
                Arc::new(move |reference| {
                    (reference == &environment.location).then(|| environment.clone())
                }),
            );
            goals
                .synthesize(&session, &prompt, &Cancellation::default())
                .await
                .map_err(|error| {
                    match error {
                        goal_agent::Error::ModelUnavailable => "provider-failed",
                        goal_agent::Error::CalculationFailed | goal_agent::Error::Interrupted => {
                            "refused"
                        }
                    }
                    .to_owned()
                })
        })
    }
}

struct LocalExecution(&'static Execution);

impl goal::Execution for LocalExecution {
    fn active(&self) -> Vec<session::Id> {
        self.0.active()
    }

    fn wake(&self, id: &session::Id) -> Result<(), String> {
        self.0.wake(id).map_err(|error| error.to_string())
    }
}

struct StoreProof(decision_context::Service);

impl AuthorityProof for StoreProof {
    fn authority_digest(&self, session: &session::Id) -> ProofFuture<'_> {
        let context = self.0.clone();
        let session = session.clone();
        Box::pin(async move {
            tokio::task::spawn_blocking(move || context.authority_digest(&session))
                .await
                .map_err(|_| {
                    decision_context::Error::Store(ycoding_core::ycoding_store::Error::Rejected(
                        "Goal authority proof was interrupted",
                    ))
                })?
        })
    }
}

fn locate(locations: WeakLocations, execution: &'static Execution) -> Locate {
    Arc::new(
        move |id: session::Id| -> BoxFuture<'static, Option<Located>> {
            let locations = locations.clone();
            Box::pin(async move {
                let current = locations.upgrade()?;
                let (_, held) = current.session(&id).ok()?;
                if !current.is_current(&held) {
                    return None;
                }
                let pinned = held.clone();
                let weak = current.downgrade();
                let jobs = execution.jobs().clone();
                Some(Located {
                    permissions: Some(held.permissions.clone()),
                    guardrails: Some(held.guardrails.clone()),
                    forms: Some(held.forms.clone()),
                    questions: Some(held.questions.clone()),
                    shell_active: Some(Arc::new(move |id| {
                        jobs.outstanding_sessions().contains(id)
                    })),
                    lease: held,
                    is_current: Arc::new(move || {
                        weak.upgrade()
                            .is_some_and(|locations| locations.is_current(&pinned))
                    }),
                })
            })
        },
    )
}
