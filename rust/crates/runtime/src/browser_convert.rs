use crate::{convert, dispatch::Failure};
use ycoding_core::ycoding_schema::{
    DomainDecode, JsonValue, LosslessString, ObjectEncoder, browser, isolated_browser, session,
};
use ycoding_protocol::v5;

pub fn number<T: DomainDecode>(value: u64) -> Result<T, Failure> {
    if value > 9_007_199_254_740_991 {
        return Err(Failure::Invalid("invalid browser fence".into()));
    }
    T::decode(&JsonValue::Number(value as f64)).map_err(|error| Failure::Invalid(error.to_string()))
}

pub fn resume(value: i32) -> Result<bool, Failure> {
    match value {
        1 => Ok(false),
        2 => Ok(true),
        _ => Err(Failure::Invalid("invalid browser control".into())),
    }
}

pub fn start_input(
    value: v5::IsolatedBrowserStartPayload,
) -> Result<isolated_browser::StartInput, Failure> {
    isolated_browser::StartInput::decode(
        &ObjectEncoder::new()
            .field("url", &convert::domain(&value.url)?)
            .finish(),
    )
    .map_err(|error| Failure::Invalid(error.to_string()))
}

pub fn open_input(
    session_id: session::Id,
    value: v5::BrowserOpenRequestPayload,
) -> Result<browser::OpenInput, Failure> {
    browser::OpenInput::decode(
        &ObjectEncoder::new()
            .field("sessionID", &session_id)
            .field(
                "generation",
                &number::<browser::Generation>(value.generation)?,
            )
            .field("callID", &convert::domain(&value.call_id)?)
            .field("url", &convert::domain(&value.url)?)
            .finish(),
    )
    .map_err(|error| Failure::Invalid(error.to_string()))
}

fn wait_state(value: i32) -> Result<LosslessString, Failure> {
    match value {
        1 => Ok("attached".into()),
        2 => Ok("visible".into()),
        3 => Ok("hidden".into()),
        4 => Ok("detached".into()),
        _ => Err(Failure::Invalid("invalid browser wait state".into())),
    }
}

fn load_state(value: i32) -> Result<LosslessString, Failure> {
    match value {
        1 => Ok("domcontentloaded".into()),
        2 => Ok("load".into()),
        3 => Ok("networkidle".into()),
        _ => Err(Failure::Invalid("invalid browser load state".into())),
    }
}

fn modifier(value: i32) -> Result<LosslessString, Failure> {
    match value {
        1 => Ok("Alt".into()),
        2 => Ok("Control".into()),
        3 => Ok("Meta".into()),
        4 => Ok("Shift".into()),
        _ => Err(Failure::Invalid("invalid browser key modifier".into())),
    }
}

macro_rules! browser_action {
    ($name:ident, $payload:ty, $kind:path) => {
        pub fn $name(value: $payload) -> Result<browser::Action, Failure> {
            use $kind as Kind;
            let tag = |name: &str| LosslessString::from(name);
            let tabs = |items: &[v5::LosslessString]| {
                items
                    .iter()
                    .map(convert::domain)
                    .collect::<Result<Vec<_>, _>>()
            };
            let value = match value.kind {
                Some(Kind::Value1(value)) => ObjectEncoder::new()
                    .field("type", &tag("navigate"))
                    .field("url", &convert::domain(&value.url)?)
                    .finish(),
                Some(Kind::Value2(value)) => ObjectEncoder::new()
                    .field("type", &tag("click"))
                    .optional(
                        "ref",
                        &value.r#ref.as_ref().map(convert::domain).transpose()?,
                    )
                    .optional(
                        "locator",
                        &value.locator.as_ref().map(convert::domain).transpose()?,
                    )
                    .finish(),
                Some(Kind::Value3(value)) => ObjectEncoder::new()
                    .field("type", &tag("type"))
                    .optional(
                        "ref",
                        &value.r#ref.as_ref().map(convert::domain).transpose()?,
                    )
                    .optional(
                        "locator",
                        &value.locator.as_ref().map(convert::domain).transpose()?,
                    )
                    .field("text", &convert::domain(&value.text)?)
                    .finish(),
                Some(Kind::Value4(value)) => ObjectEncoder::new()
                    .field("type", &tag("scroll"))
                    .field("deltaY", &JsonValue::Number(value.delta_y as f64))
                    .finish(),
                Some(Kind::Value5(value)) => ObjectEncoder::new()
                    .field("type", &tag("capture"))
                    .optional(
                        "ref",
                        &value.r#ref.as_ref().map(convert::domain).transpose()?,
                    )
                    .optional(
                        "clip",
                        &value.clip.as_ref().map(|clip| {
                            ObjectEncoder::new()
                                .field("x", &JsonValue::Number(clip.x as f64))
                                .field("y", &JsonValue::Number(clip.y as f64))
                                .field("width", &JsonValue::Number(clip.width as f64))
                                .field("height", &JsonValue::Number(clip.height as f64))
                                .finish()
                        }),
                    )
                    .optional("fullPage", &value.full_page)
                    .finish(),
                Some(Kind::Value6(value)) => ObjectEncoder::new()
                    .field("type", &tag("group"))
                    .field("tabIDs", &tabs(&value.tab_i_ds.items)?)
                    .field("title", &convert::domain(&value.title)?)
                    .finish(),
                Some(Kind::Value7(value)) => ObjectEncoder::new()
                    .field("type", &tag("ungroup"))
                    .field("tabIDs", &tabs(&value.tab_i_ds.items)?)
                    .field(
                        "groupID",
                        &number::<browser::ObservationRevision>(value.group_id)?,
                    )
                    .finish(),
                Some(Kind::Value8(_)) => ObjectEncoder::new().field("type", &tag("back")).finish(),
                Some(Kind::Value9(_)) => {
                    ObjectEncoder::new().field("type", &tag("forward")).finish()
                }
                Some(Kind::Value10(_)) => {
                    ObjectEncoder::new().field("type", &tag("reload")).finish()
                }
                Some(Kind::Value11(value)) => ObjectEncoder::new()
                    .field("type", &tag("key"))
                    .field("key", &convert::domain(&value.key)?)
                    .optional(
                        "modifiers",
                        &value
                            .modifiers
                            .map(|modifiers| {
                                modifiers
                                    .items
                                    .iter()
                                    .map(|item| modifier(*item))
                                    .collect::<Result<Vec<_>, _>>()
                            })
                            .transpose()?,
                    )
                    .finish(),
                Some(Kind::Value12(value)) => ObjectEncoder::new()
                    .field("type", &tag("wait"))
                    .optional(
                        "ref",
                        &value.r#ref.as_ref().map(convert::domain).transpose()?,
                    )
                    .optional(
                        "locator",
                        &value.locator.as_ref().map(convert::domain).transpose()?,
                    )
                    .optional("state", &value.state.map(wait_state).transpose()?)
                    .optional("url", &value.url.as_ref().map(convert::domain).transpose()?)
                    .optional("load", &value.load.map(load_state).transpose()?)
                    .optional(
                        "text",
                        &value.text.as_ref().map(convert::domain).transpose()?,
                    )
                    .optional(
                        "timeoutMs",
                        &value
                            .timeout_ms
                            .map(|value| JsonValue::Number(value as f64)),
                    )
                    .finish(),
                Some(Kind::Value13(_)) => ObjectEncoder::new()
                    .field("type", &tag("clipboard_read"))
                    .finish(),
                Some(Kind::Value14(value)) => ObjectEncoder::new()
                    .field("type", &tag("clipboard_write"))
                    .field("text", &convert::domain(&value.text)?)
                    .finish(),
                Some(Kind::Value15(value)) => ObjectEncoder::new()
                    .field("type", &tag("upload"))
                    .optional(
                        "ref",
                        &value.r#ref.as_ref().map(convert::domain).transpose()?,
                    )
                    .optional(
                        "locator",
                        &value.locator.as_ref().map(convert::domain).transpose()?,
                    )
                    .field("paths", &tabs(&value.paths.items)?)
                    .finish(),
                Some(Kind::Value16(value)) => ObjectEncoder::new()
                    .field("type", &tag("download"))
                    .optional(
                        "timeoutMs",
                        &value
                            .timeout_ms
                            .map(|value| JsonValue::Number(value as f64)),
                    )
                    .finish(),
                Some(Kind::Value17(value)) => ObjectEncoder::new()
                    .field("type", &tag("logs"))
                    .optional(
                        "limit",
                        &value.limit.map(|value| JsonValue::Number(value as f64)),
                    )
                    .finish(),
                Some(Kind::Value18(_)) => {
                    ObjectEncoder::new().field("type", &tag("export")).finish()
                }
                Some(Kind::Value19(_)) => ObjectEncoder::new()
                    .field("type", &tag("webmcp_list"))
                    .finish(),
                Some(Kind::Value20(value)) => ObjectEncoder::new()
                    .field("type", &tag("webmcp_invoke"))
                    .field("name", &convert::domain(&value.name)?)
                    .optional(
                        "arguments",
                        &value
                            .arguments
                            .as_ref()
                            .map(convert::value_to_json)
                            .transpose()?,
                    )
                    .finish(),
                Some(Kind::Value21(value)) => ObjectEncoder::new()
                    .field("type", &tag("fill"))
                    .optional(
                        "ref",
                        &value.r#ref.as_ref().map(convert::domain).transpose()?,
                    )
                    .optional(
                        "locator",
                        &value.locator.as_ref().map(convert::domain).transpose()?,
                    )
                    .field("text", &convert::domain(&value.text)?)
                    .finish(),
                Some(Kind::Value22(value)) => ObjectEncoder::new()
                    .field("type", &tag("select"))
                    .optional(
                        "ref",
                        &value.r#ref.as_ref().map(convert::domain).transpose()?,
                    )
                    .optional(
                        "locator",
                        &value.locator.as_ref().map(convert::domain).transpose()?,
                    )
                    .optional(
                        "values",
                        &value
                            .values
                            .as_ref()
                            .map(|wrapper| tabs(&wrapper.items))
                            .transpose()?,
                    )
                    .optional(
                        "labels",
                        &value
                            .labels
                            .as_ref()
                            .map(|wrapper| tabs(&wrapper.items))
                            .transpose()?,
                    )
                    .optional(
                        "indexes",
                        &value.indexes.as_ref().map(|wrapper| {
                            wrapper
                                .items
                                .iter()
                                .map(|index| JsonValue::Number(*index as f64))
                                .collect::<Vec<_>>()
                        }),
                    )
                    .finish(),
                Some(Kind::Value23(value)) => ObjectEncoder::new()
                    .field("type", &tag("check"))
                    .optional(
                        "ref",
                        &value.r#ref.as_ref().map(convert::domain).transpose()?,
                    )
                    .optional(
                        "locator",
                        &value.locator.as_ref().map(convert::domain).transpose()?,
                    )
                    .field("checked", &value.checked)
                    .finish(),
                Some(Kind::Value24(value)) => ObjectEncoder::new()
                    .field("type", &tag("hover"))
                    .optional(
                        "ref",
                        &value.r#ref.as_ref().map(convert::domain).transpose()?,
                    )
                    .optional(
                        "locator",
                        &value.locator.as_ref().map(convert::domain).transpose()?,
                    )
                    .finish(),
                Some(Kind::Value25(value)) => ObjectEncoder::new()
                    .field("type", &tag("dialog"))
                    .optional("accept", &value.accept)
                    .optional(
                        "text",
                        &value.text.as_ref().map(convert::domain).transpose()?,
                    )
                    .finish(),
                Some(Kind::Value26(value)) => ObjectEncoder::new()
                    .field("type", &tag("group_control"))
                    .field("tabIDs", &tabs(&value.tab_i_ds.items)?)
                    .finish(),
                None => return Err(Failure::Invalid("missing browser action".into())),
            };
            browser::Action::decode(&value).map_err(|error| Failure::Invalid(error.to_string()))
        }
    };
}

browser_action!(
    action,
    v5::BrowserActionRequestPayloadAction,
    v5::browser_action_request_payload_action::Kind
);
browser_action!(
    isolated_action,
    v5::IsolatedBrowserActionRequestPayloadAction,
    v5::isolated_browser_action_request_payload_action::Kind
);

pub fn status(value: &browser::Status) -> Result<v5::BrowserStatus, Failure> {
    Ok(v5::BrowserStatus {
        state: match value.state {
            browser::BridgeState::Unavailable => 1,
            browser::BridgeState::Pairing => 2,
            browser::BridgeState::Connected => 3,
            browser::BridgeState::Paused => 4,
        },
        paired: value.paired,
        profile_granted: value.profile_granted,
        generation: value.generation.map(|value| value.get() as u64),
        pairing_expires_at: value.pairing_expires_at.map(|value| value.get() as u64),
        extension_id: value.extension_id.as_ref().map(convert::wire),
        pending_call_id: value
            .pending_call_id
            .as_ref()
            .map(convert::identity)
            .transpose()?,
    })
}

pub fn page(value: &browser::Page) -> v5::BrowserPage {
    v5::BrowserPage {
        origin: convert::wire(&value.origin),
        path: convert::wire(&value.path),
    }
}

pub fn tab(value: &browser::Tab) -> Result<v5::BrowserTab, Failure> {
    Ok(v5::BrowserTab {
        id: convert::identity(&value.id)?,
        session_id: convert::wire(value.session_id.as_lossless()),
        title: convert::wire(&value.title),
        page: page(&value.page),
        status: match value.status {
            browser::TabStatus::Shared => 1,
            browser::TabStatus::Paused => 2,
            browser::TabStatus::Unavailable => 3,
        },
        generation: value.generation.get() as u64,
        document_generation: value.document_generation.get() as u64,
        observation_revision: value.observation_revision.get() as u64,
        pause_reason: value.pause_reason.map(|value| match value {
            browser::PauseReason::UserActive => 1,
            browser::PauseReason::Requested => 2,
            browser::PauseReason::Uncertain => 3,
            browser::PauseReason::Disconnected => 4,
        }),
        uncertain_call_id: value
            .uncertain_call_id
            .as_ref()
            .map(convert::identity)
            .transpose()?,
        mode: value.mode.map(|value| match value {
            browser::Mode::Owned => 1,
            browser::Mode::Profile => 2,
        }),
        lease: value.lease.map(|value| match value {
            browser::Lease::Self_ => 1,
            browser::Lease::Other => 2,
        }),
        deliverable: value.deliverable,
        group_id: value.group_id.map(|id| id.get() as u64),
    })
}

fn element_checked(value: &browser::Tristate) -> v5::BrowserElementChecked {
    use v5::browser_element_checked::Kind;
    v5::BrowserElementChecked {
        kind: Some(match value {
            browser::Tristate::Boolean(value) => Kind::Value1(*value),
            browser::Tristate::Mixed => Kind::Value2(1),
        }),
    }
}

fn element_pressed(value: &browser::Tristate) -> v5::BrowserElementPressed {
    use v5::browser_element_pressed::Kind;
    v5::BrowserElementPressed {
        kind: Some(match value {
            browser::Tristate::Boolean(value) => Kind::Value1(*value),
            browser::Tristate::Mixed => Kind::Value2(1),
        }),
    }
}

fn control_checked(value: &browser::Tristate) -> v5::BrowserControlStateChecked {
    use v5::browser_control_state_checked::Kind;
    v5::BrowserControlStateChecked {
        kind: Some(match value {
            browser::Tristate::Boolean(value) => Kind::Value1(*value),
            browser::Tristate::Mixed => Kind::Value2(1),
        }),
    }
}

fn dialog_info(value: &browser::DialogInfo) -> v5::BrowserDialogInfo {
    v5::BrowserDialogInfo {
        kind: match value.kind {
            browser::DialogKind::Alert => 1,
            browser::DialogKind::Confirm => 2,
            browser::DialogKind::Prompt => 3,
            browser::DialogKind::BeforeUnload => 4,
        },
        message: convert::wire(&value.message),
        default_prompt: value.default_prompt.as_ref().map(convert::wire),
    }
}

fn control_state(value: &browser::ControlState) -> v5::BrowserControlState {
    v5::BrowserControlState {
        checked: value.checked.as_ref().map(control_checked),
        value: value.value.as_ref().map(convert::wire),
        selected: value
            .selected
            .as_deref()
            .map(|items| v5::BrowserControlStateSelected {
                items: items
                    .iter()
                    .map(|option| v5::BrowserSelectedOption {
                        value: option.value.as_ref().map(convert::wire),
                        label: convert::wire(&option.label),
                        index: option.index.get() as u64,
                    })
                    .collect(),
            }),
        sensitive: value.sensitive,
    }
}

pub fn element(value: &browser::Element) -> v5::BrowserElement {
    v5::BrowserElement {
        r#ref: convert::wire(&value.r#ref),
        role: convert::wire(&value.role),
        name: convert::wire(&value.name),
        description: value.description.as_ref().map(convert::wire),
        disabled: value.disabled,
        checked: value.checked.as_ref().map(element_checked),
        pressed: value.pressed.as_ref().map(element_pressed),
        expanded: value.expanded,
        selected: value.selected,
        value: value.value.as_ref().map(convert::wire),
        sensitive: value.sensitive,
        locator: value.locator.as_ref().map(convert::wire),
        destination: value.destination.as_ref().map(page),
        frame: value.frame.as_ref().map(page),
    }
}

fn texts(values: &[browser::Text]) -> Vec<v5::BrowserText> {
    values
        .iter()
        .map(|text| v5::BrowserText {
            role: convert::wire(&text.role),
            name: convert::wire(&text.name),
            frame: text.frame.as_ref().map(page),
        })
        .collect()
}

fn frames(values: &[browser::Frame]) -> Vec<v5::BrowserFrame> {
    values
        .iter()
        .map(|frame| v5::BrowserFrame {
            page: page(&frame.page),
            observed: frame.observed,
        })
        .collect()
}

fn logs(values: &[browser::LogEntry]) -> Vec<v5::BrowserLogEntry> {
    values
        .iter()
        .map(|entry| v5::BrowserLogEntry {
            level: convert::wire(&entry.level),
            text: convert::wire(&entry.text),
            frame: entry.frame.as_ref().map(page),
        })
        .collect()
}

fn webmcp_tools(values: &[browser::WebMcpTool]) -> Vec<v5::BrowserWebMcpTool> {
    values
        .iter()
        .map(|tool| v5::BrowserWebMcpTool {
            name: convert::wire(&tool.name),
            description: tool.description.as_ref().map(convert::wire),
        })
        .collect()
}

fn download(value: &browser::DownloadInfo) -> v5::BrowserDownloadInfo {
    v5::BrowserDownloadInfo {
        filename: convert::wire(&value.filename),
        state: convert::wire(&value.state),
        bytes_received: value.bytes_received.map(|value| value.get() as u64),
        total_bytes: value.total_bytes.map(|value| value.get() as u64),
        mime: value.mime.as_ref().map(convert::wire),
    }
}

fn saved_file(value: &browser::SavedFile) -> v5::BrowserSavedFile {
    v5::BrowserSavedFile {
        path: convert::wire(&value.path),
        bytes: value.bytes.get() as u64,
    }
}

pub fn observation(value: &browser::Observation) -> Result<v5::BrowserObservation, Failure> {
    Ok(v5::BrowserObservation {
        tab_id: convert::identity(&value.tab_id)?,
        generation: value.generation.get() as u64,
        document_generation: value.document_generation.get() as u64,
        revision: value.revision.get() as u64,
        title: convert::wire(&value.title),
        page: page(&value.page),
        elements: v5::BrowserObservationElements {
            items: value.elements.iter().map(element).collect(),
        },
        texts: value
            .texts
            .as_deref()
            .map(|items| v5::BrowserObservationTexts {
                items: texts(items),
            }),
        frames: value
            .frames
            .as_deref()
            .map(|items| v5::BrowserObservationFrames {
                items: frames(items),
            }),
        delta: value
            .delta
            .as_ref()
            .map(|delta| v5::BrowserObservationDelta {
                base_revision: delta.base_revision.get() as u64,
                removed: v5::BrowserObservationDeltaRemoved {
                    items: delta.removed.iter().map(convert::wire).collect(),
                },
            }),
        truncated: value.truncated,
    })
}

pub fn capture(value: &browser::CaptureOutput) -> v5::BrowserCaptureOutput {
    v5::BrowserCaptureOutput {
        media_type: 1,
        data: convert::wire(&value.data),
        bytes: value.bytes.get() as u64,
    }
}

pub fn action_result(value: &browser::ActionResult) -> Result<v5::BrowserActionResult, Failure> {
    Ok(v5::BrowserActionResult {
        call_id: convert::identity(&value.call_id)?,
        tab: tab(&value.tab)?,
        status: match value.status {
            browser::ResultStatus::Completed => 1,
            browser::ResultStatus::Paused => 2,
            browser::ResultStatus::Rejected => 3,
            browser::ResultStatus::Uncertain => 4,
        },
        message: value.message.as_ref().map(convert::wire),
        capture: value.capture.as_ref().map(capture),
        group_id: value.group_id.map(|value| value.get() as u64),
        text: value.text.as_ref().map(convert::wire),
        download: value.download.as_ref().map(download),
        logs: value
            .logs
            .as_deref()
            .map(|items| v5::BrowserActionResultLogs { items: logs(items) }),
        saved_file: value.saved_file.as_ref().map(saved_file),
        webmcp_tools: value.webmcp_tools.as_deref().map(|items| {
            v5::BrowserActionResultWebmcpTools {
                items: webmcp_tools(items),
            }
        }),
        dialog: value.dialog.as_ref().map(dialog_info),
        control: value.control.as_ref().map(control_state),
        frame: value.frame.as_ref().map(page),
    })
}

pub fn isolated_status(
    value: &isolated_browser::Status,
) -> Result<v5::IsolatedBrowserStatus, Failure> {
    Ok(v5::IsolatedBrowserStatus {
        mode: 1,
        state: match value.state {
            isolated_browser::State::Unavailable => 1,
            isolated_browser::State::Starting => 2,
            isolated_browser::State::Ready => 3,
            isolated_browser::State::Paused => 4,
            isolated_browser::State::Stopped => 5,
        },
        reason: value.reason.as_ref().map(convert::wire),
        instance_id: value
            .instance_id
            .as_ref()
            .map(convert::identity)
            .transpose()?,
        tab: value.tab.as_ref().map(tab).transpose()?,
    })
}

pub fn isolated_observation(
    value: &isolated_browser::Observation,
) -> Result<v5::IsolatedBrowserObservation, Failure> {
    Ok(v5::IsolatedBrowserObservation {
        mode: 1,
        instance_id: convert::identity(&value.instance_id)?,
        tab_id: convert::identity(&value.tab_id)?,
        generation: value.generation.get() as u64,
        document_generation: value.document_generation.get() as u64,
        revision: value.revision.get() as u64,
        title: convert::wire(&value.title),
        page: page(&value.page),
        elements: v5::IsolatedBrowserObservationElements {
            items: value.elements.iter().map(element).collect(),
        },
        texts: value
            .texts
            .as_deref()
            .map(|items| v5::IsolatedBrowserObservationTexts {
                items: texts(items),
            }),
        frames: value
            .frames
            .as_deref()
            .map(|items| v5::IsolatedBrowserObservationFrames {
                items: frames(items),
            }),
        delta: value
            .delta
            .as_ref()
            .map(|delta| v5::IsolatedBrowserObservationDelta {
                base_revision: delta.base_revision.get() as u64,
                removed: v5::IsolatedBrowserObservationDeltaRemoved {
                    items: delta.removed.iter().map(convert::wire).collect(),
                },
            }),
        truncated: value.truncated,
    })
}

pub fn isolated_action_result(
    value: &isolated_browser::ActionResult,
) -> Result<v5::IsolatedBrowserActionResult, Failure> {
    Ok(v5::IsolatedBrowserActionResult {
        mode: 1,
        instance_id: convert::identity(&value.instance_id)?,
        call_id: convert::identity(&value.call_id)?,
        tab: tab(&value.tab)?,
        status: match value.status {
            isolated_browser::ActionStatus::Completed => 1,
            isolated_browser::ActionStatus::Rejected => 2,
            isolated_browser::ActionStatus::Uncertain => 3,
        },
        message: value.message.as_ref().map(convert::wire),
        capture: value.capture.as_ref().map(capture),
        text: value.text.as_ref().map(convert::wire),
        logs: value
            .logs
            .as_deref()
            .map(|items| v5::IsolatedBrowserActionResultLogs { items: logs(items) }),
        saved_file: value.saved_file.as_ref().map(saved_file),
        webmcp_tools: value.webmcp_tools.as_deref().map(|items| {
            v5::IsolatedBrowserActionResultWebmcpTools {
                items: webmcp_tools(items),
            }
        }),
        dialog: value.dialog.as_ref().map(dialog_info),
        control: value.control.as_ref().map(control_state),
        frame: value.frame.as_ref().map(page),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use prost::Message;
    use ycoding_core::ycoding_schema::{DomainEncode, parse_json};
    use ycoding_protocol::decode_strict;

    fn actions() -> Vec<(v5::BrowserActionRequestPayloadAction, &'static str)> {
        use v5::browser_action_request_payload_action::Kind;
        vec![
            (
                v5::BrowserActionRequestPayloadAction {
                    kind: Some(Kind::Value1(v5::BrowserActionRequestPayloadActionValue1 {
                        r#type: 1,
                        url: convert::text("https://example.test/next"),
                    })),
                },
                r#"{"type":"navigate","url":"https://example.test/next"}"#,
            ),
            (
                v5::BrowserActionRequestPayloadAction {
                    kind: Some(Kind::Value2(v5::BrowserActionRequestPayloadActionValue2 {
                        r#type: 1,
                        r#ref: Some(convert::text("b9999")),
                        locator: None,
                    })),
                },
                r#"{"type":"click","ref":"b9999"}"#,
            ),
            (
                v5::BrowserActionRequestPayloadAction {
                    kind: Some(Kind::Value3(v5::BrowserActionRequestPayloadActionValue3 {
                        r#type: 1,
                        r#ref: Some(convert::text("b1")),
                        locator: None,
                        text: convert::text("hello"),
                    })),
                },
                r#"{"type":"type","ref":"b1","text":"hello"}"#,
            ),
            (
                v5::BrowserActionRequestPayloadAction {
                    kind: Some(Kind::Value4(v5::BrowserActionRequestPayloadActionValue4 {
                        r#type: 1,
                        delta_y: -10000,
                    })),
                },
                r#"{"type":"scroll","deltaY":-10000}"#,
            ),
            (
                v5::BrowserActionRequestPayloadAction {
                    kind: Some(Kind::Value5(v5::BrowserActionRequestPayloadActionValue5 {
                        r#type: 1,
                        r#ref: None,
                        clip: None,
                        full_page: None,
                    })),
                },
                r#"{"type":"capture"}"#,
            ),
            (
                v5::BrowserActionRequestPayloadAction {
                    kind: Some(Kind::Value6(v5::BrowserActionRequestPayloadActionValue6 {
                        r#type: 1,
                        tab_i_ds: v5::BrowserActionRequestPayloadActionValue6TabIDs {
                            items: vec![convert::text("btab_a")],
                        },
                        title: convert::text("Docs"),
                    })),
                },
                r#"{"type":"group","tabIDs":["btab_a"],"title":"Docs"}"#,
            ),
            (
                v5::BrowserActionRequestPayloadAction {
                    kind: Some(Kind::Value7(v5::BrowserActionRequestPayloadActionValue7 {
                        r#type: 1,
                        tab_i_ds: v5::BrowserActionRequestPayloadActionValue7TabIDs {
                            items: vec![convert::text("btab_a")],
                        },
                        group_id: 0,
                    })),
                },
                r#"{"type":"ungroup","tabIDs":["btab_a"],"groupID":0}"#,
            ),
            (
                v5::BrowserActionRequestPayloadAction {
                    kind: Some(Kind::Value8(v5::BrowserActionRequestPayloadActionValue8 {
                        r#type: 1,
                    })),
                },
                r#"{"type":"back"}"#,
            ),
            (
                v5::BrowserActionRequestPayloadAction {
                    kind: Some(Kind::Value11(
                        v5::BrowserActionRequestPayloadActionValue11 {
                            r#type: 1,
                            key: convert::text("Enter"),
                            modifiers: Some(
                                v5::BrowserActionRequestPayloadActionValue11Modifiers {
                                    items: vec![2, 4],
                                },
                            ),
                        },
                    )),
                },
                r#"{"type":"key","key":"Enter","modifiers":["Control","Shift"]}"#,
            ),
            (
                v5::BrowserActionRequestPayloadAction {
                    kind: Some(Kind::Value12(
                        v5::BrowserActionRequestPayloadActionValue12 {
                            r#type: 1,
                            r#ref: Some(convert::text("b1")),
                            locator: None,
                            state: None,
                            url: None,
                            load: None,
                            text: None,
                            timeout_ms: Some(500),
                        },
                    )),
                },
                r#"{"type":"wait","ref":"b1","timeoutMs":500}"#,
            ),
            (
                v5::BrowserActionRequestPayloadAction {
                    kind: Some(Kind::Value12(
                        v5::BrowserActionRequestPayloadActionValue12 {
                            r#type: 1,
                            r#ref: None,
                            locator: None,
                            state: None,
                            url: None,
                            load: None,
                            text: None,
                            timeout_ms: None,
                        },
                    )),
                },
                r#"{"type":"wait"}"#,
            ),
            (
                v5::BrowserActionRequestPayloadAction {
                    kind: Some(Kind::Value15(
                        v5::BrowserActionRequestPayloadActionValue15 {
                            r#type: 1,
                            r#ref: Some(convert::text("b2")),
                            locator: None,
                            paths: v5::BrowserActionRequestPayloadActionValue15Paths {
                                items: vec![convert::text("/workspace/a.txt")],
                            },
                        },
                    )),
                },
                r#"{"type":"upload","ref":"b2","paths":["/workspace/a.txt"]}"#,
            ),
            (
                v5::BrowserActionRequestPayloadAction {
                    kind: Some(Kind::Value17(
                        v5::BrowserActionRequestPayloadActionValue17 {
                            r#type: 1,
                            limit: Some(5),
                        },
                    )),
                },
                r#"{"type":"logs","limit":5}"#,
            ),
            (
                v5::BrowserActionRequestPayloadAction {
                    kind: Some(Kind::Value20(
                        v5::BrowserActionRequestPayloadActionValue20 {
                            r#type: 1,
                            name: convert::text("tool"),
                            arguments: Some(convert::json_to_value(
                                &parse_json(r#"{"a":1}"#).unwrap(),
                            )),
                        },
                    )),
                },
                r#"{"type":"webmcp_invoke","name":"tool","arguments":{"a":1}}"#,
            ),
            (
                v5::BrowserActionRequestPayloadAction {
                    kind: Some(Kind::Value5(v5::BrowserActionRequestPayloadActionValue5 {
                        r#type: 1,
                        r#ref: Some(convert::text("b1")),
                        clip: Some(v5::BrowserActionRequestPayloadActionValue5Clip {
                            x: 0,
                            y: 2,
                            width: 3,
                            height: 4,
                        }),
                        full_page: None,
                    })),
                },
                r#"{"type":"capture","ref":"b1","clip":{"x":0,"y":2,"width":3,"height":4}}"#,
            ),
            (
                v5::BrowserActionRequestPayloadAction {
                    kind: Some(Kind::Value12(
                        v5::BrowserActionRequestPayloadActionValue12 {
                            r#type: 1,
                            r#ref: None,
                            locator: Some(convert::text("button[name=Save]")),
                            state: Some(2),
                            url: None,
                            load: None,
                            text: None,
                            timeout_ms: None,
                        },
                    )),
                },
                r#"{"type":"wait","locator":"button[name=Save]","state":"visible"}"#,
            ),
            (
                v5::BrowserActionRequestPayloadAction {
                    kind: Some(Kind::Value21(
                        v5::BrowserActionRequestPayloadActionValue21 {
                            r#type: 1,
                            r#ref: None,
                            locator: Some(convert::text("input[name=q]")),
                            text: convert::text("filled"),
                        },
                    )),
                },
                r#"{"type":"fill","locator":"input[name=q]","text":"filled"}"#,
            ),
            (
                v5::BrowserActionRequestPayloadAction {
                    kind: Some(Kind::Value22(
                        v5::BrowserActionRequestPayloadActionValue22 {
                            r#type: 1,
                            r#ref: Some(convert::text("b3")),
                            locator: None,
                            values: Some(v5::BrowserActionRequestPayloadActionValue22Values {
                                items: vec![convert::text("a")],
                            }),
                            labels: None,
                            indexes: None,
                        },
                    )),
                },
                r#"{"type":"select","ref":"b3","values":["a"]}"#,
            ),
            (
                v5::BrowserActionRequestPayloadAction {
                    kind: Some(Kind::Value23(
                        v5::BrowserActionRequestPayloadActionValue23 {
                            r#type: 1,
                            r#ref: Some(convert::text("b4")),
                            locator: None,
                            checked: true,
                        },
                    )),
                },
                r#"{"type":"check","ref":"b4","checked":true}"#,
            ),
            (
                v5::BrowserActionRequestPayloadAction {
                    kind: Some(Kind::Value24(
                        v5::BrowserActionRequestPayloadActionValue24 {
                            r#type: 1,
                            r#ref: Some(convert::text("b5")),
                            locator: None,
                        },
                    )),
                },
                r#"{"type":"hover","ref":"b5"}"#,
            ),
            (
                v5::BrowserActionRequestPayloadAction {
                    kind: Some(Kind::Value25(
                        v5::BrowserActionRequestPayloadActionValue25 {
                            r#type: 1,
                            accept: Some(true),
                            text: Some(convert::text("yes")),
                        },
                    )),
                },
                r#"{"type":"dialog","accept":true,"text":"yes"}"#,
            ),
            (
                v5::BrowserActionRequestPayloadAction {
                    kind: Some(Kind::Value26(
                        v5::BrowserActionRequestPayloadActionValue26 {
                            r#type: 1,
                            tab_i_ds: v5::BrowserActionRequestPayloadActionValue26TabIDs {
                                items: vec![convert::text("btab_a"), convert::text("btab_b")],
                            },
                        },
                    )),
                },
                r#"{"type":"group_control","tabIDs":["btab_a","btab_b"]}"#,
            ),
        ]
    }

    #[test]
    fn every_action_arm_has_the_same_domain_meaning_in_both_groups() {
        for (wire, expected) in actions() {
            let bytes = wire.encode_to_vec();
            assert_eq!(
                action(decode_strict(&bytes).unwrap()).unwrap().encode(),
                parse_json(expected).unwrap()
            );
            assert_eq!(
                isolated_action(decode_strict(&bytes).unwrap())
                    .unwrap()
                    .encode(),
                parse_json(expected).unwrap()
            );
        }
    }

    #[test]
    fn browser_validation_enforces_structural_and_domain_bounds() {
        use v5::browser_action_request_payload_action::Kind;
        assert!(number::<browser::Generation>(0).is_err());
        assert!(number::<browser::Generation>(9_007_199_254_740_991).is_ok());
        assert!(number::<browser::Generation>(9_007_199_254_740_992).is_err());
        assert!(number::<browser::ObservationRevision>(0).is_ok());
        assert!(resume(0).is_err());
        assert!(action(v5::BrowserActionRequestPayloadAction { kind: None }).is_err());
        for delta_y in [-10001, -10000, 0, 10000, 10001] {
            let wire = v5::BrowserActionRequestPayloadAction {
                kind: Some(Kind::Value4(v5::BrowserActionRequestPayloadActionValue4 {
                    r#type: 1,
                    delta_y,
                })),
            };
            assert_eq!(
                decode_strict::<v5::BrowserActionRequestPayloadAction>(&wire.encode_to_vec())
                    .is_ok(),
                (-10000..=10000).contains(&delta_y)
            );
            assert_eq!(action(wire).is_ok(), (-10000..=10000).contains(&delta_y));
        }
        for count in [0, 1, 8, 9] {
            for length in [0, 1, 64, 65] {
                let wire = v5::BrowserActionRequestPayloadAction {
                    kind: Some(Kind::Value6(v5::BrowserActionRequestPayloadActionValue6 {
                        r#type: 1,
                        tab_i_ds: v5::BrowserActionRequestPayloadActionValue6TabIDs {
                            items: vec![convert::text("btab_a"); count],
                        },
                        title: convert::text(&"a".repeat(length)),
                    })),
                };
                let valid = (1..=8).contains(&count) && (1..=64).contains(&length);
                assert_eq!(
                    decode_strict::<v5::BrowserActionRequestPayloadAction>(&wire.encode_to_vec())
                        .is_ok(),
                    valid
                );
                assert_eq!(action(wire).is_ok(), valid);
            }
        }
        for length in [0, 1, 512, 513] {
            assert_eq!(
                convert::identifier::<browser::CallId>(&convert::text(&"a".repeat(length))).is_ok(),
                (1..=512).contains(&length)
            );
        }
        for length in [8192, 8193] {
            let wire = v5::BrowserActionRequestPayloadAction {
                kind: Some(Kind::Value3(v5::BrowserActionRequestPayloadActionValue3 {
                    r#type: 1,
                    r#ref: Some(convert::text("b1")),
                    locator: None,
                    text: convert::text(&"a".repeat(length)),
                })),
            };
            assert_eq!(
                decode_strict::<v5::BrowserActionRequestPayloadAction>(&wire.encode_to_vec())
                    .is_ok(),
                length == 8192
            );
            assert_eq!(action(wire).is_ok(), length == 8192);
        }
        for (length, valid) in [(4096, true), (4097, false)] {
            let wire = v5::BrowserActionRequestPayloadAction {
                kind: Some(Kind::Value3(v5::BrowserActionRequestPayloadActionValue3 {
                    r#type: 1,
                    r#ref: Some(convert::text("b1")),
                    locator: None,
                    text: convert::text(&"é".repeat(length)),
                })),
            };
            assert_eq!(action(wire).is_ok(), valid);
        }
        let mut wire = actions().remove(2).0;
        let Some(Kind::Value3(value)) = &mut wire.kind else {
            unreachable!()
        };
        value.text = ycoding_protocol::encode_lossless(&[0xd800]);
        let browser::Action::Type(value) = action(wire).unwrap() else {
            unreachable!()
        };
        assert_eq!(value.text.code_units().collect::<Vec<_>>(), [0xd800]);
        let id = session::Id::new("ses_test").unwrap();
        for length in [4096, 4097] {
            assert_eq!(
                open_input(
                    id.clone(),
                    v5::BrowserOpenRequestPayload {
                        generation: 1,
                        call_id: convert::text("open"),
                        url: convert::text(&"é".repeat(length))
                    }
                )
                .is_ok(),
                length == 4096
            );
        }
        for (url, valid) in [
            ("https://example.test/", true),
            ("http://example.test/?q=1", true),
            ("https://user:secret@example.test/", false),
            ("file:///tmp/file", false),
            ("not-a-url", false),
        ] {
            assert_eq!(
                start_input(v5::IsolatedBrowserStartPayload {
                    url: convert::text(url)
                })
                .is_ok(),
                valid
            );
        }
    }

    #[test]
    fn group_control_wire_preserves_member_order_and_bounds() {
        use v5::browser_action_request_payload_action::Kind;
        for count in [0, 1, 8, 9] {
            let members = (0..count)
                .map(|index| format!("btab_{index}"))
                .collect::<Vec<_>>();
            let wire = v5::BrowserActionRequestPayloadAction {
                kind: Some(Kind::Value26(
                    v5::BrowserActionRequestPayloadActionValue26 {
                        r#type: 1,
                        tab_i_ds: v5::BrowserActionRequestPayloadActionValue26TabIDs {
                            items: members.iter().map(|member| convert::text(member)).collect(),
                        },
                    },
                )),
            };
            let decoded =
                decode_strict::<v5::BrowserActionRequestPayloadAction>(&wire.encode_to_vec());
            assert_eq!(decoded.is_ok(), (1..=8).contains(&count));
            let isolated = decode_strict::<v5::IsolatedBrowserActionRequestPayloadAction>(
                &wire.encode_to_vec(),
            );
            assert_eq!(isolated.is_ok(), (1..=8).contains(&count));
            if let Ok(decoded) = decoded {
                let expected = ObjectEncoder::new()
                    .field("type", "group_control")
                    .field(
                        "tabIDs",
                        &members
                            .iter()
                            .map(|member| LosslessString::from(member.as_str()))
                            .collect::<Vec<_>>(),
                    )
                    .finish();
                assert_eq!(action(decoded).unwrap().encode(), expected);
                assert_eq!(
                    isolated_action(isolated.unwrap()).unwrap().encode(),
                    expected
                );
            }
        }
    }

    #[test]
    fn tab_conversion_preserves_optional_group_id() {
        for group_id in [None, Some(0u64), Some(9_007_199_254_740_991)] {
            let group = group_id
                .map(|id| format!(r#", "groupID":{id}"#))
                .unwrap_or_default();
            let value = parse_json(&format!(
                r#"{{
                "id":"btab_contract", "sessionID":"ses_contract", "title":"Fixture",
                "page":{{"origin":"https://example.test", "path":"/"}}, "status":"shared",
                "generation":1, "documentGeneration":1, "observationRevision":0{group}
            }}"#
            ))
            .unwrap();
            let domain = browser::Tab::decode(&value).unwrap();
            let wire = tab(&domain).unwrap();
            assert_eq!(wire.group_id, group_id);
            assert_eq!(
                decode_strict::<v5::BrowserTab>(&wire.encode_to_vec()).unwrap(),
                wire
            );
        }
    }
}
