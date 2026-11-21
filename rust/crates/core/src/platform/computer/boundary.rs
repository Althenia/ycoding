use super::{Future, service::Service, types::*};
use serde_json::{Value, json};

#[derive(Clone, Debug)]
pub struct Context {
    pub owner: Owner,
    pub message_id: String,
    pub agent: String,
}
#[derive(Clone, Debug, PartialEq)]
pub struct Permission {
    pub action: String,
    pub resources: Vec<String>,
    pub save: Vec<String>,
    pub metadata: Value,
    pub consume_review: bool,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PermissionFailure {
    Blocked(String),
    Corrected(String),
    Fault(String),
}
impl std::fmt::Display for PermissionFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Blocked(message) | Self::Corrected(message) | Self::Fault(message) => {
                f.write_str(message)
            }
        }
    }
}
impl std::error::Error for PermissionFailure {}
impl From<PermissionFailure> for String {
    fn from(error: PermissionFailure) -> Self {
        match error {
            PermissionFailure::Blocked(message)
            | PermissionFailure::Corrected(message)
            | PermissionFailure::Fault(message) => message,
        }
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct Review {
    pub action: String,
    pub resources: Vec<String>,
    pub metadata: Value,
    pub skip_review: bool,
}
pub trait Reservation: Send + Sync {
    fn release(&self);
}
pub struct Held(pub Box<dyn Reservation>);
impl Drop for Held {
    fn drop(&mut self) {
        self.0.release();
    }
}
#[derive(Clone, Debug)]
pub struct Resolved {
    pub canonical: String,
    pub resource: String,
    pub external_directory: Option<Permission>,
}
pub trait Policy: Send + Sync {
    fn permission<'a>(
        &'a self,
        context: &'a Context,
        request: Permission,
    ) -> Future<'a, Result<(), PermissionFailure>>;
    fn review<'a>(
        &'a self,
        context: &'a Context,
        request: Review,
    ) -> Future<'a, Result<Box<dyn Reservation>, String>>;
    fn resolve<'a>(
        &'a self,
        path: &'a str,
        directory: bool,
    ) -> Future<'a, Result<Resolved, String>>;
}

#[derive(Clone, Debug)]
pub enum Input {
    Status,
    Cancel {
        call: String,
    },
    Inspect {
        target: Target,
    },
    Capture {
        target: Target,
    },
    Observe {
        target: Target,
    },
    Query {
        target: Target,
        fields: Value,
    },
    History {
        op: String,
        id: Option<String>,
        limit: Option<u64>,
    },
    Stage {
        target: Target,
        revision: String,
    },
    Unstage {
        target: Target,
    },
    Act {
        target: Target,
        revision: String,
        action: Action,
    },
    List,
    Launch {
        bundle: String,
        remote_debugging: bool,
    },
    Quit {
        bundle: String,
        pid: u32,
    },
    BrowserTabs {
        bundle: BrowserBundle,
    },
    BrowserAct {
        target: Target,
        revision: String,
        action: BrowserAction,
    },
}
impl Input {
    pub fn operation(&self) -> Option<Operation> {
        match self {
            Self::Status | Self::Cancel { .. } => None,
            Self::Inspect { target } => Some(match target {
                Target::Iterm { .. } => Operation::ItermInspect,
                Target::Finder { .. } => Operation::FinderInspect,
                _ => Operation::DesktopInspect,
            }),
            Self::Capture { .. } => Some(Operation::DesktopCapture),
            Self::Observe { .. } => Some(Operation::DesktopObserve),
            Self::Query { .. } => Some(Operation::DesktopQuery),
            Self::History { .. } => Some(Operation::DesktopHistory),
            Self::Stage { .. } => Some(Operation::DesktopStage),
            Self::Unstage { .. } => Some(Operation::DesktopUnstage),
            Self::Act { action, .. } => Some(match action {
                Action::SendText { .. } => Operation::ItermSendText,
                Action::Move { .. } => Operation::FinderMove,
                Action::Click { .. } => Operation::DesktopClick,
                Action::Drag { .. } => Operation::DesktopDrag,
                Action::Type { .. } => Operation::DesktopType,
                Action::Scroll { .. } | Action::ScrollPixels { .. } => Operation::DesktopScroll,
                Action::Key { .. } => Operation::DesktopKey,
                Action::Paste { .. } => Operation::DesktopPaste,
                Action::SelectText { .. } => Operation::DesktopSelectText,
                Action::PerformAction { .. } => Operation::DesktopPerformAction,
            }),
            Self::List => Some(Operation::DesktopList),
            Self::Launch { .. } => Some(Operation::DesktopLaunch),
            Self::Quit { .. } => Some(Operation::DesktopQuit),
            Self::BrowserTabs { .. } => Some(Operation::BrowserTabs),
            Self::BrowserAct { action, .. } => Some(match action {
                BrowserAction::Navigate { .. } => Operation::BrowserNavigate,
                BrowserAction::Back => Operation::BrowserBack,
                BrowserAction::Forward => Operation::BrowserForward,
                BrowserAction::Reload => Operation::BrowserReload,
                BrowserAction::NewTab { .. } => Operation::BrowserNewTab,
                BrowserAction::CloseTab => Operation::BrowserCloseTab,
                BrowserAction::Evaluate { .. } => Operation::BrowserEvaluate,
            }),
        }
    }
}

pub fn decode_input(value: &Value) -> Result<Input, String> {
    let text = |name: &str| {
        value
            .get(name)
            .and_then(Value::as_str)
            .map(String::from)
            .ok_or_else(|| format!("Expected string {name}"))
    };
    let optional_text = |name: &str| match value.get(name) {
        None => Ok(None),
        Some(Value::String(value)) => Ok(Some(value.clone())),
        _ => Err(format!("Expected string {name}")),
    };
    let boolean = |name: &str, default: bool| match value.get(name) {
        None => Ok(default),
        Some(Value::Bool(value)) => Ok(*value),
        _ => Err(format!("Expected boolean {name}")),
    };
    let integer = |name: &str, minimum: i64| {
        integer(
            value
                .get(name)
                .ok_or_else(|| format!("Missing integer {name}"))?,
            minimum,
        )
        .map_err(|_| format!("Invalid integer {name}"))
    };
    let positive = |name: &str| {
        integer(name, 1)
            .and_then(|n| u64::try_from(n).map_err(|_| format!("Invalid integer {name}")))
    };
    let nonnegative = |name: &str| {
        integer(name, 0)
            .and_then(|n| u32::try_from(n).map_err(|_| format!("Invalid integer {name}")))
    };
    let element = || {
        value
            .get("element")
            .map(|value| {
                let values = value
                    .as_array()
                    .ok_or_else(|| "Expected element array".to_string())?;
                if values.len() > 12 {
                    return Err("Element path exceeds 12 entries".into());
                }
                values
                    .iter()
                    .map(|value| {
                        self::integer(value, 0).and_then(|n| {
                            u32::try_from(n).map_err(|_| "Element index out of range".into())
                        })
                    })
                    .collect::<Result<Vec<_>, String>>()
            })
            .transpose()
    };
    let action = text("action")?;
    if action == "status" {
        return Ok(Input::Status);
    }
    if action == "cancel" {
        return Ok(Input::Cancel {
            call: text("call_id")?,
        });
    }
    if action == "desktop.history" {
        let op = text("op")?;
        if !matches!(op.as_str(), "list" | "read" | "clear") {
            return Err("Invalid history operation".into());
        }
        return Ok(Input::History {
            op,
            id: optional_text("id")?,
            limit: value
                .get("limit")
                .map(|value| {
                    self::integer(value, 1)
                        .and_then(|n| u64::try_from(n).map_err(|_| "Invalid history limit".into()))
                })
                .transpose()?,
        });
    }
    if text("platform")? != "macos" {
        return Err("Expected macos platform".into());
    }
    if action.starts_with("webbrowser.") {
        let bundle = match text("bundle_id")?.as_str() {
            "com.apple.Safari" => BrowserBundle::Safari,
            "com.google.Chrome" => BrowserBundle::Chrome,
            _ => return Err("Only Safari and Chrome are supported".into()),
        };
        if action == "webbrowser.tabs" {
            return Ok(Input::BrowserTabs { bundle });
        }
        let target = Target::Browser {
            bundle_id: bundle,
            window_id: text("window_id")?,
            tab_index: if action == "webbrowser.new_tab" {
                1
            } else {
                u32::try_from(positive("tab_index")?)
                    .map_err(|_| "Invalid tab index".to_string())?
            },
        };
        target.validate().map_err(|e| e.to_string())?;
        let browser_action = match action.as_str() {
            "webbrowser.navigate" => BrowserAction::Navigate { url: text("url")? },
            "webbrowser.back" => BrowserAction::Back,
            "webbrowser.forward" => BrowserAction::Forward,
            "webbrowser.reload" => BrowserAction::Reload,
            "webbrowser.close_tab" => BrowserAction::CloseTab,
            "webbrowser.new_tab" => BrowserAction::NewTab {
                url: optional_text("url")?,
            },
            "webbrowser.eval" => BrowserAction::Evaluate {
                script: text("script")?,
            },
            _ => return Err("Unknown browser action".into()),
        };
        let revision = text("expected_revision")?;
        Request::browser_action(
            Owner {
                session_id: String::new(),
                call_id: String::new(),
            },
            target.clone(),
            revision.clone(),
            browser_action.clone(),
        )
        .map_err(|e| e.to_string())?;
        return Ok(Input::BrowserAct {
            target,
            revision,
            action: browser_action,
        });
    }
    if action == "desktop.list" {
        return Ok(Input::List);
    }
    if action == "desktop.launch" || action == "desktop.quit" {
        let bundle = text("bundle_id")?;
        if bundle.is_empty() {
            return Err("Expected nonempty bundle ID".into());
        }
        return if action == "desktop.launch" {
            Ok(Input::Launch {
                bundle,
                remote_debugging: boolean("remote_debugging", false)?,
            })
        } else {
            Ok(Input::Quit {
                bundle,
                pid: u32::try_from(positive("pid")?).map_err(|_| "Invalid PID".to_string())?,
            })
        };
    }
    let target = if action.starts_with("desktop.") {
        Target::Desktop {
            bundle_id: text("bundle_id")?,
            pid: u32::try_from(positive("pid")?).map_err(|_| "Invalid PID".to_string())?,
            window_id: positive("window_id")?,
        }
    } else if action.starts_with("iterm.") {
        Target::Iterm {
            window_id: positive("window_id")?,
            tab_index: positive("tab_index")?,
            session_id: text("session_id")?,
        }
    } else if action.starts_with("finder.") {
        Target::Finder {
            path: text("path")?,
        }
    } else {
        return Err("Unknown computer action".into());
    };
    target.validate().map_err(|e| e.to_string())?;
    match action.as_str() {
        "desktop.inspect" | "iterm.inspect" | "finder.inspect" => {
            return Ok(Input::Inspect { target });
        }
        "desktop.capture" => return Ok(Input::Capture { target }),
        "desktop.observe" => return Ok(Input::Observe { target }),
        "desktop.query" => {
            let mut fields = json!({});
            if let Some(role) = optional_text("role")? {
                if role.encode_utf16().count() > 64 {
                    return Err("Query role exceeds its limit".into());
                }
                fields["role"] = json!(role);
            }
            if let Some(text) = optional_text("text")? {
                if text.encode_utf16().count() > 256 {
                    return Err("Query text exceeds its limit".into());
                }
                fields["text"] = json!(text);
            }
            if let Some(limit) = value.get("limit") {
                fields["limit"] = json!(self::integer(limit, 0)?);
            }
            if let Some(max_nodes) = value.get("max_nodes") {
                fields["maxNodes"] = json!(self::integer(max_nodes, 0)?);
            }
            return Ok(Input::Query { target, fields });
        }
        "desktop.stage" => {
            return Ok(Input::Stage {
                target,
                revision: text("expected_revision")?,
            });
        }
        "desktop.unstage" => return Ok(Input::Unstage { target }),
        _ => {}
    }
    let native_action = match action.as_str() {
        "iterm.send_text" => Action::SendText {
            text: text("text")?,
            newline: boolean("newline", true)?,
        },
        "finder.move" => Action::Move {
            destination: text("destination_directory")?,
        },
        "desktop.click" => {
            let element = element()?;
            Action::Click {
                x: if element.is_none() {
                    Some(nonnegative("x")?)
                } else {
                    None
                },
                y: if element.is_none() {
                    Some(nonnegative("y")?)
                } else {
                    None
                },
                element,
                button: optional_text("button")?,
                count: value
                    .get("count")
                    .map(|value| {
                        self::integer(value, 1).and_then(|n| {
                            u32::try_from(n).map_err(|_| "Invalid click count".into())
                        })
                    })
                    .transpose()?,
                key: optional_text("key")?,
                duration_ms: value
                    .get("duration_ms")
                    .map(|value| {
                        self::integer(value, 1).and_then(|n| {
                            u32::try_from(n).map_err(|_| "Invalid click duration".into())
                        })
                    })
                    .transpose()?,
            }
        }
        "desktop.drag" => Action::Drag {
            from_x: nonnegative("from_x")?,
            from_y: nonnegative("from_y")?,
            to_x: nonnegative("to_x")?,
            to_y: nonnegative("to_y")?,
        },
        "desktop.type" => Action::Type {
            element: element()?,
            text: text("text")?,
        },
        "desktop.scroll" => match element()? {
            Some(element) => Action::Scroll {
                element,
                direction: text("direction")?,
            },
            None => Action::ScrollPixels {
                x: nonnegative("x")?,
                y: nonnegative("y")?,
                delta_x: integer("delta_x", -9_007_199_254_740_991)?,
                delta_y: integer("delta_y", -9_007_199_254_740_991)?,
            },
        },
        "desktop.key" => {
            let explicit: Vec<String> = match value.get("modifiers") {
                None => Vec::new(),
                Some(value) => value
                    .as_array()
                    .ok_or_else(|| "Expected modifiers array".to_string())?
                    .iter()
                    .map(|value| {
                        value
                            .as_str()
                            .map(String::from)
                            .ok_or_else(|| "Invalid modifier".to_string())
                    })
                    .collect::<Result<_, _>>()?,
            };
            let raw = text("key")?;
            let (key, modifiers) = key_chord(&raw, &explicit)
                .filter(|(key, _)| !key.is_empty())
                .ok_or_else(|| {
                    NativeError::new(
                        Code::InvalidRequest,
                        format!("unsupported key chord {raw}"),
                        Outcome::NotStarted,
                    )
                    .to_string()
                })?;
            Action::Key {
                element: element()?,
                key,
                modifiers,
                duration_ms: value
                    .get("duration_ms")
                    .map(|value| {
                        self::integer(value, 1).and_then(|n| {
                            u32::try_from(n).map_err(|_| "Invalid key duration".into())
                        })
                    })
                    .transpose()?,
            }
        }
        "desktop.paste" => Action::Paste {
            element: element()?,
            text: text("text")?,
            format: optional_text("format")?,
        },
        "desktop.select_text" => Action::SelectText {
            element: element()?.ok_or_else(|| "Missing element".to_string())?,
            text: text("text")?,
            prefix: optional_text("prefix")?,
            suffix: optional_text("suffix")?,
            selection: optional_text("selection")?,
        },
        "desktop.perform_action" => Action::PerformAction {
            element: element()?.ok_or_else(|| "Missing element".to_string())?,
            name: text("name")?,
        },
        _ => return Err("Unknown computer action".into()),
    };
    let revision = text("expected_revision")?;
    Request::act(
        Owner {
            session_id: String::new(),
            call_id: String::new(),
        },
        target.clone(),
        revision.clone(),
        native_action.clone(),
    )
    .map_err(|e| e.to_string())?;
    Ok(Input::Act {
        target,
        revision,
        action: native_action,
    })
}

fn integer(value: &Value, minimum: i64) -> Result<i64, String> {
    let number = match value {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => s.trim().parse::<f64>().ok(),
        _ => None,
    }
    .ok_or_else(|| "Expected integer".to_string())?;
    if !number.is_finite()
        || number.fract() != 0.
        || number < minimum as f64
        || number > 9_007_199_254_740_991.
    {
        return Err("Integer out of range".into());
    }
    Ok(number as i64)
}

pub async fn execute(
    service: &Service,
    policy: &dyn Policy,
    context: &Context,
    input: Input,
) -> Result<Value, String> {
    if matches!(input, Input::Status) {
        let mut output = service.status();
        output["type"] = json!("status");
        return Ok(output);
    }
    if let Input::Cancel { call } = input {
        return Ok(
            json!({"type":"cancelled","callID":call,"cancelled":service.cancel(&context.owner.session_id,&call)}),
        );
    }
    if let Input::History { op, id, limit } = &input {
        let directory = service
            .history_directory()
            .ok_or_else(|| "Computer history is unavailable".to_string())?;
        let session = context.owner.session_id.as_str();
        return match op.as_str() {
            "list" => {
                let entries: Vec<Value> = super::history::list(&directory)?
                    .into_iter()
                    .filter(|entry| entry.session_id == session)
                    .map(|entry| {
                        json!({"id": entry.id, "sessionID": entry.session_id, "started": entry.started, "updated": entry.updated, "events": entry.events})
                    })
                    .collect();
                Ok(json!({"type":"history","op":"list","entries":entries}))
            }
            "read" => {
                let id = id.as_deref().ok_or_else(|| {
                    NativeError::new(
                        Code::InvalidRequest,
                        "Computer history id is required",
                        Outcome::NotStarted,
                    )
                    .to_string()
                })?;
                let known = super::history::list(&directory)?
                    .iter()
                    .any(|entry| entry.id == id && entry.session_id == session);
                if !known {
                    return Err(NativeError::new(
                        Code::InvalidRequest,
                        "Computer history entry is unavailable",
                        Outcome::NotStarted,
                    )
                    .to_string());
                }
                let events: Vec<Value> = super::history::read(
                    &directory,
                    id,
                    limit.map_or(100, |limit| limit as usize).min(500),
                )
                .map_err(|error| {
                    if error == "Computer history entry is unavailable" {
                        NativeError::new(Code::InvalidRequest, error, Outcome::NotStarted)
                            .to_string()
                    } else {
                        error
                    }
                })?
                .into_iter()
                .map(|event| {
                    let mut value = json!({
                        "at": event.at,
                        "sessionID": event.session_id,
                        "action": event.action,
                        "bundleID": event.bundle_id,
                        "pid": event.pid,
                        "windowID": event.window_id,
                        "revision": event.revision,
                    });
                    if let Some(effect) = event.effect {
                        value["effect"] = json!(effect);
                    }
                    if let Some(shot) = event.screenshot {
                        let mut image = json!({"sha256": shot.sha256});
                        if let Some(width) = shot.width {
                            image["width"] = json!(width);
                        }
                        if let Some(height) = shot.height {
                            image["height"] = json!(height);
                        }
                        if let Some(scale) = shot.scale {
                            image["scale"] = json!(scale);
                        }
                        value["screenshot"] = image;
                    }
                    value
                })
                .collect();
                Ok(json!({"type":"history","op":"read","events":events}))
            }
            _ => Ok(json!({
                "type":"history",
                "op":"clear",
                "cleared": super::history::clear(&directory, Some(session))?,
            })),
        };
    }
    let operation = input
        .operation()
        .ok_or_else(|| "Missing computer operation".to_string())?;
    let metadata = json!({"operation":operation.as_str(),"platform":"macos"});
    if let Input::Inspect {
        target: Target::Finder { path },
    } = &input
    {
        let resolved = policy.resolve(path, false).await?;
        if let Some(permission) = resolved.external_directory.clone() {
            policy.permission(context, permission).await?;
        }
        authorize(policy,context,vec![resolved.resource],json!({"platform":"macos","application":"finder","identity":{"kind":"macos.bundle_id","value":"com.apple.finder"}})).await?;
        return result_output(
            service
                .execute(
                    Request::inspect(
                        context.owner.clone(),
                        Target::Finder {
                            path: resolved.canonical,
                        },
                    )
                    .map_err(|e| e.to_string())?,
                )
                .await
                .map_err(|e| e.to_string())?,
        );
    }
    if let Input::Act {
        target: Target::Finder { path },
        revision,
        action: Action::Move { destination },
    } = &input
    {
        let source = policy.resolve(path, false).await?;
        if let Some(permission) = source.external_directory.clone() {
            policy.permission(context, permission).await?;
        }
        let directory = policy.resolve(destination, true).await?;
        let name = std::path::Path::new(&source.canonical)
            .file_name()
            .ok_or_else(|| "Finder source has no basename".to_string())?;
        let path = std::path::Path::new(&directory.canonical).join(name);
        let path = path
            .to_str()
            .ok_or_else(|| "Finder path is not UTF-8".to_string())?;
        let destination = policy.resolve(path, false).await?;
        if let Some(permission) = destination.external_directory.clone() {
            policy.permission(context, permission).await?;
        }
        authorize(policy,context,vec![source.resource,destination.resource],json!({"platform":"macos","application":"finder","identity":{"kind":"macos.bundle_id","value":"com.apple.finder"}})).await?;
        let _held=Held(policy.review(context,Review {action:"file_mutation".into(),resources:vec![source.canonical.clone(),destination.canonical],metadata:json!({"operation":"finder.move","platform":"macos","application":"finder"}),skip_review:true}).await?);
        return result_output(
            service
                .execute(
                    Request::act(
                        context.owner.clone(),
                        Target::Finder {
                            path: source.canonical,
                        },
                        revision.clone(),
                        Action::Move {
                            destination: directory.canonical,
                        },
                    )
                    .map_err(|e| e.to_string())?,
                )
                .await
                .map_err(|e| e.to_string())?,
        );
    }
    let resource = match &input {
        Input::List => "macos.desktop/list".into(),
        Input::Launch {
            bundle,
            remote_debugging,
        } => format!(
            "macos.bundle_id/{bundle}/{}",
            if *remote_debugging {
                "remote_debugging"
            } else {
                "launch"
            }
        ),
        Input::Quit { bundle, .. } => format!("macos.bundle_id/{bundle}/quit"),
        Input::BrowserTabs { bundle } => {
            format!("macos.bundle_id/{}/webbrowser.tabs", bundle.as_str())
        }
        Input::BrowserAct {
            target: Target::Browser { bundle_id, .. },
            ..
        } => format!(
            "macos.bundle_id/{}/{}",
            bundle_id.as_str(),
            operation.as_str()
        ),
        Input::Stage {
            target: Target::Desktop { bundle_id, .. },
            ..
        }
        | Input::Unstage {
            target: Target::Desktop { bundle_id, .. },
        } => format!("macos.bundle_id/{bundle_id}/stage"),
        Input::Inspect { target }
        | Input::Capture { target }
        | Input::Observe { target }
        | Input::Query { target, .. }
        | Input::Act { target, .. } => match target {
            Target::Desktop {
                bundle_id,
                pid,
                window_id,
            } => format!("macos.bundle_id/{bundle_id}/{pid}/{window_id}"),
            Target::Iterm {
                window_id,
                tab_index,
                session_id,
            } => format!(
                "macos.bundle_id/com.googlecode.iterm2/{window_id}/{tab_index}/{session_id}"
            ),
            _ => return Err("Invalid native target".into()),
        },
        _ => return Err("Invalid native operation target".into()),
    };
    let application = match &input {
        Input::BrowserTabs { .. } | Input::BrowserAct { .. } => "webbrowser",
        Input::Inspect { target } | Input::Act { target, .. } => target.application(),
        _ => "desktop",
    };
    let mut permission_metadata = json!({"platform":"macos","application":application});
    if let Input::BrowserTabs { bundle } = &input {
        permission_metadata["bundleID"] = json!(bundle.as_str());
    }
    if let Input::BrowserAct {
        target: Target::Browser { bundle_id, .. },
        ..
    } = &input
    {
        permission_metadata["bundleID"] = json!(bundle_id.as_str());
    }
    let evaluation = gated_bundle(&input).map(super::policy::evaluate_from_env);
    if let Some(evaluation) = &evaluation
        && evaluation.decision == super::policy::Decision::Forbidden
    {
        return Err(NativeError::new(
            Code::AppNotAllowed,
            format!(
                "Computer Use is not allowed to use {} ({})",
                evaluation.bundle_id, evaluation.reason
            ),
            Outcome::NotStarted,
        )
        .to_string());
    }
    let save = if evaluation
        .as_ref()
        .is_some_and(|evaluation| evaluation.decision == super::policy::Decision::Elevated)
    {
        Vec::new()
    } else {
        vec![resource.clone()]
    };
    authorize_with_save(
        policy,
        context,
        vec![resource.clone()],
        save,
        permission_metadata.clone(),
    )
    .await?;
    let review = if let Input::Act {
        action: Action::SendText { text, .. },
        ..
    } = &input
    {
        Some(Review {
            action: "shell".into(),
            resources: vec![text.clone()],
            metadata: json!({"application":"iterm","platform":"macos"}),
            skip_review: true,
        })
    } else if matches!(
        input,
        Input::Inspect {
            target: Target::Iterm { .. }
        }
    ) {
        None
    } else {
        let mut resources = vec![resource];
        if let Input::Act { action, .. } = &input {
            match action {
                Action::Click { element, x, y, .. } => {
                    if let Some(element) = element {
                        resources.push(format!(
                            "element/{}",
                            element
                                .iter()
                                .map(u32::to_string)
                                .collect::<Vec<_>>()
                                .join("/")
                        ));
                    }
                    if let (Some(x), Some(y)) = (x, y) {
                        resources.push(format!("point/{x}/{y}"));
                    }
                }
                Action::Type { element, text } => {
                    if let Some(element) = element {
                        resources.push(format!(
                            "element/{}",
                            element
                                .iter()
                                .map(u32::to_string)
                                .collect::<Vec<_>>()
                                .join("/")
                        ));
                    }
                    resources.push(text.clone());
                }
                Action::Scroll { element, direction } => {
                    resources.push(format!(
                        "element/{}",
                        element
                            .iter()
                            .map(u32::to_string)
                            .collect::<Vec<_>>()
                            .join("/")
                    ));
                    resources.push(direction.clone());
                }
                Action::ScrollPixels { x, y, .. } => resources.push(format!("point/{x}/{y}")),
                Action::Key {
                    element: Some(element),
                    ..
                } => resources.push(format!(
                    "element/{}",
                    element
                        .iter()
                        .map(u32::to_string)
                        .collect::<Vec<_>>()
                        .join("/")
                )),
                _ => {}
            }
        }
        let mut metadata = metadata;
        metadata["application"] = json!(application);
        if let Some(bundle) = permission_metadata.get("bundleID") {
            metadata["bundleID"] = bundle.clone();
        }
        Some(Review {
            action: "computer".into(),
            resources,
            metadata,
            skip_review: true,
        })
    };
    let _held = match review {
        Some(review) => Some(Held(policy.review(context, review).await?)),
        None => None,
    };
    let request = match input {
        Input::List => Request::list(context.owner.clone()),
        Input::Launch {
            bundle,
            remote_debugging,
        } => Request::launch(context.owner.clone(), bundle, remote_debugging),
        Input::Quit { bundle, pid } => Request::quit(context.owner.clone(), bundle, pid),
        Input::Inspect { target } => {
            Request::inspect(context.owner.clone(), target).map_err(|e| e.to_string())?
        }
        Input::Capture { target } => {
            Request::capture(context.owner.clone(), target).map_err(|e| e.to_string())?
        }
        Input::Observe { target } => {
            let request =
                Request::observe(context.owner.clone(), target).map_err(|e| e.to_string())?;
            let (success, diff) = service.observe(request).await.map_err(|e| e.to_string())?;
            let mut output = result_output(success)?;
            if !diff.is_empty() {
                output["diff"] = json!(diff);
            }
            return Ok(output);
        }
        Input::Query { target, fields } => {
            Request::query(context.owner.clone(), target, fields).map_err(|e| e.to_string())?
        }
        Input::Act {
            target,
            revision,
            action,
        } => Request::act(context.owner.clone(), target, revision, action)
            .map_err(|e| e.to_string())?,
        Input::BrowserTabs { bundle } => Request::browser_tabs(context.owner.clone(), bundle),
        Input::BrowserAct {
            target,
            revision,
            action,
        } => Request::browser_action(context.owner.clone(), target, revision, action)
            .map_err(|e| e.to_string())?,
        Input::Stage { target, revision } => {
            return result_output(
                service
                    .stage(context.owner.clone(), target, revision)
                    .await
                    .map_err(|e| e.to_string())?,
            );
        }
        Input::Unstage { target } => {
            return result_output(
                service
                    .unstage(context.owner.clone(), target)
                    .await
                    .map_err(|e| e.to_string())?,
            );
        }
        _ => return Err("Invalid computer operation".into()),
    };
    result_output(service.execute(request).await.map_err(|e| e.to_string())?)
}
async fn authorize(
    policy: &dyn Policy,
    context: &Context,
    resources: Vec<String>,
    metadata: Value,
) -> Result<(), String> {
    let save = resources.clone();
    authorize_with_save(policy, context, resources, save, metadata).await
}

async fn authorize_with_save(
    policy: &dyn Policy,
    context: &Context,
    resources: Vec<String>,
    save: Vec<String>,
    metadata: Value,
) -> Result<(), String> {
    policy
        .permission(
            context,
            Permission {
                action: "computer".into(),
                save,
                resources,
                metadata,
                consume_review: true,
            },
        )
        .await
        .map_err(String::from)
}

fn gated_bundle(input: &Input) -> Option<&str> {
    let target = match input {
        Input::Inspect { target }
        | Input::Capture { target }
        | Input::Observe { target }
        | Input::Query { target, .. }
        | Input::Stage { target, .. }
        | Input::Unstage { target }
        | Input::Act { target, .. } => Some(target),
        _ => None,
    };
    match target {
        Some(Target::Desktop { bundle_id, .. }) => Some(bundle_id),
        _ => match input {
            Input::Launch { bundle, .. } | Input::Quit { bundle, .. } => Some(bundle),
            _ => None,
        },
    }
}

pub fn result_output(result: Success) -> Result<Value, String> {
    if result
        .detail
        .get("value")
        .and_then(Value::as_str)
        .is_some_and(|v| v.len() > 16_384)
    {
        return Err("Evaluated value exceeds 16384 UTF-8 bytes".into());
    }
    let mut output =
        json!({"type":"result","action":result.action.as_str(),"revision":result.revision});
    for name in [
        "accessible",
        "effect",
        "elements",
        "width",
        "height",
        "scale",
        "apps",
        "pid",
        "exited",
        "value",
        "truncated",
    ] {
        if let Some(value) = result.detail.get(name) {
            output[name] = value.clone();
        }
    }
    if let Some(image) = result
        .detail
        .get("image")
        .filter(|value| value.as_str().is_some_and(|s| !s.is_empty()))
    {
        output["image"] = image.clone();
    }
    if let Some(windows) = result
        .detail
        .get("browserWindows")
        .or_else(|| result.detail.get("windows"))
    {
        output["windows"] = windows.clone();
    }
    if let Some(tab) = result.detail.get("tabIndex") {
        output["tab_index"] = tab.clone();
    }
    Ok(output)
}
pub fn model_output(output: &Value) -> Vec<Value> {
    if output.get("type") == Some(&json!("result"))
        && let Some(image) = output
            .get("image")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
    {
        return vec![
            json!({"type":"text","text":json!({"type":"result","action":output["action"],"revision":output["revision"],"image":"image/jpeg","width":output["width"],"height":output["height"],"scale":output["scale"]}).to_string()}),
            json!({"type":"file","data":image,"mime":"image/jpeg","name":"desktop-window.jpg"}),
        ];
    }
    vec![json!({"type":"text","text":output.to_string()})]
}
