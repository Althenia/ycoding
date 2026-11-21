use ycoding_ai::{
    auth::{Auth, Credential},
    cursor::{framing, headers, protobuf, replay, stream, usage, wire},
    llm::{Event, FinishReason, Part, Response},
    provider_error::{AuthenticationKind, Reason},
};

fn bytes(text: &str) -> Vec<u8> {
    text.as_bytes()
        .as_chunks::<2>()
        .0
        .iter()
        .map(|pair| u8::from_str_radix(std::str::from_utf8(pair).unwrap(), 16).unwrap())
        .collect()
}
fn fixture(name: &str) -> Vec<u8> {
    let fixtures: serde_json::Value =
        serde_json::from_str(include_str!("fixtures/cursor/wire.json")).unwrap();
    bytes(fixtures[name].as_str().unwrap())
}
fn frame(name: &str) -> Vec<u8> {
    framing::encode(0, &fixture(name)).unwrap()
}

#[test]
fn cursor_replay_analysis_matches_committed_wire_classification() {
    for (name, progress, barrier) in [
        ("text", true, None),
        ("thinking", true, None),
        ("ended", true, None),
        ("checkpoint", true, None),
        ("requestContext", true, None),
        ("mcpState", true, None),
        ("setBlob", true, None),
        ("getBlob", true, None),
        ("mcp", true, Some(replay::Barrier::NonControlExec)),
    ] {
        let payload = fixture(name);
        let decoded = wire::decode(&payload).unwrap();
        let actual = replay::analyze(&payload, Some(&decoded));
        assert_eq!(actual.progress, progress, "{name}");
        assert_eq!(actual.barrier, barrier, "{name}");
    }
    for hex in [
        "",
        "00",
        "0a00",
        "3200",
        "220408091200",
        "0a040a000a00",
        "2a020a00",
    ] {
        let payload = bytes(hex);
        let decoded = wire::decode(&payload).ok();
        assert_eq!(
            replay::analyze(&payload, decoded.as_ref()).barrier,
            Some(replay::Barrier::Malformed),
            "{hex}"
        );
    }
    let payload = bytes("0a021200");
    let decoded = wire::decode(&payload).unwrap();
    assert_eq!(
        replay::analyze(&payload, Some(&decoded)).barrier,
        Some(replay::Barrier::DisplayTool)
    );
    let mut safety = replay::Safety::default();
    assert!(safety.safe(true));
    assert!(!safety.safe(false));
    safety.mark(replay::Barrier::VisibleText);
    safety.mark(replay::Barrier::NonControlExec);
    assert_eq!(safety.barrier(), Some(replay::Barrier::VisibleText));
    assert!(!safety.safe(true));
}

#[test]
fn cursor_usage_keeps_absence_and_inclusive_partitions() {
    let wire::ServerMessage::Interaction(wire::Update::TurnEnded(counters)) =
        wire::decode(&fixture("ended")).unwrap()
    else {
        panic!("ended expected")
    };
    let usage = usage::normalize(&counters);
    assert_eq!(usage.input_tokens, Some(100.0));
    assert_eq!(usage.non_cached_input_tokens, Some(60.0));
    assert_eq!(usage.cache_read_input_tokens, Some(30.0));
    assert_eq!(usage.cache_write_input_tokens, Some(10.0));
    assert_eq!(usage.output_tokens, Some(20.0));
    assert_eq!(usage.reasoning_tokens, Some(5.0));
    assert_eq!(usage.total_tokens, Some(120.0));
    assert_eq!(
        usage::normalize(&wire::Counters::default()),
        Default::default()
    );
    let partial = usage::normalize(&wire::Counters {
        input: Some(0),
        output: Some(0),
        ..Default::default()
    });
    assert_eq!(partial.input_tokens, Some(0.0));
    assert_eq!(partial.output_tokens, Some(0.0));
    assert_eq!(partial.total_tokens, Some(0.0));
    assert_eq!(partial.non_cached_input_tokens, None);
    assert_eq!(partial.cache_read_input_tokens, None);
    assert_eq!(partial.reasoning_tokens, None);
    let clamped = usage::normalize(&wire::Counters {
        input: Some(5),
        output: Some(3),
        cache_read: Some(10),
        cache_write: Some(10),
        reasoning: Some(10),
    });
    assert_eq!(clamped.cache_read_input_tokens, Some(5.0));
    assert_eq!(clamped.cache_write_input_tokens, Some(0.0));
    assert_eq!(clamped.reasoning_tokens, Some(3.0));
}

#[test]
fn cursor_checkpoint_token_details_are_bounded_and_never_reencode_state() {
    let original = fixture("tokenCheckpoint");
    let details = usage::token_details(&original).unwrap();
    assert_eq!(details.used, Some(120));
    assert_eq!(details.maximum, Some(1000));
    let breakdown = details.breakdown.unwrap();
    assert_eq!(breakdown.categories.len(), 1);
    assert_eq!(breakdown.categories[0].id, "tools");
    assert_eq!(breakdown.categories[0].tokens, Some(30));
    assert_eq!(breakdown.categories[0].characters, Some(90));
    assert_eq!(original, fixture("tokenCheckpoint"));
    assert!(usage::token_details(&bytes("2a03087880")).is_none());
    assert!(usage::token_details(&bytes("2800")).is_none());
    assert!(usage::token_details(&bytes("2a00")).is_none());
    let mut breakdown = Vec::new();
    for _ in 0..129 {
        protobuf::write_bytes(&mut breakdown, 3, &[]).unwrap();
    }
    let mut details = Vec::new();
    protobuf::write_bytes(&mut details, 3, &breakdown).unwrap();
    let mut checkpoint = Vec::new();
    protobuf::write_bytes(&mut checkpoint, 5, &details).unwrap();
    assert_eq!(
        usage::token_details(&checkpoint)
            .unwrap()
            .breakdown
            .unwrap()
            .categories
            .len(),
        128
    );
}

#[test]
fn cursor_headers_use_resolved_auth_and_exact_javascript_checksum() {
    let identity = headers::Identity {
        machine_id: "machine".into(),
        mac_machine_id: Some("mac".into()),
        client_version: "cli-fixture".into(),
    };
    assert_eq!(
        headers::checksum(&identity, 1_700_000_000_123),
        "Vfb45Bi9machine/mac"
    );
    let auth = Auth::bearer(Credential::value("fixture-token"));
    let extra = std::collections::BTreeMap::from([
        ("X-Request-Id".into(), "old".into()),
        ("Authorization".into(), "old".into()),
    ]);
    let headers = headers::run(
        &auth,
        &identity,
        "new",
        1_700_000_000_123,
        "https://agent.fixture.cursor.sh/agent.v1.AgentService/Run",
        &extra,
    )
    .unwrap();
    assert_eq!(headers["authorization"], "Bearer fixture-token");
    assert!(headers["authorization"].is_sensitive());
    assert_eq!(headers["x-request-id"], "new");
    assert_eq!(headers["connect-protocol-version"], "1");
    assert_eq!(headers["x-cursor-streaming"], "true");
    assert_eq!(headers["content-type"], "application/connect+proto");
    assert!(!format!("{:?}", Credential::value("fixture-token")).contains("fixture-token"));
    for invalid in [
        "http://agent.cursor.sh",
        "https://cursor.sh",
        "https://cursor.sh.evil.test",
        "https://user:pass@agent.cursor.sh",
        "https://notcursor.sh",
    ] {
        assert!(headers::agent_origin(invalid).is_none(), "{invalid}");
    }
    assert_eq!(
        headers::agent_origin("agentn.us.api5.cursor.sh/path").as_deref(),
        Some("https://agentn.us.api5.cursor.sh")
    );
}

#[test]
fn cursor_stream_spans_and_terminal_settlement_reach_common_llm_response() {
    let mut state = stream::State::new();
    let mut events = Vec::new();
    for name in ["thinking", "text", "checkpoint", "ended"] {
        events.extend(state.push(&frame(name)).unwrap().events);
    }
    state.finish().unwrap();
    let response = Response::from_events(events.clone()).unwrap();
    assert_eq!(response.finish_reason, FinishReason::Stop);
    assert!(
        matches!(&response.message.content[0], Part::Reasoning(part) if part.text == "Plan".into())
    );
    assert!(
        matches!(&response.message.content[1], Part::Text(part) if part.text == "Hello".into())
    );
    let reasoning_end = events
        .iter()
        .position(|event| matches!(event, Event::ReasoningEnd(_)))
        .unwrap();
    let text_start = events
        .iter()
        .position(|event| matches!(event, Event::TextStart(_)))
        .unwrap();
    assert!(reasoning_end < text_start);
    assert_eq!(state.checkpoint(), Some(bytes("0a03ff0080").as_slice()));
    assert!(!state.replay_safe(true));
    assert_eq!(
        state.push(&frame("text")).unwrap_err().reason,
        Reason::InvalidProviderOutput
    );
    let mut absent = stream::State::new();
    let response =
        Response::from_events(absent.push(&frame("absentUsage")).unwrap().events).unwrap();
    assert_eq!(response.usage, None);
    assert!(absent.finish().is_ok());
}

#[test]
fn cursor_stream_forwards_exec_without_running_tools_and_handles_kv() {
    let mut state = stream::State::new();
    let batch = state.push(&frame("mcp")).unwrap();
    assert!(batch.events.is_empty());
    assert!(matches!(&batch.controls[0], wire::ServerMessage::Exec(exec) if exec.id == 7));
    assert!(!state.replay_safe(true));
    let set = state.push(&frame("setBlob")).unwrap();
    assert_eq!(set.replies, vec![fixture("setBlobResult")]);
    let get = state.push(&frame("getBlob")).unwrap();
    assert_eq!(get.replies, vec![fixture("getBlobResult")]);
    let mut unknown = stream::State::new();
    let get = unknown.push(&frame("getBlob")).unwrap();
    assert_eq!(get.replies, vec![bytes("1a07080912030a0161")]);
    let mut args = Vec::new();
    protobuf::write_bytes(&mut args, 1, &[128; 32]).unwrap();
    let mut kv = Vec::new();
    protobuf::write_varint(&mut kv, 1, 9).unwrap();
    protobuf::write_bytes(&mut kv, 2, &args).unwrap();
    let mut server = Vec::new();
    protobuf::write_bytes(&mut server, 4, &kv).unwrap();
    let get = unknown.push(&framing::encode(0, &server).unwrap()).unwrap();
    assert_eq!(get.replies, vec![bytes("1a06080912020a00")]);
}

#[test]
fn cursor_printable_32_byte_content_ids_echo_instead_of_becoming_unknown_hashes() {
    for (byte, is_hash) in [
        (8, true),
        (9, false),
        (13, false),
        (14, true),
        (31, true),
        (32, false),
        (126, false),
        (127, true),
        (128, true),
    ] {
        let blob_id = [byte; 32];
        let mut args = Vec::new();
        protobuf::write_bytes(&mut args, 1, &blob_id).unwrap();
        let mut kv = Vec::new();
        protobuf::write_varint(&mut kv, 1, 9).unwrap();
        protobuf::write_bytes(&mut kv, 2, &args).unwrap();
        let mut server = Vec::new();
        protobuf::write_bytes(&mut server, 4, &kv).unwrap();
        let mut state = stream::State::new();
        let batch = state.push(&framing::encode(0, &server).unwrap()).unwrap();
        let outer = protobuf::fields(&batch.replies[0]).unwrap();
        let kv = protobuf::fields(outer[0].bytes().unwrap()).unwrap();
        let result = protobuf::fields(kv[1].bytes().unwrap()).unwrap();
        assert_eq!(
            result[0].bytes().unwrap(),
            if is_hash { &[][..] } else { &blob_id[..] },
            "{byte}"
        );
    }
}

#[test]
fn cursor_non_request_decode_failures_retain_diagnostics_and_block_replay() {
    let mut state = stream::State::new();
    let corrupt = framing::Frame {
        flags: framing::GZIP,
        payload: vec![1, 2, 3],
    };
    let mut bytes = vec![corrupt.flags, 0, 0, 0, 3];
    bytes.extend(corrupt.payload);
    bytes.extend(frame("text"));
    bytes.extend(frame("ended"));
    let batch = state.push(&bytes).unwrap();
    assert_eq!(batch.failures.len(), 1);
    assert!(
        batch
            .events
            .iter()
            .any(|event| matches!(event, Event::Finish(_)))
    );
    assert!(!state.replay_safe(true));
    state.finish().unwrap();
    let mut non_request = stream::State::new();
    let batch = non_request
        .push(&framing::encode(0, &[10, 5, 255]).unwrap())
        .unwrap();
    assert_eq!(batch.failures.len(), 1);
    assert!(batch.events.is_empty());
    assert!(!non_request.replay_safe(true));
    assert!(non_request.finish().is_err());
    let mut required = stream::State::new();
    assert!(
        required
            .push(&framing::encode(0, &[18, 5, 255]).unwrap())
            .is_err()
    );
    assert!(required.finish().is_err());
}

#[test]
fn cursor_empty_checkpoint_update_keeps_the_authoritative_checkpoint() {
    let mut state = stream::State::new();
    state.push(&frame("checkpoint")).unwrap();
    state.push(&framing::encode(0, &[26, 0]).unwrap()).unwrap();
    assert_eq!(state.checkpoint(), Some(bytes("0a03ff0080").as_slice()));
}

#[test]
fn cursor_end_stream_does_not_manufacture_completion_and_errors_are_typed() {
    let mut state = stream::State::new();
    assert!(state.finish().is_err());
    assert!(
        state
            .push(&framing::encode(framing::END_STREAM, b"{}").unwrap())
            .is_err()
    );
    let mut denied = stream::State::new();
    let frame = framing::encode(
        framing::END_STREAM,
        br#"{"error":{"code":"unauthenticated","message":"secret details"}}"#,
    )
    .unwrap();
    let error = denied.push(&frame).unwrap_err();
    assert_eq!(error.reason, Reason::Authentication);
    assert!(!error.message.contains("secret details"));
    let mut truncated = stream::State::new();
    truncated.push(&[0, 0, 0, 0, 2, 10]).unwrap();
    assert!(truncated.finish().is_err());
    assert_eq!(stream::grpc_error("14").reason, Reason::ProviderInternal);
    assert_eq!(stream::grpc_error("8").reason, Reason::RateLimit);
    assert_eq!(stream::grpc_error("16").reason, Reason::Authentication);
}

#[test]
fn cursor_numeric_grpc_statuses_keep_auth_and_transient_separation() {
    let transient = stream::grpc_error("14");
    assert_eq!(transient.reason, Reason::ProviderInternal);
    let metadata = ycoding_schema::stringify_json(transient.provider_metadata.as_ref().unwrap());
    assert!(metadata.contains("\"origin\":\"server\""));
    assert!(metadata.contains("\"transient\":true"));
    assert!(metadata.contains("\"replaySafe\":true"));
    let auth = stream::grpc_error("16");
    assert_eq!(auth.reason, Reason::Authentication);
    assert_eq!(auth.authentication_kind, Some(AuthenticationKind::Invalid));
    let metadata = ycoding_schema::stringify_json(auth.provider_metadata.as_ref().unwrap());
    assert!(metadata.contains("\"origin\":\"auth\""));
    assert!(metadata.contains("\"transient\":false"));
    assert!(metadata.contains("\"replaySafe\":false"));
}
