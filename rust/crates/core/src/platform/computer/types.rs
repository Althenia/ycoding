use serde_json::{Value, json};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Outcome {
    NotStarted,
    Unknown,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Code {
    UnsupportedPlatform,
    HelperUnavailable,
    InvalidRequest,
    InvalidResponse,
    AppNotRunning,
    AutomationDenied,
    AccessibilityDenied,
    ScreenRecordingDenied,
    TargetNotFound,
    StaleRevision,
    TargetConflict,
    NativeFailure,
    UnknownOutcome,
    BackgroundUnavailable,
    FocusRestoreFailed,
    InspectorCloseFailed,
    QuitPending,
    WindowOffSpace,
    WindowFullScreen,
    WindowMinimized,
    AppHidden,
}
impl Code {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::UnsupportedPlatform => "unsupported_platform",
            Self::HelperUnavailable => "helper_unavailable",
            Self::InvalidRequest => "invalid_request",
            Self::InvalidResponse => "invalid_response",
            Self::AppNotRunning => "app_not_running",
            Self::AutomationDenied => "automation_denied",
            Self::AccessibilityDenied => "accessibility_denied",
            Self::ScreenRecordingDenied => "screen_recording_denied",
            Self::TargetNotFound => "target_not_found",
            Self::StaleRevision => "stale_revision",
            Self::TargetConflict => "target_conflict",
            Self::NativeFailure => "native_failure",
            Self::UnknownOutcome => "unknown_outcome",
            Self::BackgroundUnavailable => "background_unavailable",
            Self::FocusRestoreFailed => "focus_restore_failed",
            Self::InspectorCloseFailed => "inspector_close_failed",
            Self::QuitPending => "quit_pending",
            Self::WindowOffSpace => "window_off_space",
            Self::WindowFullScreen => "window_full_screen",
            Self::WindowMinimized => "window_minimized",
            Self::AppHidden => "app_hidden",
        }
    }
    pub fn parse(value: &str) -> Option<Self> {
        [
            Self::UnsupportedPlatform,
            Self::HelperUnavailable,
            Self::InvalidRequest,
            Self::InvalidResponse,
            Self::AppNotRunning,
            Self::AutomationDenied,
            Self::AccessibilityDenied,
            Self::ScreenRecordingDenied,
            Self::TargetNotFound,
            Self::StaleRevision,
            Self::TargetConflict,
            Self::NativeFailure,
            Self::UnknownOutcome,
            Self::BackgroundUnavailable,
            Self::FocusRestoreFailed,
            Self::InspectorCloseFailed,
            Self::QuitPending,
            Self::WindowOffSpace,
            Self::WindowFullScreen,
            Self::WindowMinimized,
            Self::AppHidden,
        ]
        .into_iter()
        .find(|code| code.as_str() == value)
    }
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NativeError {
    pub code: Code,
    pub message: String,
    pub outcome: Option<Outcome>,
}
impl NativeError {
    pub fn new(code: Code, message: impl Into<String>, outcome: Outcome) -> Self {
        Self {
            code,
            message: message.into(),
            outcome: Some(outcome),
        }
    }
}
impl std::fmt::Display for NativeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code.as_str(), self.message)
    }
}
impl std::error::Error for NativeError {}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BrowserBundle {
    Safari,
    Chrome,
}
impl BrowserBundle {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Safari => "com.apple.Safari",
            Self::Chrome => "com.google.Chrome",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Target {
    Iterm {
        window_id: u64,
        tab_index: u64,
        session_id: String,
    },
    Finder {
        path: String,
    },
    Desktop {
        bundle_id: String,
        pid: u32,
        window_id: u64,
    },
    Browser {
        bundle_id: BrowserBundle,
        window_id: String,
        tab_index: u32,
    },
}
impl Target {
    pub fn key(&self) -> String {
        match self {
            Self::Iterm {
                window_id,
                tab_index,
                session_id,
            } => format!("macos\0iterm\0{window_id}\0{tab_index}\0{session_id}"),
            Self::Finder { path } => format!("macos\0finder\0{path}"),
            Self::Desktop {
                bundle_id,
                pid,
                window_id,
            } => format!("macos\0desktop\0{bundle_id}\0{pid}\0{window_id}"),
            Self::Browser {
                bundle_id,
                window_id,
                ..
            } => format!("macos\0webbrowser\0{}\0{window_id}", bundle_id.as_str()),
        }
    }
    pub fn encode(&self) -> Value {
        match self {
            Self::Iterm {
                window_id,
                tab_index,
                session_id,
            } => {
                json!({"platform":"macos","application":"iterm","windowID":window_id,"tabIndex":tab_index,"sessionID":session_id})
            }
            Self::Finder { path } => json!({"platform":"macos","application":"finder","path":path}),
            Self::Desktop {
                bundle_id,
                pid,
                window_id,
            } => {
                json!({"platform":"macos","application":"desktop","bundleID":bundle_id,"pid":pid,"windowID":window_id})
            }
            Self::Browser {
                bundle_id,
                window_id,
                tab_index,
            } => {
                json!({"platform":"macos","application":"webbrowser","bundleID":bundle_id.as_str(),"windowID":window_id,"tabIndex":tab_index})
            }
        }
    }
    pub fn application(&self) -> &'static str {
        match self {
            Self::Iterm { .. } => "iterm",
            Self::Finder { .. } => "finder",
            Self::Desktop { .. } => "desktop",
            Self::Browser { .. } => "webbrowser",
        }
    }
    pub fn validate(&self) -> Result<(), NativeError> {
        let valid = match self {
            Self::Iterm {
                window_id,
                tab_index,
                ..
            } => *window_id > 0 && *tab_index > 0,
            Self::Finder { .. } => true,
            Self::Desktop {
                bundle_id,
                pid,
                window_id,
            } => !bundle_id.is_empty() && *pid > 0 && *window_id > 0,
            Self::Browser {
                window_id,
                tab_index,
                ..
            } => !window_id.is_empty() && (1..=100).contains(tab_index),
        };
        if valid {
            return Ok(());
        }
        Err(NativeError::new(
            Code::InvalidRequest,
            "Invalid explicit native target",
            Outcome::NotStarted,
        ))
    }
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Owner {
    pub session_id: String,
    pub call_id: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Action {
    SendText {
        text: String,
        newline: bool,
    },
    Move {
        destination: String,
    },
    Click {
        element: Option<Vec<u32>>,
        x: Option<u32>,
        y: Option<u32>,
        button: Option<String>,
        count: Option<u32>,
    },
    Drag {
        from_x: u32,
        from_y: u32,
        to_x: u32,
        to_y: u32,
    },
    Type {
        element: Option<Vec<u32>>,
        text: String,
    },
    Scroll {
        element: Vec<u32>,
        direction: String,
    },
    ScrollPixels {
        x: u32,
        y: u32,
        delta_x: i64,
        delta_y: i64,
    },
    Key {
        element: Option<Vec<u32>>,
        key: String,
        modifiers: Vec<String>,
    },
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum BrowserAction {
    Navigate { url: String },
    Back,
    Forward,
    Reload,
    NewTab { url: Option<String> },
    CloseTab,
    Evaluate { script: String },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Operation {
    ItermInspect,
    ItermSendText,
    FinderInspect,
    FinderMove,
    DesktopInspect,
    DesktopList,
    DesktopLaunch,
    DesktopQuit,
    DesktopCapture,
    DesktopClick,
    DesktopDrag,
    DesktopType,
    DesktopScroll,
    DesktopKey,
    DesktopStage,
    DesktopUnstage,
    DisplayHold,
    BrowserTabs,
    BrowserNavigate,
    BrowserBack,
    BrowserForward,
    BrowserReload,
    BrowserNewTab,
    BrowserCloseTab,
    BrowserEvaluate,
}
impl Operation {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::ItermInspect => "iterm.inspect",
            Self::ItermSendText => "iterm.send_text",
            Self::FinderInspect => "finder.inspect",
            Self::FinderMove => "finder.move",
            Self::DesktopInspect => "desktop.inspect",
            Self::DesktopList => "desktop.list",
            Self::DesktopLaunch => "desktop.launch",
            Self::DesktopQuit => "desktop.quit",
            Self::DesktopCapture => "desktop.capture",
            Self::DesktopClick => "desktop.click",
            Self::DesktopDrag => "desktop.drag",
            Self::DesktopType => "desktop.type",
            Self::DesktopScroll => "desktop.scroll",
            Self::DesktopKey => "desktop.key",
            Self::DesktopStage => "desktop.stage",
            Self::DesktopUnstage => "desktop.unstage",
            Self::DisplayHold => "display.hold",
            Self::BrowserTabs => "webbrowser.tabs",
            Self::BrowserNavigate => "webbrowser.navigate",
            Self::BrowserBack => "webbrowser.back",
            Self::BrowserForward => "webbrowser.forward",
            Self::BrowserReload => "webbrowser.reload",
            Self::BrowserNewTab => "webbrowser.new_tab",
            Self::BrowserCloseTab => "webbrowser.close_tab",
            Self::BrowserEvaluate => "webbrowser.eval",
        }
    }
    pub fn parse(value: &str) -> Option<Self> {
        [
            Self::ItermInspect,
            Self::ItermSendText,
            Self::FinderInspect,
            Self::FinderMove,
            Self::DesktopInspect,
            Self::DesktopList,
            Self::DesktopLaunch,
            Self::DesktopQuit,
            Self::DesktopCapture,
            Self::DesktopClick,
            Self::DesktopDrag,
            Self::DesktopType,
            Self::DesktopScroll,
            Self::DesktopKey,
            Self::DesktopStage,
            Self::DesktopUnstage,
            Self::DisplayHold,
            Self::BrowserTabs,
            Self::BrowserNavigate,
            Self::BrowserBack,
            Self::BrowserForward,
            Self::BrowserReload,
            Self::BrowserNewTab,
            Self::BrowserCloseTab,
            Self::BrowserEvaluate,
        ]
        .into_iter()
        .find(|operation| operation.as_str() == value)
    }
    pub fn mutating(self) -> bool {
        !matches!(
            self,
            Self::ItermInspect
                | Self::FinderInspect
                | Self::DesktopInspect
                | Self::DesktopCapture
                | Self::DesktopList
                | Self::DisplayHold
                | Self::BrowserTabs
        )
    }
    pub fn desktop_mutation(self) -> bool {
        matches!(
            self,
            Self::DesktopQuit
                | Self::DesktopClick
                | Self::DesktopDrag
                | Self::DesktopType
                | Self::DesktopScroll
                | Self::DesktopKey
                | Self::DesktopStage
                | Self::DesktopUnstage
        )
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Request {
    pub owner: Owner,
    pub target: Option<Target>,
    pub operation: Operation,
    pub expected_revision: Option<String>,
    fields: Value,
}
impl Request {
    fn new(
        owner: Owner,
        target: Option<Target>,
        operation: Operation,
        expected_revision: Option<String>,
        fields: Value,
    ) -> Result<Self, NativeError> {
        if let Some(target) = &target {
            target.validate()?;
        }
        Ok(Self {
            owner,
            target,
            operation,
            expected_revision,
            fields,
        })
    }
    pub fn inspect(owner: Owner, target: Target) -> Result<Self, NativeError> {
        let operation = match target {
            Target::Iterm { .. } => Operation::ItermInspect,
            Target::Finder { .. } => Operation::FinderInspect,
            Target::Desktop { .. } => Operation::DesktopInspect,
            Target::Browser { .. } => {
                return Err(NativeError::new(
                    Code::InvalidRequest,
                    "Use browserTabs to inspect browser windows and tabs",
                    Outcome::NotStarted,
                ));
            }
        };
        Self::new(owner, Some(target), operation, None, json!({}))
    }
    pub fn capture(owner: Owner, target: Target) -> Result<Self, NativeError> {
        if !matches!(target, Target::Desktop { .. }) {
            return Err(NativeError::new(
                Code::InvalidRequest,
                "Capture requires a desktop target",
                Outcome::NotStarted,
            ));
        }
        Self::new(
            owner,
            Some(target),
            Operation::DesktopCapture,
            None,
            json!({}),
        )
    }
    pub fn list(owner: Owner) -> Self {
        Self {
            owner,
            target: None,
            operation: Operation::DesktopList,
            expected_revision: None,
            fields: json!({}),
        }
    }
    pub fn launch(owner: Owner, bundle_id: String, remote_debugging: bool) -> Self {
        Self {
            owner,
            target: None,
            operation: Operation::DesktopLaunch,
            expected_revision: None,
            fields: json!({"bundleID":bundle_id,"remoteDebugging":remote_debugging}),
        }
    }
    pub fn quit(owner: Owner, bundle_id: String, pid: u32) -> Self {
        Self {
            owner,
            target: None,
            operation: Operation::DesktopQuit,
            expected_revision: None,
            fields: json!({"bundleID":bundle_id,"pid":pid}),
        }
    }
    pub fn browser_tabs(owner: Owner, bundle_id: BrowserBundle) -> Self {
        Self {
            owner,
            target: None,
            operation: Operation::BrowserTabs,
            expected_revision: None,
            fields: json!({"bundleID":bundle_id.as_str()}),
        }
    }
    pub fn stage(
        owner: Owner,
        target: Target,
        revision: String,
        display_id: u32,
    ) -> Result<Self, NativeError> {
        if !matches!(target, Target::Desktop { .. }) {
            return Err(NativeError::new(
                Code::InvalidRequest,
                "Stage requires a desktop target",
                Outcome::NotStarted,
            ));
        }
        Self::new(
            owner,
            Some(target),
            Operation::DesktopStage,
            Some(revision),
            json!({"displayID":display_id}),
        )
    }
    pub fn unstage(
        owner: Owner,
        target: Target,
        frame: super::electron::Rect,
    ) -> Result<Self, NativeError> {
        Self::new(
            owner,
            Some(target),
            Operation::DesktopUnstage,
            None,
            json!({"originalFrame":{"x":frame.x,"y":frame.y,"width":frame.width,"height":frame.height}}),
        )
    }
    pub fn display_hold(owner: Owner, control_directory: String, owner_pid: u32) -> Self {
        Self {
            owner,
            target: None,
            operation: Operation::DisplayHold,
            expected_revision: None,
            fields: json!({"controlDirectory":control_directory,"ownerPID":owner_pid}),
        }
    }
    pub fn browser_action(
        owner: Owner,
        target: Target,
        revision: String,
        action: BrowserAction,
    ) -> Result<Self, NativeError> {
        if !matches!(target, Target::Browser { .. }) {
            return Err(NativeError::new(
                Code::InvalidRequest,
                "Browser action requires a browser target",
                Outcome::NotStarted,
            ));
        }
        let (operation, fields) = match action {
            BrowserAction::Navigate { url } => {
                validate_web_url(&url)?;
                (Operation::BrowserNavigate, json!({"url":url}))
            }
            BrowserAction::Back => (Operation::BrowserBack, json!({})),
            BrowserAction::Forward => (Operation::BrowserForward, json!({})),
            BrowserAction::Reload => (Operation::BrowserReload, json!({})),
            BrowserAction::CloseTab => (Operation::BrowserCloseTab, json!({})),
            BrowserAction::NewTab { url } => {
                if let Some(url) = &url {
                    validate_web_url(url)?;
                }
                (
                    Operation::BrowserNewTab,
                    match url {
                        Some(url) => json!({"url":url}),
                        None => json!({}),
                    },
                )
            }
            BrowserAction::Evaluate { script } => {
                if script.len() > 65_536 {
                    return Err(NativeError::new(
                        Code::InvalidRequest,
                        "JavaScript source exceeds 65536 UTF-8 bytes",
                        Outcome::NotStarted,
                    ));
                }
                (Operation::BrowserEvaluate, json!({"script":script}))
            }
        };
        Self::new(owner, Some(target), operation, Some(revision), fields)
    }
    pub fn act(
        owner: Owner,
        target: Target,
        revision: String,
        action: Action,
    ) -> Result<Self, NativeError> {
        let mismatch = || {
            NativeError::new(
                Code::InvalidRequest,
                "The macOS action does not match the target application",
                Outcome::NotStarted,
            )
        };
        let (operation, fields) = match action {
            Action::SendText { text, newline } if matches!(target, Target::Iterm { .. }) => (
                Operation::ItermSendText,
                json!({"text":text,"newline":newline}),
            ),
            Action::Move { destination } if matches!(target, Target::Finder { .. }) => {
                (Operation::FinderMove, json!({"destination":destination}))
            }
            Action::Click {
                element,
                x,
                y,
                button,
                count,
            } if matches!(target, Target::Desktop { .. }) => {
                if element.as_ref().is_some_and(|e| e.len() > 12)
                    || (element.is_none() && (x.is_none() || y.is_none()))
                    || button
                        .as_ref()
                        .is_some_and(|b| !matches!(b.as_str(), "left" | "right"))
                    || count.is_some_and(|c| !matches!(c, 1 | 2))
                {
                    return Err(mismatch());
                }
                let mut value = match element {
                    Some(element) => json!({"element":element}),
                    None => json!({"x":x,"y":y}),
                };
                if let Some(button) = button {
                    value["button"] = json!(button);
                }
                if let Some(count) = count {
                    value["count"] = json!(count);
                }
                (Operation::DesktopClick, value)
            }
            Action::Drag {
                from_x,
                from_y,
                to_x,
                to_y,
            } if matches!(target, Target::Desktop { .. }) => (
                Operation::DesktopDrag,
                json!({"fromX":from_x,"fromY":from_y,"toX":to_x,"toY":to_y}),
            ),
            Action::Type { element, text } if matches!(target, Target::Desktop { .. }) => {
                if text.encode_utf16().count() > 4096
                    || element.as_ref().is_some_and(|e| e.len() > 12)
                {
                    return Err(mismatch());
                }
                let mut value = json!({"text":text});
                if let Some(element) = element {
                    value["element"] = json!(element);
                }
                (Operation::DesktopType, value)
            }
            Action::Scroll { element, direction } if matches!(target, Target::Desktop { .. }) => {
                if element.len() > 12 || !matches!(direction.as_str(), "up" | "down") {
                    return Err(mismatch());
                }
                (
                    Operation::DesktopScroll,
                    json!({"element":element,"direction":direction}),
                )
            }
            Action::ScrollPixels {
                x,
                y,
                delta_x,
                delta_y,
            } if matches!(target, Target::Desktop { .. }) => (
                Operation::DesktopScroll,
                json!({"x":x,"y":y,"deltaX":delta_x,"deltaY":delta_y}),
            ),
            Action::Key {
                element,
                key,
                modifiers,
            } if matches!(target, Target::Desktop { .. }) => {
                if element.as_ref().is_some_and(|e| e.len() > 12)
                    || !valid_key(&key)
                    || modifiers.iter().any(|m| {
                        !matches!(
                            m.as_str(),
                            "command" | "shift" | "option" | "control" | "fn"
                        )
                    })
                {
                    return Err(mismatch());
                }
                let mut value = json!({"key":key,"modifiers":modifiers});
                if let Some(element) = element {
                    value["element"] = json!(element);
                }
                (Operation::DesktopKey, value)
            }
            _ => return Err(mismatch()),
        };
        Self::new(owner, Some(target), operation, Some(revision), fields)
    }
    pub fn encode(&self) -> Value {
        let mut value = self.fields.clone();
        value["action"] = json!(self.operation.as_str());
        value["owner"] = json!({"sessionID":self.owner.session_id,"callID":self.owner.call_id});
        if let Some(target) = &self.target {
            value["target"] = target.encode();
        }
        if let Some(revision) = &self.expected_revision {
            value["expectedRevision"] = json!(revision);
        }
        value
    }
    pub fn fields(&self) -> &Value {
        &self.fields
    }
}

pub fn valid_key(key: &str) -> bool {
    matches!(
        key,
        "enter"
            | "return"
            | "tab"
            | "escape"
            | "space"
            | "delete"
            | "forward_delete"
            | "up"
            | "down"
            | "left"
            | "right"
            | "home"
            | "end"
            | "page_up"
            | "page_down"
    ) || key
        .strip_prefix('f')
        .and_then(|n| n.parse::<u8>().ok())
        .is_some_and(|n| (1..=12).contains(&n) && key == format!("f{n}"))
        || (key.encode_utf16().count() == 1 && key.chars().all(|c| c > '\u{1f}' && c != '\u{7f}'))
}
pub fn validate_web_url(input: &str) -> Result<(), NativeError> {
    let valid = (input.to_ascii_lowercase().starts_with("http://")
        || input.to_ascii_lowercase().starts_with("https://"))
        && url::Url::parse(input)
            .ok()
            .is_some_and(|url| matches!(url.scheme(), "http" | "https") && url.has_host());
    if valid {
        return Ok(());
    }
    Err(NativeError::new(
        Code::InvalidRequest,
        "Expected an absolute http or https URL",
        Outcome::NotStarted,
    ))
}
#[derive(Clone, Debug, PartialEq)]
pub struct Success {
    pub action: Operation,
    pub revision: String,
    pub detail: Value,
}
