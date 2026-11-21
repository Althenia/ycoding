use super::value::{JsonObject, LosslessString, concat, join, os_text};
use std::{fmt, future::Future, pin::Pin, sync::Arc};
use tokio::sync::Mutex;

pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

pub const BUSY_TEXT: &str =
    "YCoding did not run this: YCoding is busy; retry the identical action.";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ExecutorError {
    pub code: i32,
    pub message: LosslessString,
    pub refusal: Option<LosslessString>,
}
impl ExecutorError {
    pub fn new(code: i32, message: impl Into<LosslessString>) -> Self {
        Self {
            code,
            message: message.into(),
            refusal: None,
        }
    }
    pub fn refusal(text: LosslessString) -> Self {
        Self {
            code: -32600,
            message: concat(&[&"Permission denied: ".into(), &text]),
            refusal: Some(text),
        }
    }
    pub fn permission_denied() -> Self {
        Self::new(-32001, "Permission denied")
    }
    pub fn internal() -> Self {
        Self::new(-32603, "Internal error")
    }
    pub fn session_closed() -> Self {
        Self::new(-32603, "Executor session closed")
    }
    pub fn invalid_params(message: impl Into<LosslessString>) -> Self {
        Self::new(-32602, message)
    }
    pub fn not_found() -> Self {
        Self::new(-32004, "No such file or directory (os error 2)")
    }
}
impl fmt::Display for ExecutorError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{} ({})", os_text(&self.message), self.code)
    }
}
impl std::error::Error for ExecutorError {}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DecisionKind {
    Permission,
    Guardrail,
}
impl DecisionKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Permission => "permission",
            Self::Guardrail => "guardrail",
        }
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DecisionReply {
    Allow,
    Once,
    Always,
    Reject,
    Expired,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DecisionBy {
    Rule,
    User,
    Auto,
    Yolo,
    Expired,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DecisionStep {
    pub kind: DecisionKind,
    pub request_id: Option<String>,
    pub reply: DecisionReply,
    pub by: DecisionBy,
}
pub type DecisionTrace = Vec<DecisionStep>;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PendingState {
    Open,
    Rejected,
    Full,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PendingDecision {
    pub kind: DecisionKind,
    pub session_id: String,
    pub item_id: Option<String>,
    pub action: String,
    pub resources: Vec<LosslessString>,
    pub hard_review: bool,
    pub state: PendingState,
    pub directories: Vec<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct AuthorizationDenied {
    pub trace: DecisionTrace,
    pub pending: Vec<PendingDecision>,
    pub busy: bool,
}
impl AuthorizationDenied {
    pub fn refusal_text(&self) -> Option<LosslessString> {
        refusal_text(&self.pending, self.busy)
    }
}

pub fn refusal_text(pending: &[PendingDecision], busy: bool) -> Option<LosslessString> {
    if pending.is_empty() {
        return busy.then(|| BUSY_TEXT.into());
    }
    if let Some(rejected) = pending
        .iter()
        .find(|item| item.state == PendingState::Rejected && item.item_id.is_some())
    {
        return Some(
            format!(
                "YCoding did not run this: the user rejected review item {}. Do not retry it.",
                rejected.item_id.as_deref().unwrap_or_default()
            )
            .into(),
        );
    }
    if pending.iter().any(|item| item.state == PendingState::Full) {
        return Some("YCoding did not run this: the review box is full. Run ycoding decision list and decide or clear items first.".into());
    }
    let open = pending
        .iter()
        .filter(|item| item.state == PendingState::Open && item.item_id.is_some())
        .collect::<Vec<_>>();
    if open.is_empty() {
        return None;
    }
    let mut lines = vec![LosslessString::from(
        "YCoding did not run this: it needs the user's decision.",
    )];
    for item in &open {
        lines.push(concat(&[
            &format!(
                "Review item {} in Session {}: {} {} ",
                item.item_id.as_deref().unwrap_or_default(),
                item.session_id,
                item.kind.as_str(),
                item.action,
            )
            .into(),
            &join(&item.resources, " "),
            &".".into(),
        ]));
    }
    lines.push(
        "Ask the user in this chat, record the answer, then retry the identical action.".into(),
    );
    for item in &open {
        let decide = |reply: &str| {
            format!(
                "ycoding api session.review.decide --param sessionID={} --param itemID={} -d '{{\"decision\":{{\"kind\":\"{}\",\"reply\":\"{}\"}}}}'",
                item.session_id,
                item.item_id.as_deref().unwrap_or_default(),
                item.kind.as_str(),
                reply
            )
        };
        lines.push(format!(" approve once:   {}", decide("once")).into());
        let remembered = !item.hard_review
            && (item.kind == DecisionKind::Permission || !item.directories.is_empty());
        if remembered {
            lines.push(format!(" approve always: {}", decide("always")).into());
        }
        lines.push(format!(" reject:         {}", decide("reject")).into());
    }
    Some(join(&lines, "\n"))
}

#[derive(Clone, Debug, PartialEq)]
pub struct AuthorizationInput {
    pub action: String,
    pub guardrail_action: Option<String>,
    pub resources: Vec<LosslessString>,
    pub metadata: Option<JsonObject>,
}
impl AuthorizationInput {
    pub fn new(action: &str, resources: Vec<LosslessString>) -> Self {
        Self {
            action: action.to_owned(),
            guardrail_action: None,
            resources,
            metadata: None,
        }
    }
    pub fn with_metadata(mut self, metadata: JsonObject) -> Self {
        self.metadata = Some(metadata);
        self
    }
}

type ReleaseFn = Box<dyn FnOnce() -> BoxFuture<'static, Result<(), ()>> + Send>;

pub struct Grant {
    release: Mutex<Option<ReleaseFn>>,
    pub trace: DecisionTrace,
}
impl Grant {
    pub fn new(
        trace: DecisionTrace,
        release: impl FnOnce() -> BoxFuture<'static, Result<(), ()>> + Send + 'static,
    ) -> Self {
        Self {
            release: Mutex::new(Some(Box::new(release))),
            trace,
        }
    }
    pub fn noop() -> Self {
        Self {
            release: Mutex::new(None),
            trace: vec![],
        }
    }
    pub async fn release(&self) -> Result<(), ExecutorError> {
        let release = self.release.lock().await.take();
        match release {
            Some(release) => release().await.map_err(|_| ExecutorError::internal()),
            None => Ok(()),
        }
    }
    pub fn combine(first: Option<Grant>, second: Grant) -> Grant {
        let Some(first) = first else {
            return second;
        };
        let trace = second.trace.clone();
        Grant::new(trace, move || {
            Box::pin(async move {
                let later = second.release().await;
                let earlier = first.release().await;
                if later.is_err() || earlier.is_err() {
                    Err(())
                } else {
                    Ok(())
                }
            })
        })
    }
}

pub trait Authorize: Send + Sync {
    fn authorize(
        &self,
        input: AuthorizationInput,
    ) -> BoxFuture<'static, Result<Grant, AuthorizationDenied>>;
    fn defers(&self) -> bool {
        false
    }
    fn close(&self) -> BoxFuture<'static, Result<(), ExecutorError>> {
        Box::pin(async { Ok(()) })
    }
}

pub type AuthorizeFn = Arc<
    dyn Fn(AuthorizationInput) -> BoxFuture<'static, Result<Grant, AuthorizationDenied>>
        + Send
        + Sync,
>;

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Attribution {
    pub thread_id: Option<LosslessString>,
    pub tool_call_id: Option<LosslessString>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ScopeContext {
    pub session_id: String,
    pub cwd: Option<String>,
}

pub async fn run_with_grant<T>(
    grant: Grant,
    work: impl Future<Output = Result<T, ExecutorError>>,
) -> Result<T, ExecutorError> {
    let outcome = work.await;
    let released = grant.release().await;
    match outcome {
        Err(error) => Err(error),
        Ok(value) => released
            .map(|_| value)
            .map_err(|_| ExecutorError::internal()),
    }
}
