use bytes::Bytes;
use http::Response;
use std::{future::Future, pin::Pin, sync::Arc, time::Duration};
use tokio::net::TcpListener;
use ycoding_ai::{
    Error,
    auth::{Auth, Credential},
    cursor::{
        HOST_TOOL_NAMESPACE, framing, headers,
        observations::{self, ReadObservation, ReadPath, ReadRequest},
        protobuf, provider,
        request::Descriptor,
        transport,
    },
    llm::{
        FinishReason, Message, Part, Request, Role, ToolChoice, ToolDefinition, ToolResult,
        ToolResultValue,
    },
    route::Executor,
};

#[derive(Clone)]
struct Flow {
    query: Vec<u8>,
    tool: ToolDefinition,
    input: &'static str,
    output: &'static str,
    error: bool,
    initial_replies: Vec<Vec<u8>>,
    replies: Vec<Vec<u8>>,
}
async fn tool_flow(flow: Flow) {
    tool_flows(vec![flow]).await;
}
async fn tool_flows(flows: Vec<Flow>) {
    observed_tool_flows(flows, None).await;
}
async fn observed_tool_flows(flows: Vec<Flow>, observations: Option<Arc<dyn observations::Host>>) {
    tokio::time::timeout(Duration::from_secs(5), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (done, mut delivered) = tokio::sync::mpsc::unbounded_channel();
        let server_flows = flows.clone();
        let server = tokio::spawn(async move {
            let (socket, _) = listener.accept().await.unwrap();
            let mut connection = h2::server::handshake(socket).await.unwrap();
            let (request, mut response) = connection.accept().await.unwrap().unwrap();
            let mut body = request.into_body();
            let exchange = async move {
                let mut decoder = framing::Decoder::default();
                let initial = body.data().await.unwrap().unwrap();
                body.flow_control().release_capacity(initial.len()).unwrap();
                assert_eq!(decoder.push(&initial).len(), 1);
                let mut send = response.send_response(Response::builder().status(200).body(()).unwrap(), false).unwrap();
                for flow in server_flows {
                send.send_data(Bytes::from(framing::encode(0, &flow.query).unwrap()), false).unwrap();
                for expected in flow.initial_replies {
                    let chunk = body.data().await.unwrap().unwrap();
                    body.flow_control().release_capacity(chunk.len()).unwrap();
                    let observed = decoder.push(&chunk);
                    assert_eq!(observed.len(), 1);
                    assert_eq!(observed[0].payload, expected);
                }
                delivered.recv().await.unwrap();
                let mut replies = Vec::new();
                while replies.len() < flow.replies.len() {
                    let chunk = body.data().await.unwrap().unwrap();
                    body.flow_control().release_capacity(chunk.len()).unwrap();
                    replies.extend(decoder.push(&chunk).into_iter().map(|frame| frame.payload));
                }
                for (actual, expected) in replies.into_iter().zip(flow.replies) {
                    let fields = protobuf::fields(&actual).unwrap();
                    let actual = if fields[0].number == 2 {
                        let mut result = Vec::new();
                        for field in protobuf::fields(fields[0].bytes().unwrap()).unwrap() {
                            if field.number != 39 { field.write(&mut result).unwrap(); }
                        }
                        bytes(2, &result)
                    } else { actual };
                    assert_eq!(actual, expected);
                }
                }
                send.send_data(Bytes::from(framing::encode(0, &[10, 2, 114, 0]).unwrap()), false).unwrap();
                while let Some(chunk) = body.data().await {
                    match chunk {
                        Ok(chunk) => { body.flow_control().release_capacity(chunk.len()).unwrap(); assert!(decoder.push(&chunk).is_empty(), "display result wrote a provider reply"); },
                        Err(error) => { assert_eq!(error.reason(), Some(h2::Reason::CANCEL)); break; }
                    }
                }
            };
            tokio::pin!(exchange);
            tokio::select! { () = &mut exchange => {}, next = connection.accept() => { assert!(next.is_none(), "tool continuation opened another Run"); exchange.await; } }
        });
        let runtime = Arc::new(provider::Runtime::new(Default::default()).unwrap());
        let mut config = provider::Config::new(Auth::bearer(Credential::value("fixture-token")), headers::Identity { machine_id: "machine".into(), mac_machine_id: None, client_version: "cli-fixture".into() }, provider::RequestContext::new(vec![34, 0]).unwrap(), runtime.clone());
        config.agent = Some(transport::Endpoint::loopback(address).unwrap());
        config.observations = observations;
        let mut request = Request::new(provider::model("composer-fixture", config).unwrap());
        request.http.headers.insert("x-session-id".into(), "ses-fixture".into());
        request.messages.push(Message::user("Hello"));
        for flow in &flows { if !request.tools.iter().any(|tool| tool.name == flow.tool.name) { request.tools.push(flow.tool.clone()); } }
        let executor = Executor::new(Executor::http_client().unwrap());
        for flow in flows {
        let first = executor.generate(&request).await.unwrap();
        assert_eq!(first.finish_reason, FinishReason::ToolCalls);
        let call = first.message.content.iter().find_map(|part| if let Part::ToolCall(call) = part { Some(call.clone()) } else { None }).unwrap();
        assert_eq!(call.name, flow.tool.name);
        assert_eq!(serde_json::from_str::<serde_json::Value>(&ycoding_schema::stringify_json(&call.input)).unwrap(), serde_json::from_str::<serde_json::Value>(flow.input).unwrap());
        request.messages.push(first.message);
        let result = ycoding_schema::JsonValue::String(flow.output.into());
        request.messages.push(Message::new(Role::Tool, vec![Part::ToolResult(ToolResult { id: call.id, name: call.name, result: if flow.error { ToolResultValue::Error(result) } else { ToolResultValue::Text(result) }, cache: None, provider_executed: None, provider_metadata: None, output: None })]));
        done.send(()).unwrap();
        }
        assert_eq!(executor.generate(&request).await.unwrap().finish_reason, FinishReason::Stop);
        server.await.unwrap();
        runtime.shutdown().await;
    }).await.unwrap();
}

struct ReadHost {
    kind: ReadPath,
    observe_error: bool,
}
impl observations::Host for ReadHost {
    fn inspect_read<'a>(
        &'a self,
        request: &'a ReadRequest,
    ) -> Pin<Box<dyn Future<Output = Result<ReadPath, Error>> + Send + 'a>> {
        Box::pin(async move {
            assert_eq!(request.session_id, "ses-fixture".into());
            assert_eq!(request.path, "a.ts".into());
            assert_eq!(request.offset, Some(2));
            assert_eq!(request.limit, Some(1));
            Ok(self.kind.clone())
        })
    }
    fn observe_read<'a>(
        &'a self,
        _request: &'a ReadRequest,
        result: &'a ToolResult,
    ) -> Pin<Box<dyn Future<Output = Result<ReadObservation, Error>> + Send + 'a>> {
        Box::pin(async move {
            assert!(matches!(self.kind, ReadPath::Regular));
            assert_eq!(result.result.to_text(), "<file>2: tail</file>".into());
            if self.observe_error {
                return Err(Error::invalid("observation unavailable"));
            }
            Ok(ReadObservation {
                path: "/fixture/a.ts".into(),
                content: "tail\r\n\nPartial file; total 9 lines.".into(),
                total_lines: 9,
                file_size: 42,
                truncated: true,
                range_applied: true,
            })
        })
    }
}
#[tokio::test]
async fn cursor_native_read_uses_host_observation_for_raw_content_newline_size_range_and_truncation()
 {
    let mut args = bytes(1, b"a.ts");
    protobuf::write_varint(&mut args, 4, 2).unwrap();
    protobuf::write_varint(&mut args, 5, 1).unwrap();
    let mut success = bytes(1, b"/fixture/a.ts");
    protobuf::write_bytes(&mut success, 2, b"tail\r\n\nPartial file; total 9 lines.").unwrap();
    protobuf::write_varint(&mut success, 3, 9).unwrap();
    protobuf::write_varint(&mut success, 4, 42).unwrap();
    protobuf::write_varint(&mut success, 6, 1).unwrap();
    protobuf::write_varint(&mut success, 8, 1).unwrap();
    observed_tool_flows(
        vec![Flow {
            query: exec(7, &args),
            tool: tool("read"),
            input: r#"{"filePath":"a.ts","offset":2,"limit":1}"#,
            output: "<file>2: tail</file>",
            error: false,
            initial_replies: vec![],
            replies: vec![exec(7, &bytes(1, &success)), bytes(5, &bytes(1, &[8, 8]))],
        }],
        Some(Arc::new(ReadHost {
            kind: ReadPath::Regular,
            observe_error: false,
        })),
    )
    .await;
}

#[tokio::test]
async fn cursor_native_read_denies_preflight_without_tool_execution_and_fails_closed_on_missing_observation()
 {
    let mut args = bytes(1, b"a.ts");
    protobuf::write_varint(&mut args, 4, 2).unwrap();
    protobuf::write_varint(&mut args, 5, 1).unwrap();
    for (kind, variant, reason) in [
        (ReadPath::Missing, 4, None),
        (ReadPath::PermissionDenied, 5, None),
        (
            ReadPath::Invalid("not a regular file".into()),
            6,
            Some("not a regular file"),
        ),
    ] {
        let mut result = bytes(1, b"a.ts");
        if let Some(reason) = reason {
            protobuf::write_bytes(&mut result, 2, reason.as_bytes()).unwrap();
        }
        observed_controls(
            vec![34, 0],
            vec![tool("read")],
            None,
            vec![],
            vec![(
                exec(7, &args),
                vec![
                    exec(7, &bytes(variant, &result)),
                    bytes(5, &bytes(1, &[8, 8])),
                ],
            )],
            Some(Arc::new(ReadHost {
                kind,
                observe_error: false,
            })),
        )
        .await;
    }
    let mut error = bytes(1, b"a.ts");
    protobuf::write_bytes(&mut error, 2, b"observation unavailable").unwrap();
    observed_tool_flows(
        vec![Flow {
            query: exec(7, &args),
            tool: tool("read"),
            input: r#"{"filePath":"a.ts","offset":2,"limit":1}"#,
            output: "<file>2: tail</file>",
            error: false,
            initial_replies: vec![],
            replies: vec![exec(7, &bytes(2, &error)), bytes(5, &bytes(1, &[8, 8]))],
        }],
        Some(Arc::new(ReadHost {
            kind: ReadPath::Regular,
            observe_error: true,
        })),
    )
    .await;
}

#[tokio::test]
async fn cursor_todo_read_refresh_and_direct_write_seed_complete_ordered_display_merges() {
    for read in [true, false] {
        let output = r#"{"todos":[{"id":"host-b","content":"Build","status":"pending","priority":"high"},{"id":"other","content":"Keep","status":"TODO_STATUS_PENDING","priority":"low"},{"id":"host-b","content":"Build","status":"pending","priority":"high"},{"id":"plan","content":"Synthetic","status":"completed","priority":"high"}]}"#;
        let name = if read { "todoread" } else { "todowrite" };
        let input = if read { "{}" } else { output };
        let mut mcp = bytes(1, format!("{HOST_TOOL_NAMESPACE}-{name}").as_bytes());
        let ycoding_schema::JsonValue::Object(fields) = ycoding_schema::parse_json(input).unwrap()
        else {
            panic!("object required");
        };
        for (key, value) in fields.iter() {
            let mut entry = Vec::new();
            protobuf::write_string(&mut entry, 1, key).unwrap();
            protobuf::write_bytes(&mut entry, 2, &protobuf::encode_value(value).unwrap()).unwrap();
            protobuf::write_bytes(&mut mcp, 2, &entry).unwrap();
        }
        let mut exec = vec![8, 8];
        protobuf::write_bytes(&mut exec, 11, &mcp).unwrap();
        let mut args = Vec::new();
        for (id, content, status) in [
            ("cursor", "Build", Some(3)),
            ("host-b", "Rename", None),
            ("cursor-2", "Rename", Some(2)),
            ("orphan", "", Some(3)),
            ("new", "New", Some(1)),
            ("new", "", Some(3)),
        ] {
            let mut item = bytes(1, id.as_bytes());
            if !content.is_empty() {
                protobuf::write_bytes(&mut item, 2, content.as_bytes()).unwrap();
            }
            if let Some(status) = status {
                protobuf::write_varint(&mut item, 3, status).unwrap();
            }
            protobuf::write_bytes(&mut args, 1, &item).unwrap();
        }
        protobuf::write_varint(&mut args, 2, 1).unwrap();
        let mut completed = bytes(1, b"display-merge");
        protobuf::write_bytes(&mut completed, 2, &bytes(9, &bytes(1, &args))).unwrap();
        let mut plan = bytes(1, b"display-plan");
        protobuf::write_bytes(&mut plan, 2, &bytes(17, &bytes(1, &bytes(1, b"# Plan")))).unwrap();
        tool_flows(vec![
            Flow { query: bytes(2, &exec), tool: tool(name), input, output, error: false, initial_replies: vec![], replies: vec![bytes(2, &[vec![8, 8], bytes(11, &bytes(1, &[bytes(1, &bytes(1, &bytes(1, output.as_bytes()))), vec![16, 0]].concat()))].concat()), bytes(5, &bytes(1, &[8, 8]))] },
            Flow { query: bytes(2, &[vec![8, 9], bytes(11, &bytes(1, format!("{HOST_TOOL_NAMESPACE}-todoread").as_bytes()))].concat()), tool: tool("todoread"), input: "{}", output: "List was capped", error: false, initial_replies: vec![], replies: vec![bytes(2, &[vec![8, 9], bytes(11, &bytes(1, &[bytes(1, &bytes(1, &bytes(1, b"List was capped"))), vec![16, 0]].concat()))].concat()), bytes(5, &bytes(1, &[8, 9]))] },
            Flow { query: bytes(2, &[vec![8, 10], bytes(11, &bytes(1, format!("{HOST_TOOL_NAMESPACE}-todoread").as_bytes()))].concat()), tool: tool("todoread"), input: "{}", output: "[]", error: true, initial_replies: vec![], replies: vec![bytes(2, &[vec![8, 10], bytes(11, &bytes(2, &bytes(1, b"[]")))].concat()), bytes(5, &bytes(1, &[8, 10]))] },
            Flow { query: bytes(1, &bytes(3, &plan)), tool: tool("todowrite"), input: r##"{"todos":[{"id":"plan","content":"# Plan","status":"completed","priority":"high"}]}"##, output: "ok", error: false, initial_replies: vec![], replies: vec![] },
            Flow { query: bytes(1, &bytes(3, &completed)), tool: tool("todowrite"), input: r#"{"todos":[{"id":"host-b","content":"Rename","status":"in_progress","priority":"high"},{"id":"other","content":"Keep","status":"pending","priority":"low"},{"id":"new","content":"New","status":"completed","priority":"medium"}]}"#, output: "ok", error: false, initial_replies: vec![], replies: vec![] }
        ]).await;
    }
}

#[tokio::test]
async fn cursor_completed_todos_mirror_host_state_without_executing_display_mcp_calls() {
    let mut item = Vec::new();
    protobuf::write_string(&mut item, 1, &"one".into()).unwrap();
    protobuf::write_string(&mut item, 2, &"Build".into()).unwrap();
    protobuf::write_varint(&mut item, 3, 3).unwrap();
    let args = bytes(1, &item);
    let mut completed = bytes(1, b"display-1");
    protobuf::write_bytes(&mut completed, 2, &bytes(9, &bytes(1, &args))).unwrap();
    tool_flow(Flow { query: bytes(1, &bytes(3, &completed)), tool: tool("todowrite"), input: r#"{"todos":[{"id":"one","content":"Build","status":"completed","priority":"medium"}]}"#, output: "ok", error: false, initial_replies: vec![], replies: vec![] }).await;
}

fn question_query(run_async: bool) -> (Vec<u8>, Vec<u8>) {
    let mut option = bytes(1, b"a");
    protobuf::write_bytes(&mut option, 2, b"Alpha").unwrap();
    let mut question = bytes(1, b"q1");
    protobuf::write_bytes(&mut question, 2, b"Pick").unwrap();
    protobuf::write_bytes(&mut question, 3, &option).unwrap();
    let mut other = bytes(1, b"other");
    protobuf::write_bytes(&mut other, 2, b"Other").unwrap();
    protobuf::write_bytes(&mut question, 3, &other).unwrap();
    let mut args = bytes(1, b"Choose");
    protobuf::write_bytes(&mut args, 2, &question).unwrap();
    if run_async {
        protobuf::write_varint(&mut args, 5, 1).unwrap();
    }
    protobuf::write_varint(&mut args, 60, 7).unwrap();
    let mut body = bytes(1, &args);
    protobuf::write_bytes(&mut body, 2, b"original").unwrap();
    (bytes(7, &bytes(3, &body)), args)
}

#[tokio::test]
async fn cursor_question_sync_and_async_preserve_option_identity_and_original_args() {
    let mut answer = bytes(1, b"q1");
    protobuf::write_bytes(&mut answer, 2, b"a").unwrap();
    protobuf::write_bytes(&mut answer, 3, b"Custom").unwrap();
    let result = bytes(1, &bytes(1, &answer));
    for run_async in [false, true] {
        let (query, args) = question_query(run_async);
        let initial_replies = if run_async {
            vec![bytes(
                6,
                &[vec![8, 0], bytes(3, &bytes(1, &bytes(4, &[])))].concat(),
            )]
        } else {
            vec![]
        };
        let reply = if run_async {
            let mut completion = bytes(1, b"original");
            protobuf::write_bytes(&mut completion, 2, &args).unwrap();
            protobuf::write_bytes(&mut completion, 3, &result).unwrap();
            bytes(4, &bytes(8, &completion))
        } else {
            bytes(6, &[vec![8, 0], bytes(3, &bytes(1, &result))].concat())
        };
        tool_flow(Flow { query, tool: tool("question"), input: r#"{"questions":[{"question":"Pick","header":"Choose","options":[{"label":"Alpha","description":""}]}]}"#, output: r#"User has answered your questions: "Pick"="Alpha, Custom". You can now continue with the user's answers in mind."#, error: false, initial_replies, replies: vec![reply] }).await;
    }
}

#[tokio::test]
async fn cursor_headless_interactions_ack_environment_and_reject_ui_only_queries() {
    let reason =
        "This Cursor interaction requires UI approval and is not available through this provider.";
    let queries = [2, 8, 9, 10, 11, 13, 14]
        .into_iter()
        .map(|variant| {
            let result = match variant {
                8 => bytes(1, &[]),
                13 => bytes(
                    2,
                    &[
                        bytes(
                            1,
                            b"Environment replacement is not supported by this provider.",
                        ),
                        bytes(2, &[]),
                    ]
                    .concat(),
                ),
                10 => bytes(3, &bytes(1, reason.as_bytes())),
                _ => bytes(2, &bytes(1, reason.as_bytes())),
            };
            (
                bytes(7, &bytes(variant, &[])),
                vec![bytes(6, &[vec![8, 0], bytes(variant, &result)].concat())],
            )
        })
        .collect();
    controls(vec![34, 0], vec![], None, vec![], queries).await;
}

#[tokio::test]
async fn cursor_native_pi_write_and_edit_use_offset_result_fields_and_preserve_empty_text() {
    let mut write = bytes(1, b"a.ts");
    protobuf::write_bytes(&mut write, 2, b"").unwrap();
    tool_flow(Flow {
        query: exec(48, &write),
        tool: tool("write"),
        input: r#"{"filePath":"a.ts","content":""}"#,
        output: "done",
        error: false,
        initial_replies: vec![],
        replies: vec![
            exec(49, &bytes(1, &bytes(1, b"done"))),
            vec![42, 4, 10, 2, 8, 8],
        ],
    })
    .await;
    let mut replacement = bytes(1, b"old");
    protobuf::write_bytes(&mut replacement, 2, b"").unwrap();
    let mut edit = bytes(1, b"a.ts");
    protobuf::write_bytes(&mut edit, 2, &replacement).unwrap();
    tool_flow(Flow {
        query: exec(47, &edit),
        tool: tool("edit"),
        input: r#"{"filePath":"a.ts","oldString":"old","newString":""}"#,
        output: "done",
        error: false,
        initial_replies: vec![],
        replies: vec![
            exec(48, &bytes(1, &bytes(1, b"done"))),
            vec![42, 4, 10, 2, 8, 8],
        ],
    })
    .await;
}

#[tokio::test]
async fn cursor_native_text_write_prefers_encoded_bytes_and_returns_typed_success() {
    for bytes_input in [false, true] {
        let mut args = bytes(1, b"a.ts");
        protobuf::write_bytes(&mut args, 2, b"wrong").unwrap();
        if bytes_input {
            protobuf::write_bytes(&mut args, 5, &[65, 0]).unwrap();
            protobuf::write_bytes(&mut args, 6, b"UTF_16LE").unwrap();
        }
        let input = if bytes_input {
            r#"{"filePath":"a.ts","content":"A"}"#
        } else {
            r#"{"filePath":"a.ts","content":"wrong"}"#
        };
        let mut success = bytes(1, b"a.ts");
        protobuf::write_varint(&mut success, 2, 2).unwrap();
        protobuf::write_varint(&mut success, 3, 5).unwrap();
        tool_flow(Flow {
            query: exec(3, &args),
            tool: tool("write"),
            input,
            output: "ok\n😀",
            error: false,
            initial_replies: vec![],
            replies: vec![exec(3, &bytes(1, &success)), bytes(5, &bytes(1, &[8, 8]))],
        })
        .await;
    }
    let args = bytes(1, b"a.ts");
    let mut error = bytes(1, b"a.ts");
    protobuf::write_bytes(&mut error, 2, b"denied").unwrap();
    tool_flow(Flow {
        query: exec(3, &args),
        tool: tool("write"),
        input: r#"{"filePath":"a.ts"}"#,
        output: "denied",
        error: true,
        initial_replies: vec![],
        replies: vec![exec(3, &bytes(5, &error)), bytes(5, &bytes(1, &[8, 8]))],
    })
    .await;
}

#[tokio::test]
async fn cursor_native_text_write_without_request_path_reports_the_first_complete_path_tag() {
    let mut args = Vec::new();
    protobuf::write_bytes(&mut args, 2, b"x").unwrap();
    let output = "<path></path><path>a<path>/x/y.ts</path>\nok";
    let mut success = bytes(1, b"/x/y.ts");
    protobuf::write_varint(&mut success, 2, 2).unwrap();
    protobuf::write_varint(&mut success, 3, output.encode_utf16().count() as u64).unwrap();
    tool_flow(Flow {
        query: exec(3, &args),
        tool: tool("write"),
        input: r#"{"content":"x"}"#,
        output,
        error: false,
        initial_replies: vec![],
        replies: vec![exec(3, &bytes(1, &success)), bytes(5, &bytes(1, &[8, 8]))],
    })
    .await;
}

#[tokio::test]
async fn cursor_mcp_read_maps_host_file_path_and_omits_protobuf_zero_ranges() {
    let input = ycoding_schema::parse_json(
        r#"{"path":"a.ts","offset":0,"limit":0,"tool_call_id":"internal"}"#,
    )
    .unwrap();
    let value = protobuf::encode_value(&input).unwrap();
    let value = protobuf::fields(&value).unwrap();
    let entries = protobuf::fields(value[0].bytes().unwrap()).unwrap();
    let mut mcp = bytes(1, format!("{HOST_TOOL_NAMESPACE}-read").as_bytes());
    for entry in entries {
        protobuf::write_bytes(&mut mcp, 2, entry.bytes().unwrap()).unwrap();
    }
    let mut read = tool("read");
    read.input_schema = ycoding_schema::parse_json(
        r#"{"type":"object","properties":{"filePath":{"type":"string"}}}"#,
    )
    .unwrap();
    let success = [bytes(1, &bytes(1, &bytes(1, b"done"))), vec![16, 0]].concat();
    tool_flow(Flow {
        query: exec(11, &mcp),
        tool: read,
        input: r#"{"filePath":"a.ts"}"#,
        output: "done",
        error: false,
        initial_replies: vec![],
        replies: vec![exec(11, &bytes(1, &success)), vec![42, 4, 10, 2, 8, 8]],
    })
    .await;
}

#[tokio::test]
async fn cursor_native_pi_edit_refuses_multiple_replacements_without_host_execution() {
    let mut replacement = bytes(1, b"old");
    protobuf::write_bytes(&mut replacement, 2, b"new").unwrap();
    let mut args = bytes(1, b"a.ts");
    protobuf::write_bytes(&mut args, 2, &replacement).unwrap();
    protobuf::write_bytes(&mut args, 2, &replacement).unwrap();
    let reason = "Cursor Pi edit cannot be represented safely: expected one non-empty replacement.";
    let reply = exec(48, &bytes(2, &bytes(1, reason.as_bytes())));
    let fields = protobuf::fields(&reply).unwrap();
    let mut body = fields[0].bytes().unwrap().to_vec();
    protobuf::write_varint(&mut body, 39, 0).unwrap();
    controls(
        vec![34, 0],
        vec![tool("edit")],
        None,
        vec![],
        vec![(
            exec(47, &args),
            vec![bytes(2, &body), vec![42, 4, 10, 2, 8, 8]],
        )],
    )
    .await;
}

#[tokio::test]
async fn cursor_nested_mcp_catalog_rehydrates_full_definitions_and_preserves_base_fields() {
    let definition = Descriptor {
        name: format!("{HOST_TOOL_NAMESPACE}-read").into(),
        description: "read".into(),
        input_schema: ycoding_schema::parse_json(r#"{"type":"object"}"#).unwrap(),
        provider: HOST_TOOL_NAMESPACE.into(),
        tool_name: "read".into(),
    };
    let mut filesystem = vec![8, 1];
    protobuf::write_bytes(&mut filesystem, 2, b"project").unwrap();
    protobuf::write_bytes(&mut filesystem, 3, &bytes(2, b"obsolete")).unwrap();
    let fixed64 = [161, 6, 1, 2, 3, 4, 5, 6, 7, 8];
    let fixed32 = [173, 6, 9, 10, 11, 12];
    let context = [
        vec![34, 0],
        bytes(23, &filesystem),
        fixed64.to_vec(),
        fixed32.to_vec(),
    ]
    .concat();
    let initial = controls(
        context,
        vec![tool("read")],
        None,
        vec![],
        vec![(
            exec(36, &[]),
            vec![mcp_state_result(&[definition]), vec![42, 4, 10, 2, 8, 8]],
        )],
    )
    .await;
    let client = protobuf::fields(&initial).unwrap();
    let run = protobuf::fields(client[0].bytes().unwrap()).unwrap();
    let action = protobuf::fields(
        run.iter()
            .find(|field| field.number == 2)
            .unwrap()
            .bytes()
            .unwrap(),
    )
    .unwrap();
    let user = protobuf::fields(action[0].bytes().unwrap()).unwrap();
    let context = protobuf::fields(
        user.iter()
            .find(|field| field.number == 2)
            .unwrap()
            .bytes()
            .unwrap(),
    )
    .unwrap();
    let mut preserved = Vec::new();
    for field in context.iter().filter(|field| field.number >= 100) {
        field.write(&mut preserved).unwrap();
    }
    assert_eq!(preserved, [fixed64.to_vec(), fixed32.to_vec()].concat());
    let filesystem = protobuf::fields(
        context
            .iter()
            .find(|field| field.number == 23)
            .unwrap()
            .bytes()
            .unwrap(),
    )
    .unwrap();
    assert_eq!(filesystem[0].varint().unwrap(), 1);
    assert_eq!(filesystem[1].text().unwrap(), "project");
}

#[tokio::test]
async fn cursor_question_is_rejected_when_execution_is_disabled() {
    let (query, _) = question_query(false);
    let reason = "The `question` tool is not available to the current agent, so questions cannot be shown to the user this turn. State the question in your reply instead.";
    let reply = bytes(
        6,
        &[
            vec![8, 0],
            bytes(3, &bytes(1, &bytes(3, &bytes(1, reason.as_bytes())))),
        ]
        .concat(),
    );
    controls(
        vec![34, 0],
        vec![tool("question")],
        Some(ToolChoice::None),
        vec![],
        vec![(query, vec![reply])],
    )
    .await;
}

fn bytes(number: u32, payload: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    protobuf::write_bytes(&mut out, number, payload).unwrap();
    out
}
fn exec(number: u32, args: &[u8]) -> Vec<u8> {
    let mut out = vec![8, 8];
    protobuf::write_bytes(&mut out, number, args).unwrap();
    bytes(2, &out)
}
fn tool(name: &str) -> ToolDefinition {
    ToolDefinition {
        name: name.into(),
        description: name.into(),
        input_schema: ycoding_schema::parse_json(r#"{"type":"object"}"#).unwrap(),
        output_schema: None,
        cache: None,
        metadata: None,
        native: None,
    }
}
async fn controls(
    context: Vec<u8>,
    tools: Vec<ToolDefinition>,
    choice: Option<ToolChoice>,
    known_servers: Vec<String>,
    queries: Vec<(Vec<u8>, Vec<Vec<u8>>)>,
) -> Vec<u8> {
    observed_controls(context, tools, choice, known_servers, queries, None).await
}
async fn observed_controls(
    context: Vec<u8>,
    tools: Vec<ToolDefinition>,
    choice: Option<ToolChoice>,
    known_servers: Vec<String>,
    queries: Vec<(Vec<u8>, Vec<Vec<u8>>)>,
    observations: Option<Arc<dyn observations::Host>>,
) -> Vec<u8> {
    tokio::time::timeout(Duration::from_secs(5), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (socket, _) = listener.accept().await.unwrap();
            let mut connection = h2::server::handshake(socket).await.unwrap();
            let (request, mut response) = connection.accept().await.unwrap().unwrap();
            let mut body = request.into_body();
            let exchange = async move {
                let mut decoder = framing::Decoder::default();
                let initial = loop {
                    let chunk = body.data().await.unwrap().unwrap();
                    body.flow_control().release_capacity(chunk.len()).unwrap();
                    if let Some(frame) = decoder.push(&chunk).pop() { break frame.payload; }
                };
                let mut send = response.send_response(Response::builder().status(200).body(()).unwrap(), false).unwrap();
                for (query, replies) in queries {
                    send.send_data(Bytes::from(framing::encode(0, &query).unwrap()), false).unwrap();
                    let mut observed = Vec::new();
                    while observed.len() < replies.len() {
                        let chunk = body.data().await.unwrap().unwrap();
                        body.flow_control().release_capacity(chunk.len()).unwrap();
                        observed.extend(decoder.push(&chunk).into_iter().map(|frame| frame.payload));
                    }
                    assert_eq!(observed, replies);
                }
                send.send_data(Bytes::from(framing::encode(0, &[10, 2, 114, 0]).unwrap()), false).unwrap();
                while let Some(chunk) = body.data().await {
                    match chunk {
                        Ok(chunk) => body.flow_control().release_capacity(chunk.len()).unwrap(),
                        Err(error) => { assert_eq!(error.reason(), Some(h2::Reason::CANCEL)); break; }
                    }
                }
                initial
            };
            tokio::pin!(exchange);
            tokio::select! { initial = &mut exchange => initial, next = connection.accept() => { assert!(next.is_none()); exchange.await } }
        });
        let runtime = Arc::new(provider::Runtime::new(Default::default()).unwrap());
        let mut config = provider::Config::new(Auth::bearer(Credential::value("fixture-token")), headers::Identity { machine_id: "machine".into(), mac_machine_id: None, client_version: "cli-fixture".into() }, provider::RequestContext::new(context).unwrap(), runtime.clone());
        config.agent = Some(transport::Endpoint::loopback(address).unwrap());
        config.known_mcp_servers = known_servers;
        config.observations = observations.clone();
        let mut request = Request::new(provider::model("composer-fixture", config).unwrap());
        request.messages.push(Message::user("Hello"));
        if observations.is_some() { request.http.headers.insert("x-session-id".into(), "ses-fixture".into()); }
        request.tools = tools;
        request.tool_choice = choice;
        let response = Executor::new(Executor::http_client().unwrap()).generate(&request).await.unwrap();
        assert_eq!(response.finish_reason, FinishReason::Stop);
        assert!(!response.message.content.iter().any(|part| matches!(part, ycoding_ai::llm::Part::ToolCall(_))));
        let initial = server.await.unwrap();
        runtime.shutdown().await;
        initial
    }).await.unwrap()
}

fn mcp_state_result(definitions: &[Descriptor]) -> Vec<u8> {
    let mut success = Vec::new();
    for definition in definitions {
        let mut server = Vec::new();
        protobuf::write_string(&mut server, 1, &definition.provider).unwrap();
        protobuf::write_string(&mut server, 2, &definition.provider).unwrap();
        protobuf::write_bytes(&mut server, 5, &definition.encode().unwrap()).unwrap();
        protobuf::write_bytes(&mut success, 1, &server).unwrap();
    }
    exec(36, &bytes(1, &success))
}

#[tokio::test]
async fn cursor_mcp_state_and_request_context_use_the_run_advertisement_and_filter_servers() {
    let definitions = [
        Descriptor {
            name: format!("{HOST_TOOL_NAMESPACE}-read").into(),
            description: "read".into(),
            input_schema: ycoding_schema::parse_json(r#"{"type":"object"}"#).unwrap(),
            provider: HOST_TOOL_NAMESPACE.into(),
            tool_name: "read".into(),
        },
        Descriptor {
            name: "git_hub-search".into(),
            description: "git_hub_search".into(),
            input_schema: ycoding_schema::parse_json(r#"{"type":"object"}"#).unwrap(),
            provider: "git_hub".into(),
            tool_name: "search".into(),
        },
    ];
    let mut requested = Vec::new();
    protobuf::write_string(&mut requested, 1, &"git_hub".into()).unwrap();
    let close = vec![42, 4, 10, 2, 8, 8];
    let initial = controls(
        vec![34, 0],
        vec![tool("read"), tool("git_hub_search")],
        None,
        vec!["git".into(), "git_hub".into()],
        vec![
            (
                exec(36, &requested),
                vec![mcp_state_result(&definitions[1..]), close.clone()],
            ),
            (
                exec(36, &bytes(1, b"missing")),
                vec![mcp_state_result(&[]), close.clone()],
            ),
            (
                exec(36, &[]),
                vec![
                    mcp_state_result(&[definitions[1].clone(), definitions[0].clone()]),
                    close,
                ],
            ),
        ],
    )
    .await;
    let client = protobuf::fields(&initial).unwrap();
    let run = protobuf::fields(client[0].bytes().unwrap()).unwrap();
    let action = protobuf::fields(
        run.iter()
            .find(|field| field.number == 2)
            .unwrap()
            .bytes()
            .unwrap(),
    )
    .unwrap();
    let user = protobuf::fields(action[0].bytes().unwrap()).unwrap();
    let context = protobuf::fields(
        user.iter()
            .find(|field| field.number == 2)
            .unwrap()
            .bytes()
            .unwrap(),
    )
    .unwrap();
    let advertised = context
        .iter()
        .filter(|field| field.number == 7)
        .map(|field| field.bytes().unwrap().to_vec())
        .collect::<Vec<_>>();
    assert_eq!(
        advertised,
        vec![
            definitions[1].encode().unwrap(),
            definitions[0].encode().unwrap()
        ]
    );
    assert!(
        context
            .iter()
            .find(|field| field.number == 4)
            .unwrap()
            .bytes()
            .unwrap()
            .is_empty()
    );
}

#[tokio::test]
async fn cursor_tool_choice_none_keeps_advertisement_but_denies_execution() {
    let mut args = Vec::new();
    protobuf::write_string(&mut args, 1, &format!("{HOST_TOOL_NAMESPACE}-read").into()).unwrap();
    protobuf::write_string(&mut args, 4, &HOST_TOOL_NAMESPACE.into()).unwrap();
    protobuf::write_string(&mut args, 5, &"read".into()).unwrap();
    let reason = "The requested host tool is not available for this step; use an advertised tool";
    let reply = exec(11, &bytes(2, &bytes(1, reason.as_bytes())));
    let mut reply = protobuf::fields(&reply).unwrap()[0]
        .bytes()
        .unwrap()
        .to_vec();
    protobuf::write_varint(&mut reply, 39, 0).unwrap();
    let initial = controls(
        vec![34, 0],
        vec![tool("read")],
        Some(ToolChoice::None),
        vec![],
        vec![(
            exec(11, &args),
            vec![bytes(2, &reply), vec![42, 4, 10, 2, 8, 8]],
        )],
    )
    .await;
    let client = protobuf::fields(&initial).unwrap();
    let run = protobuf::fields(client[0].bytes().unwrap()).unwrap();
    let catalog = protobuf::fields(
        run.iter()
            .find(|field| field.number == 4)
            .unwrap()
            .bytes()
            .unwrap(),
    )
    .unwrap();
    assert_eq!(catalog.len(), 1);
}

#[tokio::test]
async fn cursor_tool_refusal_carries_the_request_context_workspace_root() {
    let mut args = Vec::new();
    protobuf::write_string(&mut args, 1, &format!("{HOST_TOOL_NAMESPACE}-read").into()).unwrap();
    protobuf::write_string(&mut args, 4, &HOST_TOOL_NAMESPACE.into()).unwrap();
    protobuf::write_string(&mut args, 5, &"read".into()).unwrap();
    let reason = "The requested host tool is not available for this step; use an advertised tool\nWorkspace root: \"/work/space\". Resolve workspace paths against exactly this root; never invent an absolute prefix, and verify uncertain paths with an available tool before using them.";
    let reply = exec(11, &bytes(2, &bytes(1, reason.as_bytes())));
    let mut reply = protobuf::fields(&reply).unwrap()[0]
        .bytes()
        .unwrap()
        .to_vec();
    protobuf::write_varint(&mut reply, 39, 0).unwrap();
    controls(
        vec![
            34, 13, 18, 11, b'/', b'w', b'o', b'r', b'k', b'/', b's', b'p', b'a', b'c', b'e',
        ],
        vec![tool("read")],
        Some(ToolChoice::None),
        vec![],
        vec![(
            exec(11, &args),
            vec![bytes(2, &reply), vec![42, 4, 10, 2, 8, 8]],
        )],
    )
    .await;
}
