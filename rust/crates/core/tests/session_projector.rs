use ycoding_core::session::store::Service;
use ycoding_schema::{
    DomainDecode, DomainEncode, JsonValue, model, parse_json, session, session_message,
};
use ycoding_store::{
    TableSpec,
    session::{Message, MessageTable, NewEvent},
};

#[path = "session_support/mod.rs"]
mod support;

fn event(kind: &str, id: &str, now: i64, fields: &str) -> NewEvent {
    NewEvent {
        id: id.into(),
        aggregate_id: "ses_one".into(),
        created: now,
        type_: format!("{kind}.1").into(),
        data: parse_json(&format!(r#"{{"sessionID":"ses_one"{fields}}}"#)).unwrap(),
    }
}
fn start(id: &str, now: i64, assistant: &str) -> NewEvent {
    event(
        "session.step.started",
        id,
        now,
        &format!(
            r#", "assistantMessageID":"{assistant}","agent":"build","model":{{"providerID":"local","id":"test"}}"#
        ),
    )
}
fn assistant(service: &Service, id: &str) -> session_message::Assistant {
    let (_, message) = service
        .message(&session_message::Id::new(id).unwrap())
        .unwrap()
        .unwrap();
    let session_message::Info::Assistant(assistant) = message else {
        panic!("expected assistant")
    };
    *assistant
}

#[tokio::test]
async fn folds_terminal_text_reasoning_usage_and_consumption_without_extra_durable_facts() {
    let store = support::store();
    let service = Service::new(store.client());
    service
        .publish(start("evt_start", 10, "msg_assistant"))
        .await
        .unwrap();
    service
        .publish(event(
            "session.text.started",
            "evt_text_start",
            11,
            r#", "assistantMessageID":"msg_assistant","ordinal":0"#,
        ))
        .await
        .unwrap();
    service.publish(event("session.text.ended", "evt_text_end", 12, r#", "assistantMessageID":"msg_assistant","ordinal":0,"text":"answer","phase":"final_answer""#)).await.unwrap();
    service
        .publish(event(
            "session.reasoning.started",
            "evt_reasoning_start",
            13,
            r#", "assistantMessageID":"msg_assistant","ordinal":1,"state":{"signature":"s"}"#,
        ))
        .await
        .unwrap();
    service.publish(event("session.reasoning.ended", "evt_reasoning_end", 14, r#", "assistantMessageID":"msg_assistant","ordinal":1,"text":"thought","state":{"signature":"finished"}"#)).await.unwrap();
    service.publish(event("session.step.ended", "evt_end", 20, r#", "assistantMessageID":"msg_assistant","finish":"stop","cost":1.25,"tokens":{"input":10,"output":4,"reasoning":2,"cache":{"read":3,"write":1}}"#)).await.unwrap();
    let message = assistant(&service, "msg_assistant");
    assert_eq!(message.content.len(), 2);
    let session_message::AssistantContent::Text(text) = &message.content[0] else {
        panic!()
    };
    assert_eq!(text.text.as_str(), Some("answer"));
    assert_eq!(text.phase.as_ref().unwrap().as_str(), Some("final_answer"));
    let session_message::AssistantContent::Reasoning(reasoning) = &message.content[1] else {
        panic!()
    };
    assert_eq!(reasoning.text.as_str(), Some("thought"));
    assert_eq!(
        reasoning
            .time
            .as_ref()
            .unwrap()
            .completed
            .unwrap()
            .epoch_millis(),
        14
    );
    assert_eq!(message.time.completed.unwrap().epoch_millis(), 20);
    let info = service
        .get(&session::Id::new("ses_one").unwrap())
        .unwrap()
        .unwrap();
    assert_eq!(info.cost.encode(), JsonValue::Number(1.25));
    assert_eq!(info.tokens.reasoning.get(), 2.0);
    assert_eq!(info.time.updated.epoch_millis(), 1);
    assert_eq!(info.time.active.unwrap().epoch_millis(), 20);
    assert_eq!(
        service
            .snapshot(&session::Id::new("ses_one").unwrap(), 100, None)
            .unwrap()
            .watermark,
        Some(5)
    );
}

#[tokio::test]
async fn newer_steps_clear_retry_and_terminal_events_do_not_revive_stale_assistants() {
    let store = support::store();
    let service = Service::new(store.client());
    service
        .publish(start("evt_start1", 10, "msg_first"))
        .await
        .unwrap();
    service.publish(event("session.retry.scheduled", "evt_retry1", 11, r#", "assistantMessageID":"msg_first","attempt":2,"at":2000,"error":{"type":"provider.transport","message":"Disconnected"}"#)).await.unwrap();
    assert!(assistant(&service, "msg_first").retry.is_some());
    service
        .publish(start("evt_start2", 12, "msg_second"))
        .await
        .unwrap();
    assert!(assistant(&service, "msg_first").retry.is_none());
    assert_eq!(
        assistant(&service, "msg_first")
            .time
            .completed
            .unwrap()
            .epoch_millis(),
        12
    );
    service.publish(event("session.retry.scheduled", "evt_retry2", 13, r#", "assistantMessageID":"msg_second","attempt":3,"at":6000,"error":{"type":"provider.transport","message":"Disconnected"}"#)).await.unwrap();
    service
        .publish(event(
            "session.execution.interrupted",
            "evt_interrupt",
            14,
            r#", "reason":"shutdown""#,
        ))
        .await
        .unwrap();
    assert!(assistant(&service, "msg_second").retry.is_none());
    service.publish(event("session.step.failed", "evt_failed", 15, r#", "assistantMessageID":"msg_second","error":{"type":"provider.transport","message":"Disconnected"}"#)).await.unwrap();
    store.submit(|tx| {
        let mut stale = tx.get::<MessageTable>(&MessageTable::primary_key(&Message { id: "msg_first".into(), session_id: "ses_one".into(), type_: "assistant".into(), seq: 0, time_created: 10, time_updated: 10, data: JsonValue::Null }))?.unwrap();
        let mut data = ycoding_schema::JsonObject::new();
        if let JsonValue::Object(current) = stale.data {
            for (key, value) in current.iter() { data.insert(key.clone(), value.clone()); }
        }
        data.insert("time".into(), parse_json(r#"{"created":10}"#).unwrap());
        data.insert("retry".into(), parse_json(r#"{"attempt":2,"at":2000,"error":{"type":"provider.transport","message":"old"}}"#).unwrap());
        stale.data = JsonValue::Object(data);
        MessageTable::put(tx, &stale)
    }).unwrap().await.unwrap();
    service
        .publish(event("session.execution.succeeded", "evt_success", 16, ""))
        .await
        .unwrap();
    assert!(assistant(&service, "msg_first").retry.is_some());
}

#[tokio::test]
async fn owned_events_do_not_update_another_session_or_create_missing_assistants() {
    let store = support::store();
    let service = Service::new(store.client());
    service
        .publish(start("evt_start", 10, "msg_one"))
        .await
        .unwrap();
    let mut foreign = event(
        "session.text.started",
        "evt_foreign",
        11,
        r#", "assistantMessageID":"msg_one","ordinal":0"#,
    );
    foreign.aggregate_id = "ses_two".into();
    foreign.data =
        parse_json(r#"{"sessionID":"ses_two","assistantMessageID":"msg_one","ordinal":0}"#)
            .unwrap();
    service.publish(foreign).await.unwrap();
    service
        .publish(event(
            "session.text.ended",
            "evt_missing",
            12,
            r#", "assistantMessageID":"msg_missing","ordinal":0,"text":"ghost""#,
        ))
        .await
        .unwrap();
    assert!(assistant(&service, "msg_one").content.is_empty());
    assert!(
        service
            .message(&session_message::Id::new("msg_missing").unwrap())
            .unwrap()
            .is_none()
    );
}

#[tokio::test]
async fn trusted_observations_have_correct_roles_and_invalid_or_duplicate_projection_rolls_back() {
    let store = support::store();
    let service = Service::new(store.client());
    service
        .publish(event(
            "session.synthetic",
            "evt_synthetic",
            1,
            r#", "text":"untrusted","metadata":{"contextSource":"session-state"}"#,
        ))
        .await
        .unwrap();
    service
        .publish(event(
            "session.context.observed",
            "evt_state",
            2,
            r#", "source":"session-state","text":"trusted""#,
        ))
        .await
        .unwrap();
    service
        .publish(event(
            "session.context.observed",
            "evt_team",
            3,
            r#", "source":"team-view","text":"team""#,
        ))
        .await
        .unwrap();
    let snapshot = service
        .snapshot(&session::Id::new("ses_one").unwrap(), 100, None)
        .unwrap();
    assert!(matches!(
        snapshot.messages[0],
        session_message::Info::Synthetic(_)
    ));
    assert!(matches!(
        snapshot.messages[1],
        session_message::Info::System(_)
    ));
    assert!(matches!(
        snapshot.messages[2],
        session_message::Info::Synthetic(_)
    ));
    let mut invalid = event("session.synthetic", "evt_invalid", 4, r#", "text":4"#);
    assert!(service.publish(invalid.clone()).await.is_err());
    invalid.type_ = "session.skill.activated.1".into();
    assert!(service.publish(invalid).await.is_err());
    assert_eq!(
        service
            .snapshot(&session::Id::new("ses_one").unwrap(), 100, None)
            .unwrap(),
        snapshot
    );
}

#[tokio::test]
async fn verified_work_completion_is_a_durable_fact_with_no_projected_state() {
    let store = support::store();
    let service = Service::new(store.client());
    let id = session::Id::new("ses_one").unwrap();
    let before = service.snapshot(&id, 100, None).unwrap();
    service
        .publish(event(
            "session.work.completed",
            "evt_work_completed",
            5,
            r#", "inputID":"msg_input","assistantMessageID":"msg_final""#,
        ))
        .await
        .unwrap();
    assert_eq!(
        service.snapshot(&id, 100, None).unwrap().messages,
        before.messages
    );
    let rolled_back = event(
        "session.work.completed",
        "evt_work_invalid",
        6,
        r#", "inputID":4,"assistantMessageID":"msg_final""#,
    );
    assert!(service.publish(rolled_back).await.is_err());
}

#[tokio::test]
async fn execution_terminal_clears_retry_on_the_latest_completed_assistant() {
    let store = support::store();
    let service = Service::new(store.client());
    service
        .publish(start("evt_start", 1, "msg_one"))
        .await
        .unwrap();
    service.publish(event("session.retry.scheduled", "evt_retry", 2, r#", "assistantMessageID":"msg_one","attempt":2,"at":2000,"error":{"type":"provider.transport","message":"Disconnected"}"#)).await.unwrap();
    service.publish(event("session.step.ended", "evt_end", 3, r#", "assistantMessageID":"msg_one","finish":"stop","cost":0,"tokens":{"input":0,"output":0,"reasoning":0,"cache":{"read":0,"write":0}}"#)).await.unwrap();
    assert!(assistant(&service, "msg_one").retry.is_some());
    service
        .publish(event("session.execution.succeeded", "evt_success", 4, ""))
        .await
        .unwrap();
    assert!(assistant(&service, "msg_one").retry.is_none());
    assert_eq!(
        assistant(&service, "msg_one")
            .time
            .completed
            .unwrap()
            .epoch_millis(),
        3
    );
}

#[tokio::test]
async fn tool_parts_fold_by_call_identity_and_preserve_provider_state_and_failure_progress() {
    let store = support::store();
    let service = Service::new(store.client());
    service
        .publish(start("evt_start", 1, "msg_one"))
        .await
        .unwrap();
    for (kind, id, now, fields) in [
        (
            "session.tool.input.started",
            "evt_input",
            2,
            r#", "callID":"call_one","name":"read""#,
        ),
        (
            "session.tool.input.started",
            "evt_other",
            3,
            r#", "callID":"call_two","name":"write""#,
        ),
        (
            "session.tool.input.ended",
            "evt_input_end",
            4,
            r#", "callID":"call_one","text":"{\"path\":\"file\"}""#,
        ),
        (
            "session.tool.called",
            "evt_call",
            5,
            r#", "callID":"call_one","input":{"path":"file"},"executed":true,"state":{"request":"provider"}"#,
        ),
        (
            "session.tool.progress",
            "evt_progress",
            6,
            r#", "callID":"call_one","structured":{"progress":1},"content":[{"type":"text","text":"reading"}]"#,
        ),
        (
            "session.tool.failed",
            "evt_failed",
            7,
            r#", "callID":"call_one","error":{"type":"unknown","message":"no access"},"executed":false,"resultState":{"result":"provider"},"result":{"reason":"denied"}"#,
        ),
        (
            "session.tool.failed",
            "evt_stream_failed",
            8,
            r#", "callID":"call_two","error":{"type":"unknown","message":"invalid input"},"executed":false"#,
        ),
        (
            "session.tool.success",
            "evt_late",
            9,
            r#", "callID":"call_one","structured":{},"content":[],"executed":false"#,
        ),
    ] {
        service
            .publish(event(
                kind,
                id,
                now,
                &format!(r#", "assistantMessageID":"msg_one"{fields}"#),
            ))
            .await
            .unwrap();
    }
    let message = assistant(&service, "msg_one");
    let session_message::AssistantContent::Tool(first) = &message.content[0] else {
        panic!()
    };
    assert_eq!(first.id.as_str(), Some("call_one"));
    assert_eq!(first.executed, Some(true));
    assert_eq!(
        first.provider_state,
        Some(match parse_json(r#"{"request":"provider"}"#).unwrap() {
            JsonValue::Object(value) => value,
            _ => panic!(),
        })
    );
    assert_eq!(first.time.ran.unwrap().epoch_millis(), 5);
    assert_eq!(first.time.completed.unwrap().epoch_millis(), 7);
    let session_message::ToolState::Error(state) = &first.state else {
        panic!()
    };
    assert_eq!(
        JsonValue::Object(state.input.clone()),
        parse_json(r#"{"path":"file"}"#).unwrap()
    );
    assert_eq!(
        JsonValue::Object(state.structured.clone()),
        parse_json(r#"{"progress":1}"#).unwrap()
    );
    assert_eq!(state.content.len(), 1);
    assert_eq!(
        state.result,
        Some(parse_json(r#"{"reason":"denied"}"#).unwrap())
    );
    let session_message::AssistantContent::Tool(second) = &message.content[1] else {
        panic!()
    };
    let session_message::ToolState::Error(state) = &second.state else {
        panic!()
    };
    assert!(state.input.is_empty() && state.structured.is_empty() && state.content.is_empty());
}

#[tokio::test]
async fn tool_success_keeps_typed_result_and_step_recovery_keeps_existing_parts() {
    let store = support::store();
    let service = Service::new(store.client());
    service
        .publish(start("evt_start", 1, "msg_one"))
        .await
        .unwrap();
    for (kind, id, fields) in [
        (
            "session.tool.input.started",
            "evt_input",
            r#", "callID":"call_one","name":"read""#,
        ),
        (
            "session.tool.called",
            "evt_call",
            r#", "callID":"call_one","input":{},"executed":false"#,
        ),
        (
            "session.tool.success",
            "evt_success",
            r#", "callID":"call_one","structured":{"done":true},"content":[{"type":"text","text":"done"}],"executed":true,"result":{"value":42}"#,
        ),
        (
            "session.step.failed",
            "evt_failed",
            r#", "error":{"type":"provider.transport","message":"Disconnected"},"cost":0.5,"tokens":{"input":2,"output":1,"reasoning":0,"cache":{"read":0,"write":0}}"#,
        ),
    ] {
        service
            .publish(event(
                kind,
                id,
                2,
                &format!(r#", "assistantMessageID":"msg_one"{fields}"#),
            ))
            .await
            .unwrap();
    }
    let failed = assistant(&service, "msg_one");
    let session_message::AssistantContent::Tool(tool) = &failed.content[0] else {
        panic!()
    };
    let session_message::ToolState::Completed(state) = &tool.state else {
        panic!()
    };
    assert_eq!(tool.executed, Some(true));
    assert_eq!(state.content.len(), 1);
    assert_eq!(state.result, Some(parse_json(r#"{"value":42}"#).unwrap()));
    service
        .publish(start("evt_recovery", 3, "msg_one"))
        .await
        .unwrap();
    let recovered = assistant(&service, "msg_one");
    assert_eq!(recovered.content, failed.content);
    assert_eq!(recovered.cost, failed.cost);
    assert_eq!(recovered.time.created.epoch_millis(), 1);
    assert!(
        recovered.error.is_none()
            && recovered.finish.is_none()
            && recovered.time.completed.is_none()
    );
}

#[tokio::test]
async fn guardrail_approvals_are_durable_events_that_project_no_message() {
    let store = support::store();
    let service = Service::new(store.client());
    service
        .publish(event(
            "session.guardrail.approved",
            "evt_guardrail_approved",
            1,
            r#","directories":["/tmp/outside"]"#,
        ))
        .await
        .unwrap();
    assert!(
        service
            .snapshot(&session::Id::new("ses_one").unwrap(), 100, None)
            .unwrap()
            .messages
            .is_empty()
    );
}

fn model_ref(id: &str) -> model::Ref {
    model::Ref::decode(&parse_json(&format!(r#"{{"providerID":"local","id":"{id}"}}"#)).unwrap())
        .unwrap()
}

fn reroute(id: &str, now: i64, assistant: &str, to: &str, message: &str) -> NewEvent {
    event(
        "session.step.rerouted",
        id,
        now,
        &format!(
            r#", "assistantMessageID":"{assistant}","model":{{"providerID":"local","id":"{to}"}},"error":{{"type":"provider.quota","message":"{message}"}}"#
        ),
    )
}

#[tokio::test]
async fn a_rerouted_step_records_each_abandoned_model_and_restarts_the_assistant() {
    let store = support::store();
    let service = Service::new(store.client());
    service
        .publish(start("evt_start", 10, "msg_reroute"))
        .await
        .unwrap();
    service
        .publish(event(
            "session.text.started",
            "evt_text",
            11,
            r#", "assistantMessageID":"msg_reroute","ordinal":0"#,
        ))
        .await
        .unwrap();
    service.publish(event("session.retry.scheduled", "evt_retry", 12, r#", "assistantMessageID":"msg_reroute","attempt":2,"at":2000,"error":{"type":"provider.transport","message":"Disconnected"}"#)).await.unwrap();
    let before = assistant(&service, "msg_reroute");
    assert_eq!(before.content.len(), 1);
    assert!(before.retry.is_some());
    assert!(before.reroutes.is_none());

    service
        .publish(reroute(
            "evt_reroute1",
            13,
            "msg_reroute",
            "second",
            "Quota one",
        ))
        .await
        .unwrap();
    let first = assistant(&service, "msg_reroute");
    assert_eq!(first.model, model_ref("second"));
    assert!(first.content.is_empty());
    assert!(first.retry.is_none());
    let reroutes = first.reroutes.unwrap();
    assert_eq!(reroutes.len(), 1);
    assert_eq!(reroutes[0].from, model_ref("test"));
    assert_eq!(reroutes[0].model, model_ref("second"));
    assert_eq!(reroutes[0].error.message.as_str(), Some("Quota one"));

    service
        .publish(reroute(
            "evt_reroute2",
            14,
            "msg_reroute",
            "third",
            "Quota two",
        ))
        .await
        .unwrap();
    let second = assistant(&service, "msg_reroute");
    assert_eq!(second.model, model_ref("third"));
    let reroutes = second.reroutes.unwrap();
    assert_eq!(
        reroutes
            .iter()
            .map(|reroute| (reroute.from.clone(), reroute.model.clone()))
            .collect::<Vec<_>>(),
        [
            (model_ref("test"), model_ref("second")),
            (model_ref("second"), model_ref("third"))
        ]
    );
}

#[tokio::test]
async fn a_reroute_for_a_missing_assistant_creates_no_message() {
    let store = support::store();
    let service = Service::new(store.client());
    service
        .publish(reroute("evt_orphan", 10, "msg_missing", "second", "Quota"))
        .await
        .unwrap();
    assert!(
        service
            .snapshot(&session::Id::new("ses_one").unwrap(), 100, None)
            .unwrap()
            .messages
            .is_empty()
    );
}
