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
    Tabs,
    Observe {
        fence: Fence,
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
}
#[derive(Clone, Debug)]
pub struct Input {
    pub mode: Option<Mode>,
    pub operation: Operation,
}

pub trait Isolated: Send + Sync {
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
pub struct Services<'a> {
    pub paired: &'a dyn Paired,
    pub isolated: Option<&'a dyn Isolated>,
}

pub trait Paired: Send + Sync {
    fn bridge(&self) -> Result<Arc<Bridge>, String>;
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
    let number = |name| -> Result<JsonValue, String> {
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
        Some("observe") => Operation::Observe {
            fence: fence()?,
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
                for name in ["deltaY", "groupID"] {
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
                .ok_or_else(|| "Chrome tab is not available in this mode".to_string())?;
            if tab.lease == Some(browser::Lease::Other) {
                return Err(
                    "Chrome tab is controlled by another Session; wait for it to release control"
                        .into(),
                );
            }
            match operation {
                Operation::Observe { fence, instance } => {
                    read(policy, context, &tab.page, "observe").await?;
                    let observation = match isolated {
                        Some(isolated) => isolated
                            .observe(isolated_browser::ObserveInput {
                                session_id: session.clone(),
                                tab_id: fence.tab,
                                generation: fence.generation,
                                call_id: call.clone(),
                                instance_id: instance
                                    .ok_or_else(|| "Missing isolated instance fence".to_string())?,
                            })
                            .await?
                            .encode(),
                        None => services
                            .paired
                            .observe(browser::ObserveInput {
                                session_id: session.clone(),
                                tab_id: fence.tab,
                                generation: fence.generation,
                                call_id: call.clone(),
                            })
                            .await
                            .map_err(|e| e.to_string())?
                            .encode(),
                    };
                    let page: browser::Page =
                        ObjectDecoder::new(&observation, &JsonPath::default())
                            .map_err(|e| e.to_string())?
                            .field("page")
                            .map_err(|e| e.to_string())?;
                    if !isolated_mode && page.origin != tab.page.origin {
                        return Err("The shared tab changed to an unapproved site".into());
                    }
                    if !isolated_mode && page != tab.page {
                        read(policy, context, &page, "observe").await?;
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
                    if matches!(
                        input.action,
                        browser::Action::Group(_) | browser::Action::Ungroup(_)
                    ) {
                        if isolated_mode || owned {
                            return Err("Tab groups require profile mode".into());
                        }
                        let ids = match &input.action {
                            browser::Action::Group(action) => &action.tab_ids,
                            browser::Action::Ungroup(action) => &action.tab_ids,
                            _ => return Err("Invalid group action".into()),
                        };
                        let members = services
                            .paired
                            .list(&session)
                            .map_err(|e| e.to_string())?
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
                        let resources = members
                            .iter()
                            .map(|tab| resource(&tab.page))
                            .collect::<Result<Vec<_>, _>>()?;
                        permission(
                            policy,
                            context,
                            "browser_read",
                            resources.clone(),
                            members
                                .iter()
                                .map(|tab| text(&tab.page.origin))
                                .collect::<Result<_, _>>()?,
                            serde_json::json!({"operation":kind}),
                        )
                        .await?;
                        permission(
                            policy,
                            context,
                            "browser_control",
                            vec![kind.into()],
                            vec!["*".into()],
                            serde_json::json!({"action":kind,"mode":"profile"}),
                        )
                        .await?;
                        let result = {
                            let _held = review(
                                policy,
                                context,
                                "browser_profile_mutation",
                                resources,
                                serde_json::json!({"operation":kind}),
                            )
                            .await?;
                            services
                                .paired
                                .action(input)
                                .await
                                .map_err(|e| e.to_string())?
                        };
                        return Ok(output("action", "result", result.encode()));
                    }
                    if !isolated_mode {
                        read(policy, context, &tab.page, kind).await?;
                    }
                    let destination = if !isolated_mode {
                        match &input.action {
                            browser::Action::Click(action) => services
                                .paired
                                .click_destination(&input, &action.r#ref)
                                .map_err(|e| e.to_string())?,
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
                    let permission_action = match &input.action {
                        browser::Action::Capture(_) | browser::Action::Scroll(_) => "browser_read",
                        browser::Action::Navigate(_) => "browser_navigate",
                        _ => "browser_interact",
                    };
                    let mut metadata = serde_json::json!({"operation":kind});
                    if let browser::Action::Click(action) = &input.action {
                        metadata["ref"] = serde_json::json!(text(&action.r#ref)?);
                    }
                    if let browser::Action::Type(action) = &input.action {
                        metadata["ref"] = serde_json::json!(text(&action.r#ref)?);
                    }
                    if !isolated_mode
                        && matches!(
                            input.action,
                            browser::Action::Navigate(_)
                                | browser::Action::Click(_)
                                | browser::Action::Type(_)
                        )
                    {
                        metadata["mode"] =
                            serde_json::json!(if owned { "owned" } else { "profile" });
                        metadata["incidentalDownloads"] = serde_json::json!(true);
                        metadata["site"] = serde_json::json!(text(&page.origin)?);
                    }
                    permission(
                        policy,
                        context,
                        permission_action,
                        vec![resource(&page)?],
                        vec![text(&page.origin)?],
                        metadata,
                    )
                    .await?;
                    let destination = destination.filter(|page| page.origin != tab.page.origin);
                    if let Some(destination) = &destination {
                        permission(policy,context,"browser_navigate",vec![resource(destination)?],vec![text(&destination.origin)?],serde_json::json!({"operation":"click","mode":if owned {"owned"}else{"profile"},"incidentalDownloads":true,"site":text(&destination.origin)?})).await?;
                    }
                    if !isolated_mode
                        && (matches!(input.action, browser::Action::Navigate(_))
                            || destination.is_some())
                    {
                        read(policy, context, destination.as_ref().unwrap_or(&page), kind).await?;
                    }
                    let result = {
                        let _held = if matches!(
                            input.action,
                            browser::Action::Navigate(_)
                                | browser::Action::Click(_)
                                | browser::Action::Type(_)
                        ) {
                            let mut resources = vec![resource(&page)?];
                            if let Some(destination) = &destination {
                                resources.push(resource(destination)?);
                            }
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
                                    serde_json::json!({"operation":kind}),
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
                            None => services
                                .paired
                                .action(input)
                                .await
                                .map_err(|e| e.to_string())?
                                .encode(),
                        }
                    };
                    if !isolated_mode {
                        let result_tab: browser::Tab =
                            ObjectDecoder::new(&result, &JsonPath::default())
                                .map_err(|e| e.to_string())?
                                .field("tab")
                                .map_err(|e| e.to_string())?;
                        if result_tab.page.origin != tab.page.origin
                            && result_tab.page.origin
                                != destination.as_ref().unwrap_or(&page).origin
                        {
                            return Err("The shared tab changed to an unapproved site".into());
                        }
                        read(policy, context, &result_tab.page, kind).await?;
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
    match action {
        browser::Action::Navigate(_) => "navigate",
        browser::Action::Click(_) => "click",
        browser::Action::Type(_) => "type",
        browser::Action::Scroll(_) => "scroll",
        browser::Action::Capture(_) => "capture",
        browser::Action::Group(_) => "group",
        browser::Action::Ungroup(_) => "ungroup",
    }
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
