use crate::session::{
    compaction_job::{AdmitInput, CompactionError},
    compaction_policy::Resolved,
    context_pressure::{self, Capabilities, Level, Usage},
    store,
};
use std::{collections::BTreeMap, sync::Mutex};
use ycoding_ai::llm::Request;
use ycoding_schema::{agent, session, session_compaction};
use ycoding_store::session::Job;

pub struct Advisor {
    pub store: store::Service,
    pub policy: Resolved,
    pressure: Mutex<BTreeMap<session::Id, Level>>,
}
pub struct Context<'a> {
    pub session: &'a session::Id,
    pub agent: &'a agent::Id,
    pub capabilities: Option<Capabilities>,
    pub request: &'a Request,
}
impl Advisor {
    pub fn new(store: store::Service, policy: Resolved) -> Self {
        Self {
            store,
            policy,
            pressure: Mutex::default(),
        }
    }
    pub async fn observe(
        &self,
        context: Context<'_>,
        admission: impl FnOnce(session_compaction::Trigger, i64) -> Result<AdmitInput, CompactionError>,
    ) -> Result<Option<Job>, CompactionError> {
        if context.agent.as_str() == Some("compaction") {
            return Ok(None);
        }
        let estimate = context_pressure::estimated_input_tokens(Usage {
            system: &context.request.system,
            tools: &context.request.tools,
            messages: &context.request.messages,
        });
        let level = context
            .capabilities
            .as_ref()
            .map(|capabilities| context_pressure::level(capabilities, &self.policy, estimate));
        let previous = {
            let mut pressure = self
                .pressure
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if level.is_none() || level == Some(Level::Normal) {
                pressure.remove(context.session);
                return Ok(None);
            }
            let level = level.expect("normal and absent pressure handled");
            let previous = pressure.get(context.session).copied();
            if level == Level::Mandatory {
                pressure.insert(context.session.clone(), level);
                return Ok(None);
            }
            if previous.is_some_and(|previous| rank(previous) >= rank(level)) {
                return Ok(None);
            }
            pressure.insert(context.session.clone(), level);
            previous
        };
        let level = level.expect("absent pressure handled");
        let scheduled = match admission(
            if level == Level::Consider {
                session_compaction::Trigger::Consider
            } else {
                session_compaction::Trigger::Advised
            },
            estimate,
        ) {
            Ok(admission) => {
                self.store
                    .compaction_admit(admission, chrono::Utc::now().timestamp_millis())
                    .await
            }
            Err(error) => Err(error),
        };
        if scheduled.is_err() {
            let mut pressure = self
                .pressure
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if pressure.get(context.session) == Some(&level) {
                match previous {
                    Some(previous) => {
                        pressure.insert(context.session.clone(), previous);
                    }
                    None => {
                        pressure.remove(context.session);
                    }
                }
            }
        }
        scheduled.map(Some)
    }
}
fn rank(level: Level) -> u8 {
    match level {
        Level::Normal => 0,
        Level::Consider => 1,
        Level::Advised => 2,
        Level::Mandatory => 3,
    }
}
