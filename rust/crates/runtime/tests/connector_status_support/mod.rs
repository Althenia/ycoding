#![allow(dead_code)]

use std::sync::Arc;
use ycoding_core::{
    session::completion,
    ycoding_schema::{JsonValue, parse_json, session},
    ycoding_store::session::{NewEvent, append},
};

pub async fn fail(store: &ycoding_core::ycoding_store::Client, id: &session::Id) {
    let JsonValue::Object(mut data) = parse_json(r#"{}"#).unwrap() else {
        unreachable!()
    };
    data.insert(
        "sessionID".into(),
        JsonValue::String(id.as_lossless().clone()),
    );
    let event = NewEvent {
        id: format!(
            "evt_connector_failed_{}",
            id.as_lossless().to_utf8().unwrap()
        )
        .into(),
        aggregate_id: id.as_lossless().clone(),
        created: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64,
        type_: "session.execution.failed.1".into(),
        data: JsonValue::Object(data),
    };
    store
        .submit(move |tx| append(tx, &event, None).map(|_| ()))
        .unwrap()
        .await
        .unwrap();
}

pub async fn complete(
    store: &ycoding_core::ycoding_store::Client,
    core: &ycoding_runtime::Core,
    id: &session::Id,
) {
    let steps = [
        (
            "session.input.admitted.1",
            r#"{"inputID":"msg_connector_work","input":{"type":"user","data":{"text":"Verify the work"},"delivery":"steer"}}"#,
        ),
        (
            "session.input.promoted.1",
            r#"{"inputID":"msg_connector_work"}"#,
        ),
        ("session.execution.started.1", r#"{}"#),
        (
            "session.step.started.1",
            r#"{"assistantMessageID":"msg_connector_declare","agent":"build","model":{"providerID":"fixture","id":"model"}}"#,
        ),
        (
            "session.tool.input.started.1",
            r#"{"assistantMessageID":"msg_connector_declare","callID":"complete","name":"task_complete"}"#,
        ),
        (
            "session.tool.called.1",
            r#"{"assistantMessageID":"msg_connector_declare","callID":"complete","input":{},"executed":false}"#,
        ),
        (
            "session.tool.success.1",
            r#"{"assistantMessageID":"msg_connector_declare","callID":"complete","structured":{"recorded":true},"content":[],"executed":false}"#,
        ),
        (
            "session.step.ended.1",
            r#"{"assistantMessageID":"msg_connector_declare","finish":"tool-calls","cost":0,"tokens":{"input":0,"output":0,"reasoning":0,"cache":{"read":0,"write":0}}}"#,
        ),
        (
            "session.step.started.1",
            r#"{"assistantMessageID":"msg_connector_final","agent":"build","model":{"providerID":"fixture","id":"model"}}"#,
        ),
        (
            "session.text.ended.1",
            r#"{"assistantMessageID":"msg_connector_final","ordinal":0,"text":"Implemented and verified."}"#,
        ),
        (
            "session.step.ended.1",
            r#"{"assistantMessageID":"msg_connector_final","finish":"stop","cost":0,"tokens":{"input":0,"output":0,"reasoning":0,"cache":{"read":0,"write":0}}}"#,
        ),
        ("session.execution.succeeded.1", r#"{}"#),
    ];
    for (index, (kind, data)) in steps.into_iter().enumerate() {
        let JsonValue::Object(mut data) = parse_json(data).unwrap() else {
            unreachable!()
        };
        data.insert(
            "sessionID".into(),
            JsonValue::String(id.as_lossless().clone()),
        );
        let event = NewEvent {
            id: format!(
                "evt_connector_{index}_{}",
                id.as_lossless().to_utf8().unwrap()
            )
            .into(),
            aggregate_id: id.as_lossless().clone(),
            created: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_millis() as i64,
            type_: kind.into(),
            data: JsonValue::Object(data),
        };
        store
            .submit(move |tx| append(tx, &event, None).map(|_| ()))
            .unwrap()
            .await
            .unwrap();
    }
    let active = id.clone();
    completion::Completion::new(core.sessions.clone(), core.execution.jobs().clone())
        .complete(id, Arc::new(move || vec![active.clone()]))
        .await
        .unwrap();
    assert_eq!(
        completion::Completion::new(core.sessions.clone(), core.execution.jobs().clone())
            .latest(completion::Page {
                after: None,
                limit: 200
            })
            .unwrap()
            .data
            .iter()
            .filter(|receipt| &receipt.session_id == id)
            .count(),
        1
    );
}
