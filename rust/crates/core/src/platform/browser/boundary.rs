use super::bridge::{Bridge, safe_page};
use crate::platform::computer::{
    Future,
    boundary::{Context, Held, Permission, PermissionFailure, Policy, Review},
};
use std::sync::Arc;
use ycoding_schema::{
    DomainDecode, DomainEncode, JsonPath, JsonValue, LosslessString, ObjectDecoder, ObjectEncoder,
    browser, isolated_browser, parse_json, session_id::SessionId, stringify_json,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
    Owned,
    Profile,
    Isolated,
}
#[derive(Clone, Debug)]
pub struct Fence {
    pub tab: browser::TabId,
    pub generation: browser::Generation,
}
#[derive(Clone, Debug)]
pub enum Operation {
    Status,
    History {
        generation: browser::Generation,
        query: Option<LosslessString>,
        limit: Option<ycoding_schema::schema::PositiveInt>,
        start_time: Option<ycoding_schema::schema::NonNegativeInt>,
        end_time: Option<ycoding_schema::schema::NonNegativeInt>,
    },
    Tabs,
    Observe {
        fence: Fence,
        diff: Option<bool>,
        instance: Option<isolated_browser::InstanceId>,
    },
    Action {
        fence: Fence,
        document: browser::DocumentGeneration,
        revision: browser::ObservationRevision,
        instance: Option<isolated_browser::InstanceId>,
        action: browser::Action,
    },
    Control {
        resume: bool,
    },
    Stop,
    Open {
        generation: browser::Generation,
        url: LosslessString,
    },
    Close {
        fence: Fence,
    },
    Release {
        fence: Fence,
    },
    Deliver {
        fence: Fence,
    },
}
#[derive(Clone, Debug)]
pub struct Input {
    pub mode: Option<Mode>,
    pub operation: Operation,
}

pub trait Isolated: Send + Sync {
    fn action_identity(
        &self,
        input: &browser::ActionInput,
    ) -> Result<super::operation::Identity, String>;
    fn action_frame(&self, input: &browser::ActionInput) -> Result<Option<browser::Page>, String>;
    fn status<'a>(
        &'a self,
        session: &'a SessionId,
    ) -> Future<'a, Result<isolated_browser::Status, String>>;
    fn list<'a>(&'a self, session: &'a SessionId) -> Future<'a, Result<Vec<browser::Tab>, String>>;
    fn observe<'a>(
        &'a self,
        input: isolated_browser::ObserveInput,
    ) -> Future<'a, Result<isolated_browser::Observation, String>>;
    fn action<'a>(
        &'a self,
        input: isolated_browser::ActionInput,
    ) -> Future<'a, Result<isolated_browser::ActionResult, String>>;
    fn control<'a>(
        &'a self,
        session: &'a SessionId,
        resume: bool,
    ) -> Future<'a, Result<isolated_browser::Status, String>>;
    fn stop<'a>(&'a self, session: &'a SessionId) -> Future<'a, Result<(), String>>;
}
#[derive(Clone, Copy)]
pub struct Services<'a> {
    pub paired: &'a dyn Paired,
    pub isolated: Option<&'a dyn Isolated>,
}

pub trait Paired: Send + Sync {
    fn bridge(&self) -> Result<Arc<Bridge>, String>;
    fn action_identity(
        &self,
        input: &browser::ActionInput,
    ) -> Result<super::operation::Identity, String> {
        Bridge::action_identity(self.bridge()?.as_ref(), input).map_err(|e| e.to_string())
    }
    fn action_frame(&self, input: &browser::ActionInput) -> Result<Option<browser::Page>, String> {
        Bridge::action_frame(self.bridge()?.as_ref(), input).map_err(|e| e.to_string())
    }
    fn deliver_tab(&self, input: browser::CloseInput) -> Result<browser::Tab, String> {
        Bridge::deliver(self.bridge()?.as_ref(), input).map_err(|e| e.to_string())
    }
    fn tab_state(
        &self,
        session: &SessionId,
        id: &browser::TabId,
    ) -> Result<super::bridge::TabState, String> {
        Bridge::tab_state(self.bridge()?.as_ref(), session, id).map_err(|e| e.to_string())
    }
    fn observe_frames<'a>(
        &'a self,
        input: browser::ObserveInput,
        origins: Vec<LosslessString>,
    ) -> Future<'a, Result<browser::Observation, String>> {
        Box::pin(async move {
            Bridge::observe_frames(&self.bridge()?, input, origins)
                .await
                .map_err(|e| e.to_string())
        })
    }
    fn history<'a>(
        &'a self,
        input: browser::HistoryInput,
    ) -> Future<'a, Result<browser::HistoryResult, String>> {
        Box::pin(async move {
            Bridge::history(&self.bridge()?, input)
                .await
                .map_err(|e| e.to_string())
        })
    }
    fn status(&self, session: &SessionId) -> Result<browser::Status, String> {
        Bridge::status(self.bridge()?.as_ref(), session).map_err(|e| e.to_string())
    }
    fn list(&self, session: &SessionId) -> Result<Vec<browser::Tab>, String> {
        Bridge::list(self.bridge()?.as_ref(), session).map_err(|e| e.to_string())
    }
    fn control(&self, session: &SessionId, resume: bool) -> Result<browser::Status, String> {
        Bridge::control(self.bridge()?.as_ref(), session, resume).map_err(|e| e.to_string())
    }
    fn stop(&self, session: &SessionId) -> Result<(), String> {
        Bridge::stop(self.bridge()?.as_ref(), session).map_err(|e| e.to_string())
    }
    fn click_destination(
        &self,
        input: &browser::ActionInput,
        reference: &LosslessString,
    ) -> Result<Option<browser::Page>, String> {
        Bridge::click_destination(self.bridge()?.as_ref(), input, reference)
            .map_err(|e| e.to_string())
    }
    fn observe<'a>(
        &'a self,
        input: browser::ObserveInput,
    ) -> Future<'a, Result<browser::Observation, String>> {
        Box::pin(async move {
            Bridge::observe(&self.bridge()?, input)
                .await
                .map_err(|e| e.to_string())
        })
    }
    fn action<'a>(
        &'a self,
        input: browser::ActionInput,
    ) -> Future<'a, Result<browser::ActionResult, String>> {
        Box::pin(async move {
            Bridge::action(&self.bridge()?, input)
                .await
                .map_err(|e| e.to_string())
        })
    }
    fn open<'a>(&'a self, input: browser::OpenInput) -> Future<'a, Result<browser::Tab, String>> {
        Box::pin(async move {
            Bridge::open(&self.bridge()?, input)
                .await
                .map_err(|e| e.to_string())
        })
    }
    fn close<'a>(&'a self, input: browser::CloseInput) -> Future<'a, Result<(), String>> {
        Box::pin(async move {
            Bridge::close(&self.bridge()?, input)
                .await
                .map_err(|e| e.to_string())
        })
    }
    fn release<'a>(&'a self, input: browser::ReleaseInput) -> Future<'a, Result<(), String>> {
        Box::pin(async move {
            Bridge::release(&self.bridge()?, input)
                .await
                .map_err(|e| e.to_string())
        })
    }
}
impl Paired for Arc<Bridge> {
    fn bridge(&self) -> Result<Arc<Bridge>, String> {
        Ok(self.clone())
    }
}
impl Paired for Arc<super::service::Service> {
    fn bridge(&self) -> Result<Arc<Bridge>, String> {
        super::service::Service::bridge(self).map_err(|e| e.to_string())
    }
    fn status(&self, session: &SessionId) -> Result<browser::Status, String> {
        super::service::Service::status(self, session).map_err(|e| e.to_string())
    }
    fn list(&self, session: &SessionId) -> Result<Vec<browser::Tab>, String> {
        super::service::Service::list(self, session).map_err(|e| e.to_string())
    }
    fn control(&self, session: &SessionId, resume: bool) -> Result<browser::Status, String> {
        Bridge::control(
            super::service::Service::bridge(self)
                .map_err(|e| e.to_string())?
                .as_ref(),
            session,
            resume,
        )
        .map_err(|e| e.to_string())?;
        super::service::Service::status(self, session).map_err(|e| e.to_string())
    }
    fn stop(&self, session: &SessionId) -> Result<(), String> {
        super::service::Service::stop(self, session).map_err(|e| e.to_string())
    }
}

pub fn decode_input(value: &JsonValue) -> Result<Input, String> {
    let path = JsonPath::default();
    let o = ObjectDecoder::new(value, &path).map_err(|e| e.to_string())?;
    let mode: Option<LosslessString> = o.optional("mode").map_err(|e| e.to_string())?;
    let mode = match mode.as_ref().and_then(LosslessString::as_str) {
        None if mode.is_none() => None,
        Some("owned") => Some(Mode::Owned),
        Some("profile") => Some(Mode::Profile),
        Some("isolated") => Some(Mode::Isolated),
        _ => return Err("Invalid browser mode".into()),
    };
    let operation: LosslessString = o.field("operation").map_err(|e| e.to_string())?;
    let number = |name: &str| -> Result<JsonValue, String> {
        let value: JsonValue = o.field(name).map_err(|e| e.to_string())?;
        match value {
            JsonValue::String(value) => {
                let number = value
                    .as_str()
                    .and_then(|value| value.trim().parse::<f64>().ok())
                    .ok_or_else(|| format!("Invalid integer {name}"))?;
                Ok(JsonValue::Number(number))
            }
            value => Ok(value),
        }
    };
    let fence = || -> Result<Fence, String> {
        Ok(Fence {
            tab: o.field("tabID").map_err(|e| e.to_string())?,
            generation: browser::Generation::decode(&number("generation")?)
                .map_err(|e| e.to_string())?,
        })
    };
    let instance = || -> Result<Option<isolated_browser::InstanceId>, String> {
        if mode == Some(Mode::Isolated) {
            return o.field("instanceID").map(Some).map_err(|e| e.to_string());
        }
        Ok(None)
    };
    let operation = match operation.as_str() {
        Some("status") => Operation::Status,
        Some("tabs") => Operation::Tabs,
        Some("history") => {
            let optional_number = |name: &str| -> Result<Option<JsonValue>, String> {
                if o.optional::<JsonValue>(name)
                    .map_err(|e| e.to_string())?
                    .is_some()
                {
                    number(name).map(Some)
                } else {
                    Ok(None)
                }
            };
            let query: Option<LosslessString> = o.optional("query").map_err(|e| e.to_string())?;
            if query.as_ref().is_some_and(|query| query.len() > 256) {
                return Err("Browser history query exceeds its limit".into());
            }
            let limit = optional_number("limit")?
                .map(|value| ycoding_schema::schema::PositiveInt::decode(&value))
                .transpose()
                .map_err(|e| e.to_string())?;
            if limit.is_some_and(|limit| limit.get() > browser::MAX_HISTORY_RESULTS as i64) {
                return Err("Browser history limit is invalid".into());
            }
            Operation::History {
                generation: browser::Generation::decode(&number("generation")?)
                    .map_err(|e| e.to_string())?,
                query,
                limit,
                start_time: optional_number("startTime")?
                    .map(|value| ycoding_schema::schema::NonNegativeInt::decode(&value))
                    .transpose()
                    .map_err(|e| e.to_string())?,
                end_time: optional_number("endTime")?
                    .map(|value| ycoding_schema::schema::NonNegativeInt::decode(&value))
                    .transpose()
                    .map_err(|e| e.to_string())?,
            }
        }
        Some("observe") => Operation::Observe {
            fence: fence()?,
            diff: o.optional("diff").map_err(|e| e.to_string())?,
            instance: instance()?,
        },
        Some("action") => {
            let action: JsonValue = o.field("action").map_err(|e| e.to_string())?;
            let mut action = match action {
                JsonValue::String(source) => parse_json(
                    source
                        .as_str()
                        .ok_or_else(|| "Invalid JSON action".to_string())?,
                )
                .map_err(|e| e.to_string())?,
                action => action,
            };
            if let JsonValue::Object(object) = &mut action {
                for name in ["deltaY", "groupID", "timeoutMs", "limit"] {
                    if let Some(JsonValue::String(value)) = object.get(&name.into()) {
                        let number = value
                            .as_str()
                            .and_then(|value| value.trim().parse::<f64>().ok())
                            .ok_or_else(|| format!("Invalid integer {name}"))?;
                        object.insert(name.into(), JsonValue::Number(number));
                    }
                }
            }
            Operation::Action {
                fence: fence()?,
                document: browser::DocumentGeneration::decode(&number("documentGeneration")?)
                    .map_err(|e| e.to_string())?,
                revision: browser::ObservationRevision::decode(&number("observationRevision")?)
                    .map_err(|e| e.to_string())?,
                instance: instance()?,
                action: browser::Action::decode(&action).map_err(|e| e.to_string())?,
            }
        }
        Some("control") => {
            if mode.is_some() && mode != Some(Mode::Isolated) {
                return Err("Control mode must be omitted or isolated".into());
            }
            let action: LosslessString = o.field("action").map_err(|e| e.to_string())?;
            Operation::Control {
                resume: match action.as_str() {
                    Some("resume") => true,
                    Some("pause") => false,
                    _ => return Err("Invalid browser control".into()),
                },
            }
        }
        Some("stop") => {
            if mode.is_some() && mode != Some(Mode::Isolated) {
                return Err("Stop mode must be omitted or isolated".into());
            }
            Operation::Stop
        }
        Some("open") => {
            if mode != Some(Mode::Owned) {
                return Err("Open requires owned mode".into());
            }
            let url: LosslessString = o.field("url").map_err(|e| e.to_string())?;
            if url.code_units().count() > 8192
                || String::from_utf16_lossy(&url.code_units().collect::<Vec<_>>()).len() > 8192
            {
                return Err("Navigation URL exceeds 8192 bytes".into());
            }
            Operation::Open {
                generation: browser::Generation::decode(&number("generation")?)
                    .map_err(|e| e.to_string())?,
                url,
            }
        }
        Some("close") => {
            if mode != Some(Mode::Owned) {
                return Err("Close requires owned mode".into());
            }
            Operation::Close { fence: fence()? }
        }
        Some("release") => {
            if mode != Some(Mode::Profile) {
                return Err("Release requires profile mode".into());
            }
            Operation::Release { fence: fence()? }
        }
        Some("deliver") => {
            if mode != Some(Mode::Owned) && mode != Some(Mode::Profile) {
                return Err("Deliver requires owned or profile mode".into());
            }
            Operation::Deliver { fence: fence()? }
        }
        _ => return Err("Invalid browser operation".into()),
    };
    Ok(Input { mode, operation })
}

pub async fn execute(
    services: Services<'_>,
    policy: &dyn Policy,
    context: &Context,
    input: Input,
) -> Result<JsonValue, String> {
    let session = SessionId::new(context.owner.session_id.as_str()).map_err(|e| e.to_string())?;
    let call = browser::CallId::decode(&JsonValue::String(context.owner.call_id.as_str().into()))
        .map_err(|e| e.to_string())?;
    let isolated_mode = input.mode == Some(Mode::Isolated);
    if isolated_mode && matches!(&input.operation, Operation::History { .. }) {
        return Err("Chrome history is unavailable in isolated mode".into());
    }
    let owned = input.mode == Some(Mode::Owned);
    let status_operation = if matches!(&input.operation, Operation::Control { .. }) {
        "control"
    } else {
        "status"
    };
    let isolated = if isolated_mode {
        Some(
            services
                .isolated
                .ok_or_else(|| "Isolated browser service is not configured".to_string())?,
        )
    } else {
        None
    };
    let output = match input.operation {
        Operation::History {
            generation,
            query,
            limit,
            start_time,
            end_time,
        } => {
            if isolated_mode {
                return Err("Chrome history is unavailable in isolated mode".into());
            }
            permission(
                policy,
                context,
                "browser_history",
                vec!["*".into()],
                vec!["*".into()],
                serde_json::json!({"operation":"history"}),
            )
            .await?;
            let result = services
                .paired
                .history(browser::HistoryInput {
                    session_id: session.clone(),
                    generation,
                    call_id: call.clone(),
                    query,
                    limit,
                    start_time,
                    end_time,
                })
                .await?;
            output("history", "result", result.encode())
        }
        Operation::Status => {
            let status = match isolated {
                Some(isolated) => isolated.status(&session).await?.encode(),
                None => services
                    .paired
                    .status(&session)
                    .map_err(|e| e.to_string())?
                    .encode(),
            };
            output("status", "status", status)
        }
        Operation::Tabs => {
            let tabs = match isolated {
                Some(isolated) => isolated.list(&session).await?,
                None => services.paired.list(&session).map_err(|e| e.to_string())?,
            }
            .into_iter()
            .filter(|tab| {
                isolated_mode
                    || tab.mode
                        == Some(if owned {
                            browser::Mode::Owned
                        } else {
                            browser::Mode::Profile
                        })
            })
            .collect::<Vec<_>>();
            if !tabs.is_empty() {
                permission(
                    policy,
                    context,
                    "browser_read",
                    tabs.iter()
                        .map(|tab| resource(&tab.page))
                        .collect::<Result<_, _>>()?,
                    tabs.iter()
                        .map(|tab| text(&tab.page.origin))
                        .collect::<Result<_, _>>()?,
                    serde_json::json!({"operation":"tabs"}),
                )
                .await?;
            }
            let mut output = output("tabs", "tabs", tabs.encode());
            if let Some(mode) = input.mode {
                set(
                    &mut output,
                    "mode",
                    JsonValue::String(
                        match mode {
                            Mode::Isolated => "isolated",
                            Mode::Owned => "owned",
                            Mode::Profile => "profile",
                        }
                        .into(),
                    ),
                );
            }
            output
        }
        Operation::Control { resume } => {
            let action = if resume { "resume" } else { "pause" };
            permission(
                policy,
                context,
                "browser_control",
                vec![action.into()],
                vec!["*".into()],
                serde_json::json!({"action":action}),
            )
            .await?;
            let status = match isolated {
                Some(isolated) => isolated.control(&session, resume).await?.encode(),
                None => services
                    .paired
                    .control(&session, resume)
                    .map_err(|e| e.to_string())?
                    .encode(),
            };
            output("status", "status", status)
        }
        Operation::Stop => {
            permission(
                policy,
                context,
                "browser_control",
                vec!["stop".into()],
                vec!["*".into()],
                serde_json::json!({"action":"stop"}),
            )
            .await?;
            match isolated {
                Some(isolated) => isolated.stop(&session).await?,
                None => services.paired.stop(&session).map_err(|e| e.to_string())?,
            }
            let mut output = ObjectEncoder::new()
                .field("type", &LosslessString::from("stopped"))
                .finish();
            if isolated_mode {
                set(&mut output, "mode", JsonValue::String("isolated".into()));
            }
            output
        }
        Operation::Open { generation, url } => {
            let page =
                safe_page(&url).map_err(|_| "Unsupported browser navigation target".to_string())?;
            let resource = resource(&page)?;
            let origin = text(&page.origin)?;
            for action in ["browser_navigate", "browser_read"] {
                permission(policy,context,action,vec![resource.clone()],vec![origin.clone()],serde_json::json!({"operation":"open","mode":"owned","incidentalDownloads":true,"site":origin})).await?;
            }
            let tab = {
                let _held = review(
                    policy,
                    context,
                    "browser_owned_open",
                    vec![resource],
                    serde_json::json!({"operation":"open"}),
                )
                .await?;
                services
                    .paired
                    .open(browser::OpenInput {
                        session_id: session.clone(),
                        generation,
                        url,
                        call_id: call.clone(),
                    })
                    .await
                    .map_err(|e| e.to_string())?
            };
            if let Err(error) = read(policy, context, &tab.page, "open").await {
                if !matches!(
                    error,
                    PermissionFailure::Blocked(_) | PermissionFailure::Corrected(_)
                ) {
                    return Err(error.into());
                }
                let id =
                    text(&LosslessString::decode(&tab.id.encode()).map_err(|e| e.to_string())?)?;
                services.paired.close(browser::CloseInput {session_id:session.clone(),tab_id:tab.id.clone(),generation:tab.generation,call_id:browser::CallId::decode(&JsonValue::String(format!("cleanup-{id}").into())).map_err(|e|e.to_string())?}).await.map_err(|_|format!("Page access was denied and the new Chrome tab may remain open. Switch away and close it manually in Chrome. Tab ID: {id}"))?;
                return Err("Page access was denied; the new Chrome tab was closed".into());
            }
            output("opened", "tab", tab.encode())
        }
        Operation::Close { fence } => {
            let tab = services
                .paired
                .list(&session)
                .map_err(|e| e.to_string())?
                .into_iter()
                .find(|tab| tab.id == fence.tab && tab.mode == Some(browser::Mode::Owned))
                .ok_or_else(|| "Chrome tab is not owned by this Session".to_string())?;
            permission(
                policy,
                context,
                "browser_control",
                vec!["close".into()],
                vec!["*".into()],
                serde_json::json!({"action":"close","mode":"owned"}),
            )
            .await?;
            read(policy, context, &tab.page, "close").await?;
            {
                let _held = review(
                    policy,
                    context,
                    "browser_mutation",
                    vec![resource(&tab.page)?],
                    serde_json::json!({"operation":"close"}),
                )
                .await?;
                services
                    .paired
                    .close(browser::CloseInput {
                        session_id: session.clone(),
                        tab_id: fence.tab,
                        generation: fence.generation,
                        call_id: call.clone(),
                    })
                    .await
                    .map_err(|e| e.to_string())?;
            }
            ObjectEncoder::new()
                .field("type", &LosslessString::from("closed"))
                .field("mode", &LosslessString::from("owned"))
                .finish()
        }
        Operation::Release { fence } => {
            let held = services
                .paired
                .list(&session)
                .map_err(|e| e.to_string())?
                .into_iter()
                .any(|tab| tab.id == fence.tab && tab.mode == Some(browser::Mode::Profile));
            if !held {
                return Err("Chrome tab is not available in this mode".into());
            }
            services
                .paired
                .release(browser::ReleaseInput {
                    session_id: session.clone(),
                    tab_id: fence.tab,
                    generation: fence.generation,
                    call_id: call.clone(),
                })
                .await
                .map_err(|e| e.to_string())?;
            ObjectEncoder::new()
                .field("type", &LosslessString::from("released"))
                .field("mode", &LosslessString::from("profile"))
                .finish()
        }
        Operation::Deliver { fence } => {
            let tab = services.paired.deliver_tab(browser::CloseInput {
                session_id: session.clone(),
                tab_id: fence.tab,
                generation: fence.generation,
                call_id: call.clone(),
            })?;
            output("delivered", "tab", tab.encode())
        }
        operation => {
            let fence = match &operation {
                Operation::Observe { fence, .. } | Operation::Action { fence, .. } => fence,
                _ => return Err("Invalid browser operation".into()),
            };
            let tabs = match isolated {
                Some(isolated) => isolated.list(&session).await?,
                None => services.paired.list(&session).map_err(|e| e.to_string())?,
            };
            let tab = tabs
                .into_iter()
                .find(|tab| {
                    tab.id == fence.tab
                        && (isolated_mode
                            || tab.mode
                                == Some(if owned {
                                    browser::Mode::Owned
                                } else {
                                    browser::Mode::Profile
                                }))
                })
                .ok_or_else(|| {
                    unavailable(services, &session, isolated_mode, owned, &operation, fence)
                })?;
            if tab.lease == Some(browser::Lease::Other) {
                return Err(
                    "Chrome tab is controlled by another Session; wait for it to release control"
                        .into(),
                );
            }
            match operation {
                Operation::Observe {
                    fence,
                    diff,
                    instance,
                } => {
                    read(policy, context, &tab.page, "observe").await?;
                    let mut observation = match isolated {
                        Some(isolated) => isolated
                            .observe(isolated_browser::ObserveInput {
                                session_id: session.clone(),
                                tab_id: fence.tab.clone(),
                                generation: fence.generation,
                                call_id: call.clone(),
                                diff,
                                instance_id: instance
                                    .clone()
                                    .ok_or_else(|| "Missing isolated instance fence".to_string())?,
                            })
                            .await?
                            .encode(),
                        None => services
                            .paired
                            .observe(browser::ObserveInput {
                                session_id: session.clone(),
                                tab_id: fence.tab.clone(),
                                generation: fence.generation,
                                call_id: call.clone(),
                                diff,
                            })
                            .await?
                            .encode(),
                    };
                    let mut origins = vec![tab.page.origin.clone()];
                    for pass in 0..2 {
                        let decoded = browser::Observation::decode(&observation)
                            .map_err(|e| e.to_string())?;
                        if !isolated_mode && decoded.page.origin != tab.page.origin {
                            return Err("The shared tab changed to an unapproved site".into());
                        }
                        if decoded.page != tab.page {
                            read(policy, context, &decoded.page, "observe").await?;
                        }
                        let pages = decoded
                            .frames
                            .as_deref()
                            .unwrap_or_default()
                            .iter()
                            .map(|frame| &frame.page)
                            .chain(
                                decoded
                                    .elements
                                    .iter()
                                    .filter_map(|element| element.frame.as_ref()),
                            )
                            .chain(
                                decoded
                                    .texts
                                    .as_deref()
                                    .unwrap_or_default()
                                    .iter()
                                    .filter_map(|text| text.frame.as_ref()),
                            );
                        for page in pages {
                            if !origins.contains(&page.origin) {
                                read(policy, context, page, "observe").await?;
                                origins.push(page.origin.clone());
                            }
                        }
                        if pass == 1
                            || !decoded
                                .frames
                                .as_deref()
                                .unwrap_or_default()
                                .iter()
                                .any(|frame| !frame.observed)
                        {
                            break;
                        }
                        let call_id = browser::CallId::decode(
                            &format!(
                                "{}:frames",
                                text(
                                    &LosslessString::decode(&call.encode())
                                        .map_err(|e| e.to_string())?
                                )?
                            )
                            .encode(),
                        )
                        .map_err(|e| e.to_string())?;
                        observation = match isolated {
                            Some(isolated) => isolated
                                .observe(isolated_browser::ObserveInput {
                                    session_id: session.clone(),
                                    tab_id: fence.tab.clone(),
                                    generation: fence.generation,
                                    call_id,
                                    diff: None,
                                    instance_id: instance.clone().ok_or_else(|| {
                                        "Missing isolated instance fence".to_string()
                                    })?,
                                })
                                .await?
                                .encode(),
                            None => services
                                .paired
                                .observe_frames(
                                    browser::ObserveInput {
                                        session_id: session.clone(),
                                        tab_id: fence.tab.clone(),
                                        generation: fence.generation,
                                        call_id,
                                        diff: None,
                                    },
                                    origins.clone(),
                                )
                                .await?
                                .encode(),
                        };
                    }
                    output("observation", "observation", observation)
                }
                Operation::Action {
                    fence,
                    document,
                    revision,
                    instance,
                    action,
                } => {
                    let kind = action_kind(&action);
                    let input = browser::ActionInput {
                        session_id: session.clone(),
                        tab_id: fence.tab,
                        generation: fence.generation,
                        document_generation: document,
                        observation_revision: revision,
                        call_id: call.clone(),
                        action,
                    };
                    let group_ids = match &input.action {
                        browser::Action::Group(action) => Some(&action.tab_ids),
                        browser::Action::Ungroup(action) => Some(&action.tab_ids),
                        browser::Action::GroupControl(action) => Some(&action.tab_ids),
                        _ => None,
                    };
                    let grouping = group_ids.is_some();
                    if grouping && (isolated_mode || owned) {
                        return Err("Tab groups require profile mode".into());
                    }
                    let identity = match isolated {
                        Some(isolated) => isolated.action_identity(&input)?,
                        None => services.paired.action_identity(&input)?,
                    };
                    let mut metadata =
                        serde_json::json!({"operation":kind,"operationDigest":identity.digest});
                    let mut resources = vec![resource(&tab.page)?];
                    let mut approved_origins = vec![tab.page.origin.clone()];
                    if let Some(ids) = group_ids {
                        let members = services
                            .paired
                            .list(&session)?
                            .into_iter()
                            .filter(|tab| {
                                ids.contains(&tab.id) && tab.mode == Some(browser::Mode::Profile)
                            })
                            .collect::<Vec<_>>();
                        if members.len() != ids.len() || !ids.contains(&tab.id) {
                            return Err("Group members are not granted profile tabs".into());
                        }
                        if members
                            .iter()
                            .any(|tab| tab.lease == Some(browser::Lease::Other))
                        {
                            return Err("Chrome tab is controlled by another Session; wait for it to release control".into());
                        }
                        resources = members
                            .iter()
                            .map(|tab| resource(&tab.page))
                            .collect::<Result<_, _>>()?;
                        action_permission(
                            policy,
                            context,
                            "browser_read",
                            resources.clone(),
                            members
                                .iter()
                                .map(|tab| text(&tab.page.origin))
                                .collect::<Result<_, _>>()?,
                            metadata.clone(),
                            &identity,
                        )
                        .await?;
                        action_permission(
                            policy,
                            context,
                            "browser_control",
                            vec![kind.into()],
                            vec!["*".into()],
                            serde_json::json!({"operation":kind,"action":kind,"mode":"profile"}),
                            &identity,
                        )
                        .await?;
                    } else {
                        if !isolated_mode {
                            action_permission(
                                policy,
                                context,
                                "browser_read",
                                resources.clone(),
                                vec![text(&tab.page.origin)?],
                                metadata.clone(),
                                &identity,
                            )
                            .await?;
                        }
                        let destination = if !isolated_mode {
                            match &input.action {
                                browser::Action::Click(action) => match &action.r#ref {
                                    Some(reference) => {
                                        services.paired.click_destination(&input, reference)?
                                    }
                                    None => None,
                                },
                                _ => None,
                            }
                        } else {
                            None
                        };
                        let page = match &input.action {
                            browser::Action::Navigate(action) => safe_page(&action.url)
                                .map_err(|_| "Unsupported browser navigation target".to_string())?,
                            _ => tab.page.clone(),
                        };
                        approved_origins.push(page.origin.clone());
                        let permission_action =
                            super::operation::classify(&input.action).permission;
                        if !isolated_mode && super::operation::mutation(&input.action) {
                            metadata["mode"] =
                                serde_json::json!(if owned { "owned" } else { "profile" });
                            metadata["incidentalDownloads"] = serde_json::json!(true);
                            metadata["site"] = serde_json::json!(text(&page.origin)?);
                        }
                        action_permission(
                            policy,
                            context,
                            permission_action,
                            vec![resource(&page)?],
                            vec![text(&page.origin)?],
                            metadata.clone(),
                            &identity,
                        )
                        .await?;
                        if let Some(destination) = destination
                            .as_ref()
                            .filter(|page| page.origin != tab.page.origin)
                        {
                            action_permission(
                                policy,
                                context,
                                "browser_navigate",
                                vec![resource(destination)?],
                                vec![text(&destination.origin)?],
                                metadata.clone(),
                                &identity,
                            )
                            .await?;
                            resources.push(resource(destination)?);
                            approved_origins.push(destination.origin.clone());
                        }
                        {
                            let frame = if super::operation::is_element_action(&input.action) {
                                match isolated {
                                    Some(isolated) => isolated.action_frame(&input)?,
                                    None => services.paired.action_frame(&input)?,
                                }
                            } else {
                                None
                            };
                            if let Some(frame) =
                                frame.filter(|frame| frame.origin != tab.page.origin)
                            {
                                for action in ["browser_read", "browser_interact"] {
                                    action_permission(
                                        policy,
                                        context,
                                        action,
                                        vec![resource(&frame)?],
                                        vec![text(&frame.origin)?],
                                        metadata.clone(),
                                        &identity,
                                    )
                                    .await?;
                                }
                                resources.push(resource(&frame)?);
                            }
                            if !isolated_mode
                                && (matches!(input.action, browser::Action::Navigate(_))
                                    || destination.is_some())
                            {
                                let page = destination.as_ref().unwrap_or(&page);
                                action_permission(
                                    policy,
                                    context,
                                    "browser_read",
                                    vec![resource(page)?],
                                    vec![text(&page.origin)?],
                                    metadata.clone(),
                                    &identity,
                                )
                                .await?;
                            }
                        }
                    }
                    let result = {
                        let _held = if super::operation::mutation(&input.action) {
                            Some(
                                review(
                                    policy,
                                    context,
                                    if isolated_mode || owned {
                                        "browser_mutation"
                                    } else {
                                        "browser_profile_mutation"
                                    },
                                    resources,
                                    metadata.clone(),
                                )
                                .await?,
                            )
                        } else {
                            None
                        };
                        match isolated {
                            Some(isolated) => isolated
                                .action(isolated_browser::ActionInput {
                                    session_id: input.session_id,
                                    tab_id: input.tab_id,
                                    generation: input.generation,
                                    document_generation: input.document_generation,
                                    observation_revision: input.observation_revision,
                                    call_id: input.call_id,
                                    action: input.action,
                                    instance_id: instance.ok_or_else(|| {
                                        "Missing isolated instance fence".to_string()
                                    })?,
                                })
                                .await?
                                .encode(),
                            None => services.paired.action(input).await?.encode(),
                        }
                    };
                    if !isolated_mode {
                        let result_tab: browser::Tab =
                            ObjectDecoder::new(&result, &JsonPath::default())
                                .map_err(|e| e.to_string())?
                                .field("tab")
                                .map_err(|e| e.to_string())?;
                        if !approved_origins.contains(&result_tab.page.origin) {
                            return Err("The shared tab changed to an unapproved site".into());
                        }
                        action_permission(
                            policy,
                            context,
                            "browser_read",
                            vec![resource(&result_tab.page)?],
                            vec![text(&result_tab.page.origin)?],
                            metadata,
                            &identity,
                        )
                        .await?;
                    }
                    let logs: Option<Vec<browser::LogEntry>> =
                        ObjectDecoder::new(&result, &JsonPath::default())
                            .map_err(|e| e.to_string())?
                            .optional("logs")
                            .map_err(|e| e.to_string())?;
                    let result_frame: Option<browser::Page> =
                        ObjectDecoder::new(&result, &JsonPath::default())
                            .map_err(|e| e.to_string())?
                            .optional("frame")
                            .map_err(|e| e.to_string())?;
                    if let Some(frame) = &result_frame
                        && frame.origin != tab.page.origin
                    {
                        read(policy, context, frame, kind).await?;
                    }
                    let mut read_origins = vec![tab.page.origin.clone()];
                    if let Some(frame) = &result_frame {
                        read_origins.push(frame.origin.clone());
                    }
                    for frame in logs
                        .as_deref()
                        .unwrap_or_default()
                        .iter()
                        .filter_map(|entry| entry.frame.as_ref())
                    {
                        if !read_origins.contains(&frame.origin) {
                            read(policy, context, frame, "logs").await?;
                            read_origins.push(frame.origin.clone());
                        }
                    }
                    output("action", "result", result)
                }
                _ => return Err("Invalid browser operation".into()),
            }
        }
    };
    if field(&output, "type").and_then(|v| match v {
        JsonValue::String(s) => s.as_str(),
        _ => None,
    }) == Some("status")
        && let Some(tab) = field(&output, "status").and_then(|status| field(status, "tab"))
    {
        let tab = browser::Tab::decode(tab).map_err(|e| e.to_string())?;
        read(policy, context, &tab.page, status_operation).await?;
    }
    Ok(output)
}

fn unavailable(
    services: Services<'_>,
    session: &SessionId,
    isolated_mode: bool,
    owned: bool,
    operation: &Operation,
    fence: &Fence,
) -> String {
    let _ = operation;
    let id = stringify_json(&fence.tab.encode());
    let id = id.trim_matches('"');
    let current = if isolated_mode {
        "isolated"
    } else if owned {
        "owned"
    } else {
        "profile"
    };
    if isolated_mode {
        return format!(
            "Chrome tab {id} is not listed by the current browser connection; list tabs again"
        );
    }
    let state = services
        .paired
        .tab_state(session, &fence.tab)
        .unwrap_or(super::bridge::TabState::Unknown);
    match state {
        super::bridge::TabState::Present { mode } => {
            let (actual, article) = match mode {
                browser::Mode::Owned => ("owned", "an owned"),
                browser::Mode::Profile => ("profile", "a profile"),
            };
            format!(
                "Chrome tab {id} is {article} tab, not available with mode:\"{current}\"; pass mode:\"{actual}\" instead"
            )
        }
        super::bridge::TabState::Departed {
            reason,
            detach_reason,
            successor,
            ..
        } => {
            let reason = match reason.as_deref() {
                Some("closed") => "the tab was closed".to_owned(),
                Some("navigated") => {
                    "the tab navigated outside the approved sites and control was revoked"
                        .to_owned()
                }
                Some("detached") => "Chrome detached the debugger".to_owned(),
                Some("access_revoked") => {
                    "paired-profile access was turned off in the extension".to_owned()
                }
                Some("replaced") => "Chrome replaced the tab".to_owned(),
                _ => "the Chrome extension revoked it".to_owned(),
            };
            let reason = match &detach_reason {
                Some(detach) => format!("{reason} ({})", detach.as_str().unwrap_or("")),
                None => reason,
            };
            match &successor {
                Some(successor) => format!(
                    "Chrome tab {id} is no longer listed: {reason}. The same Chrome tab is now listed as {}; observe it before acting.",
                    stringify_json(&successor.encode()).trim_matches('"')
                ),
                None => format!(
                    "Chrome tab {id} is no longer listed: {reason}. List tabs again to find it."
                ),
            }
        }
        super::bridge::TabState::Unknown => format!(
            "Chrome tab {id} is not listed by the current browser connection; list tabs again"
        ),
    }
}
fn text(value: &LosslessString) -> Result<String, String> {
    value
        .to_utf8()
        .map_err(|_| "Invalid native resource text".into())
}
fn resource(page: &browser::Page) -> Result<String, String> {
    Ok(format!("{}{}", text(&page.origin)?, text(&page.path)?))
}
async fn permission(
    policy: &dyn Policy,
    context: &Context,
    action: &str,
    resources: Vec<String>,
    save: Vec<String>,
    metadata: serde_json::Value,
) -> Result<(), PermissionFailure> {
    policy
        .permission(
            context,
            Permission {
                action: action.into(),
                resources,
                save,
                metadata,
                consume_review: true,
            },
        )
        .await
}
async fn action_permission(
    policy: &dyn Policy,
    context: &Context,
    action: &str,
    resources: Vec<String>,
    save: Vec<String>,
    mut metadata: serde_json::Value,
    identity: &super::operation::Identity,
) -> Result<(), PermissionFailure> {
    metadata["operationDigest"] = serde_json::json!(identity.digest);
    policy
        .permission(
            context,
            Permission {
                action: action.into(),
                resources,
                save,
                metadata,
                consume_review: identity.reusable,
            },
        )
        .await
}
async fn read(
    policy: &dyn Policy,
    context: &Context,
    page: &browser::Page,
    operation: &str,
) -> Result<(), PermissionFailure> {
    permission(
        policy,
        context,
        "browser_read",
        vec![resource(page).map_err(PermissionFailure::Fault)?],
        vec![text(&page.origin).map_err(PermissionFailure::Fault)?],
        serde_json::json!({"operation":operation}),
    )
    .await
}
async fn review(
    policy: &dyn Policy,
    context: &Context,
    action: &str,
    resources: Vec<String>,
    metadata: serde_json::Value,
) -> Result<Held, String> {
    Ok(Held(
        policy
            .review(
                context,
                Review {
                    action: action.into(),
                    resources,
                    metadata,
                    skip_review: true,
                },
            )
            .await?,
    ))
}
fn output(kind: &str, key: &str, value: JsonValue) -> JsonValue {
    ObjectEncoder::new()
        .field("type", &LosslessString::from(kind))
        .field(key, &value)
        .finish()
}
fn set(value: &mut JsonValue, key: &str, part: JsonValue) {
    if let JsonValue::Object(object) = value {
        object.insert(key.into(), part);
    }
}
fn field<'a>(value: &'a JsonValue, key: &str) -> Option<&'a JsonValue> {
    match value {
        JsonValue::Object(object) => object.get(&key.into()),
        _ => None,
    }
}
fn action_kind(action: &browser::Action) -> &'static str {
    super::operation::kind(action)
}
pub fn model_output(output: &JsonValue) -> Vec<serde_json::Value> {
    let capture = field(output, "result").and_then(|result| field(result, "capture"));
    if let Some(capture) = capture {
        let mut text = output.clone();
        if let JsonValue::Object(o) = &mut text
            && let Some(JsonValue::Object(mut result)) = o.get(&"result".into()).cloned()
        {
            let mut metadata = capture.clone();
            if let JsonValue::Object(capture) = &mut metadata {
                let mut bounded = ycoding_schema::JsonObject::new();
                for key in ["mediaType", "bytes"] {
                    if let Some(value) = capture.get(&key.into()) {
                        bounded.insert(key.into(), value.clone());
                    }
                }
                metadata = JsonValue::Object(bounded);
            }
            result.insert("capture".into(), metadata);
            o.insert("result".into(), JsonValue::Object(result));
        }
        let data = field(capture, "data")
            .and_then(|v| match v {
                JsonValue::String(s) => s.as_str(),
                _ => None,
            })
            .unwrap_or("");
        let media = field(capture, "mediaType")
            .and_then(|v| match v {
                JsonValue::String(s) => s.as_str(),
                _ => None,
            })
            .unwrap_or("image/png");
        let isolated = field(output, "result")
            .and_then(|result| field(result, "mode"))
            .is_some_and(|v| v == &JsonValue::String("isolated".into()));
        return vec![
            serde_json::json!({"type":"text","text":stringify_json(&text)}),
            serde_json::json!({"type":"file","data":data,"mime":media,"name":if isolated {"isolated-browser.png"}else{"shared-tab.png"}}),
        ];
    }
    vec![serde_json::json!({"type":"text","text":stringify_json(output)})]
}
