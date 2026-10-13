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

pub fn action(value: v5::BrowserActionRequestPayloadAction) -> Result<browser::Action, Failure> {
    use v5::browser_action_request_payload_action::Kind;
    let value = match value.kind {
        Some(Kind::Value1(value)) => ObjectEncoder::new()
            .field("type", &LosslessString::from("navigate"))
            .field("url", &convert::domain(&value.url)?)
            .finish(),
        Some(Kind::Value2(value)) => ObjectEncoder::new()
            .field("type", &LosslessString::from("click"))
            .field("ref", &convert::domain(&value.r#ref)?)
            .finish(),
        Some(Kind::Value3(value)) => ObjectEncoder::new()
            .field("type", &LosslessString::from("type"))
            .field("ref", &convert::domain(&value.r#ref)?)
            .field("text", &convert::domain(&value.text)?)
            .finish(),
        Some(Kind::Value4(value)) => ObjectEncoder::new()
            .field("type", &LosslessString::from("scroll"))
            .field("deltaY", &JsonValue::Number(value.delta_y as f64))
            .finish(),
        Some(Kind::Value5(_)) => ObjectEncoder::new()
            .field("type", &LosslessString::from("capture"))
            .finish(),
        Some(Kind::Value6(value)) => ObjectEncoder::new()
            .field("type", &LosslessString::from("group"))
            .field(
                "tabIDs",
                &value
                    .tab_i_ds
                    .items
                    .iter()
                    .map(convert::domain)
                    .collect::<Result<Vec<_>, _>>()?,
            )
            .field("title", &convert::domain(&value.title)?)
            .finish(),
        Some(Kind::Value7(value)) => ObjectEncoder::new()
            .field("type", &LosslessString::from("ungroup"))
            .field(
                "tabIDs",
                &value
                    .tab_i_ds
                    .items
                    .iter()
                    .map(convert::domain)
                    .collect::<Result<Vec<_>, _>>()?,
            )
            .field(
                "groupID",
                &number::<browser::ObservationRevision>(value.group_id)?,
            )
            .finish(),
        None => return Err(Failure::Invalid("missing browser action".into())),
    };
    browser::Action::decode(&value).map_err(|error| Failure::Invalid(error.to_string()))
}

pub fn isolated_action(
    value: v5::IsolatedBrowserActionRequestPayloadAction,
) -> Result<browser::Action, Failure> {
    use v5::isolated_browser_action_request_payload_action::Kind;
    let value = match value.kind {
        Some(Kind::Value1(value)) => ObjectEncoder::new()
            .field("type", &LosslessString::from("navigate"))
            .field("url", &convert::domain(&value.url)?)
            .finish(),
        Some(Kind::Value2(value)) => ObjectEncoder::new()
            .field("type", &LosslessString::from("click"))
            .field("ref", &convert::domain(&value.r#ref)?)
            .finish(),
        Some(Kind::Value3(value)) => ObjectEncoder::new()
            .field("type", &LosslessString::from("type"))
            .field("ref", &convert::domain(&value.r#ref)?)
            .field("text", &convert::domain(&value.text)?)
            .finish(),
        Some(Kind::Value4(value)) => ObjectEncoder::new()
            .field("type", &LosslessString::from("scroll"))
            .field("deltaY", &JsonValue::Number(value.delta_y as f64))
            .finish(),
        Some(Kind::Value5(_)) => ObjectEncoder::new()
            .field("type", &LosslessString::from("capture"))
            .finish(),
        Some(Kind::Value6(value)) => ObjectEncoder::new()
            .field("type", &LosslessString::from("group"))
            .field(
                "tabIDs",
                &value
                    .tab_i_ds
                    .items
                    .iter()
                    .map(convert::domain)
                    .collect::<Result<Vec<_>, _>>()?,
            )
            .field("title", &convert::domain(&value.title)?)
            .finish(),
        Some(Kind::Value7(value)) => ObjectEncoder::new()
            .field("type", &LosslessString::from("ungroup"))
            .field(
                "tabIDs",
                &value
                    .tab_i_ds
                    .items
                    .iter()
                    .map(convert::domain)
                    .collect::<Result<Vec<_>, _>>()?,
            )
            .field(
                "groupID",
                &number::<browser::ObservationRevision>(value.group_id)?,
            )
            .finish(),
        None => return Err(Failure::Invalid("missing isolated browser action".into())),
    };
    browser::Action::decode(&value).map_err(|error| Failure::Invalid(error.to_string()))
}

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
    })
}

pub fn element(value: &browser::Element) -> v5::BrowserElement {
    v5::BrowserElement {
        r#ref: convert::wire(&value.r#ref),
        role: convert::wire(&value.role),
        name: convert::wire(&value.name),
        description: value.description.as_ref().map(convert::wire),
        disabled: value.disabled,
        destination: value.destination.as_ref().map(page),
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
                        r#ref: convert::text("b9999"),
                    })),
                },
                r#"{"type":"click","ref":"b9999"}"#,
            ),
            (
                v5::BrowserActionRequestPayloadAction {
                    kind: Some(Kind::Value3(v5::BrowserActionRequestPayloadActionValue3 {
                        r#type: 1,
                        r#ref: convert::text("b1"),
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
                    r#ref: convert::text("b1"),
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
                    r#ref: convert::text("b1"),
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
}
