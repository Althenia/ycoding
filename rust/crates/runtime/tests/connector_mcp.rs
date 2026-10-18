mod remote_derived_support;
mod support;
mod connector_support {
    pub const WAIT: std::time::Duration = super::support::WAIT;
}

use remote_derived_support::{Fixture, expired_peer, now, world};
use std::{
    collections::BTreeSet,
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
};
use ycoding_core::ycoding_schema::{
    DomainDecode, JsonValue, LosslessString, parse_json, session, stringify_json,
};
use ycoding_protocol::{OPERATION_IDS_BY_ROLE, OPERATIONS, v5};
use ycoding_runtime::{
    Dispatcher, Failure,
    connector::{
        Credential, Enrolled, Peer,
        mcp::{self, Context, Lane, Request, Response},
    },
    standard,
};

const VERSION: &str = "2026-07-28";
static NEXT: AtomicUsize = AtomicUsize::new(0);

const MAPPED: &[(&str, &str)] = &[
    ("artifact_demo_preview", "artifact.demo.preview"),
    ("artifact_demo_export", "artifact.demo.export"),
    ("local_app_register", "local.app.register"),
    ("local_app_list", "local.app.list"),
    ("local_app_revoke", "local.app.revoke"),
    ("local_app_open", "local.app.open"),
    ("local_app_status", "local.app.status"),
    ("local_app_http", "local.app.http"),
    ("provider_auth_list", "provider.auth.list"),
    ("provider_auth_key", "provider.auth.key"),
    ("provider_auth_begin", "provider.auth.begin"),
    ("provider_auth_status", "provider.auth.status"),
    ("provider_auth_complete", "provider.auth.complete"),
    ("provider_auth_cancel", "provider.auth.cancel"),
    ("workspace_list", "workspace.list"),
    ("session_list", "session.list"),
    ("session_active", "session.active"),
    ("session_get", "session.get"),
    ("session_messages", "session.messages"),
    (
        "session_captured_changes_list",
        "session.capturedChanges.list",
    ),
    ("session_compaction_list", "session.compaction.list"),
    ("session_compact", "session.compact"),
    ("session_snapshot", "session.snapshot"),
    ("session_pending_list", "session.pending.list"),
    ("session_attachment_read", "session.attachment.read"),
    ("session_todo_list", "session.todo.list"),
    ("session_subagent_list", "session.subagent.list"),
    ("session_pin", "session.pin"),
    ("session_unpin", "session.unpin"),
    ("session_subagent_cancel", "session.subagent.cancel"),
    ("session_subagent_answer", "session.subagent.answer"),
    ("session_team_economics", "session.team.economics"),
    ("session_team_shell_list", "session.team.shell.list"),
    ("session_team_shell_kill", "session.team.shell.kill"),
    ("session_side_chat_list", "session.side-chat.list"),
    ("session_side_chat_create", "session.side-chat.create"),
    ("session_family_activity", "session.family.activity"),
    ("session_log", "session.log"),
    ("session_prompt", "session.prompt"),
    ("session_interrupt", "session.interrupt"),
    ("session_prediction", "session.prediction"),
    ("session_prompt_generate", "session.promptGenerate"),
    ("session_permission_list", "session.permission.list"),
    ("session_permission_reply", "session.permission.reply"),
    ("session_guardrail_status", "session.guardrail.status"),
    (
        "session_guardrail_request_list",
        "session.guardrail.request.list",
    ),
    ("session_guardrail_reply", "session.guardrail.request.reply"),
    ("session_review_list", "session.review.list"),
    ("session_review_decide", "session.review.decide"),
    ("session_form_list", "session.form.list"),
    ("session_form_reply", "session.form.reply"),
    ("session_form_cancel", "session.form.cancel"),
    ("session_shell_output", "shell.output"),
    ("session_autonomy_get", "session.autonomy.get"),
    ("session_autonomy_set", "session.autonomy.set"),
    ("session_goal_set", "session.autonomy.set"),
    ("session_goal_stop", "session.autonomy.set"),
    ("session_create", "session.create"),
    ("session_status", "session.status"),
    ("session_catalog", "catalog.get"),
    ("workspace_catalog", "catalog.get"),
    ("session_file_find", "fs.find"),
    ("workspace_file_find", "fs.find"),
    ("session_switch_model", "session.switchModel"),
    ("session_switch_agent", "session.switchAgent"),
    ("session_command", "session.command"),
    ("session_skill", "session.skill"),
    ("usage_providers", "providerUsage.list"),
    ("usage_summary", "usage.get"),
    ("usage_report", "usage.report"),
    ("session_usage_report", "session.usageReport"),
    ("session_prompt_costs", "session.promptCosts"),
    ("session_task_costs", "session.taskCosts"),
    ("usage_forecast", "providerUsage.forecast"),
    ("incident_report", "incident.report"),
    ("incident_recent", "incident.recent"),
    ("incident_guidance", "incident.guidance.get"),
    ("machine_keep_awake_get", "keepAwake.get"),
    ("machine_keep_awake_set", "keepAwake.set"),
];

const EXCLUDED: &[&str] = &[
    "event.subscribe",
    "event.unsubscribe",
    "session.message",
    "session.attachment.upload",
    "telemetry.append",
    "telemetry.list",
    "telemetry.consent.get",
    "telemetry.consent.set",
];

fn peer() -> Peer {
    Peer::authenticate(
        &Enrolled::new("https://relay.invalid", "device-a".into()).unwrap(),
        &Credential::new(
            "mcp-test".into(),
            now() + 600_000,
            "https://relay.invalid".into(),
            "device-a".into(),
        ),
        now(),
    )
    .unwrap()
}

fn context(fixture: &Fixture, dispatcher: Dispatcher, home: &Path) -> Context {
    Context {
        environment: fixture.environment(true),
        dispatcher: Arc::new(dispatcher),
        peer: peer(),
        connection_id: "mcp-connection".into(),
        home: home.to_path_buf(),
        trusted_context: None,
        access: mcp::Access::new(
            Arc::new(mcp::Server::default()),
            mcp::Lease::new(peer(), "mcp-connection".into(), "epoch-fixture".into()).unwrap(),
            Arc::new(std::sync::atomic::AtomicBool::new(false)),
        ),
    }
}

fn quoted(value: &str) -> String {
    stringify_json(&JsonValue::String(value.into()))
}

fn meta() -> String {
    format!(
        r#"{{"io.modelcontextprotocol/protocolVersion":"{VERSION}","io.modelcontextprotocol/clientInfo":{{"name":"fixture","version":"1"}},"io.modelcontextprotocol/clientCapabilities":{{}}}}"#
    )
}

fn headers(method: &str, name: Option<&str>) -> Vec<(String, LosslessString)> {
    let mut headers = vec![
        ("content-type".into(), "application/json".into()),
        (
            "accept".into(),
            "application/json, text/event-stream".into(),
        ),
        ("mcp-protocol-version".into(), VERSION.into()),
        ("mcp-method".into(), method.into()),
    ];
    if let Some(name) = name {
        headers.push(("mcp-name".into(), name.into()));
    }
    headers
}

fn call_body(tool: &str, arguments: &str) -> String {
    format!(
        r#"{{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{{"name":{},"arguments":{arguments},"_meta":{}}}}}"#,
        quoted(tool),
        meta()
    )
}

async fn call(cx: &Context, tool: &str, arguments: &str) -> (Response, JsonValue) {
    let response = mcp::handle(
        cx,
        Request {
            body: call_body(tool, arguments).as_str().into(),
            headers: headers("tools/call", Some(tool)),
        },
    )
    .await;
    assert_eq!(response.status, 200, "{}", response.body);
    assert_eq!(response.content_type, "application/json");
    let parsed = parse_json(&response.body).unwrap();
    let result = at(&parsed, &["result"]).unwrap_or_else(|| panic!("{}", response.body));
    let result = result.clone();
    (response, result)
}

fn at<'a>(value: &'a JsonValue, path: &[&str]) -> Option<&'a JsonValue> {
    path.iter().try_fold(value, |value, key| match value {
        JsonValue::Object(object) => object.get(&(*key).into()),
        _ => None,
    })
}

fn string(value: &JsonValue, path: &[&str]) -> Option<String> {
    match at(value, path)? {
        JsonValue::String(text) => text.as_str().map(str::to_owned),
        _ => None,
    }
}

fn failed(result: &JsonValue) -> bool {
    matches!(at(result, &["isError"]), Some(JsonValue::Bool(true)))
}

fn invalid_arguments(result: &JsonValue) -> bool {
    failed(result)
        && string(result, &["structuredContent", "error", "code"]).as_deref()
            == Some("invalid_arguments")
}

fn session_record(id: &str) -> Option<session::Info> {
    let id = session::Id::decode(&JsonValue::String(id.into())).unwrap();
    world().core.sessions.get(&id).unwrap()
}

fn fresh_session(prefix: &str) -> String {
    format!(
        "ses_{prefix}{}x{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    )
}

#[test]
fn the_catalog_is_exactly_the_mapped_tools_plus_directory_creation() {
    let tools = mcp::tools();
    let names = tools.iter().map(|tool| tool.name).collect::<BTreeSet<_>>();
    let mut expected = MAPPED
        .iter()
        .map(|(name, _)| *name)
        .collect::<BTreeSet<_>>();
    expected.insert("session_create_in_directory");
    assert_eq!(tools.len(), 80);
    assert_eq!(names, expected);
    assert!(!names.contains("incident_guidance_clear"));
    for (name, operation) in MAPPED {
        let tool = tools.iter().find(|tool| tool.name == *name).unwrap();
        assert_eq!(tool.operation, Some(*operation), "{name}");
    }
    let directory = tools
        .iter()
        .find(|tool| tool.name == "session_create_in_directory")
        .unwrap();
    assert_eq!(directory.operation, None);
    assert!(directory.mutation);
}

#[test]
fn bound_operations_and_exclusions_partition_the_relay_allowlist() {
    let relay = OPERATION_IDS_BY_ROLE
        .iter()
        .find(|(role, _)| *role == v5::PeerRole::Relay as i32)
        .unwrap()
        .1;
    let relay = OPERATIONS
        .iter()
        .filter(|descriptor| relay.contains(&descriptor.operation_id))
        .map(|descriptor| descriptor.diagnostic_name.as_str())
        .collect::<BTreeSet<_>>();
    let bound = MAPPED
        .iter()
        .map(|(_, operation)| *operation)
        .collect::<BTreeSet<_>>();
    let excluded = EXCLUDED.iter().copied().collect::<BTreeSet<_>>();
    assert!(bound.is_disjoint(&excluded));
    assert_eq!(bound.len(), 75);
    let mut partition = bound.union(&excluded).copied().collect::<BTreeSet<_>>();
    assert!(!partition.contains("mcp.request"));
    partition.insert("mcp.request");
    assert_eq!(relay.len(), 84);
    assert_eq!(partition, relay);
    assert!(!relay.contains("incident.guidance.clear"));
    let remote = OPERATION_IDS_BY_ROLE
        .iter()
        .find(|(role, _)| *role == v5::PeerRole::RemoteClient as i32)
        .unwrap()
        .1;
    assert_eq!(remote.len(), 87);
    let request = OPERATIONS
        .iter()
        .find(|descriptor| descriptor.diagnostic_name == "mcp.request")
        .unwrap();
    assert_eq!(request.operation_id, 5044);
    assert!(!remote.contains(&5044));
    assert!(
        mcp::tools()
            .iter()
            .all(|tool| tool.operation != Some("mcp.request"))
    );
    for tool in mcp::tools().iter().filter(|tool| tool.operation.is_some()) {
        let descriptor = OPERATIONS
            .iter()
            .find(|descriptor| Some(descriptor.diagnostic_name.as_str()) == tool.operation)
            .unwrap();
        assert!(
            descriptor
                .roles
                .contains(&(v5::PeerRole::RemoteClient as i32))
        );
        assert!(descriptor.roles.contains(&(v5::PeerRole::Relay as i32)));
        assert_eq!(
            tool.mutation,
            descriptor.mutation == v5::MutationClass::Mutation as i32,
            "{}",
            tool.name
        );
    }
}

#[test]
fn lanes_follow_backend_session_routing_for_mutations_only() {
    let lane = |tool: &str, arguments: &str| mcp::lane(&call_body(tool, arguments).as_str().into());
    assert_eq!(
        lane("session_prompt", r#"{"sessionID":"ses_a","input":{}}"#),
        Some(Lane::Session("ses_a".into()))
    );
    assert_eq!(
        lane("session_interrupt", r#"{"sessionID":"ses_a"}"#),
        Some(Lane::Session("ses_a".into()))
    );
    assert_eq!(
        lane(
            "session_create",
            r#"{"input":{"payload":{"id":"ses_new"}}}"#
        ),
        Some(Lane::Session("ses_new".into()))
    );
    assert_eq!(
        lane(
            "session_create_in_directory",
            r#"{"input":{"id":"ses_dir","directory":"/x"}}"#
        ),
        Some(Lane::Session("ses_dir".into()))
    );
    assert_eq!(
        lane(
            "provider_auth_key",
            r#"{"input":{"payload":{"target":{"sessionID":"ses_t"}}}}"#
        ),
        Some(Lane::Session("ses_t".into()))
    );
    assert_eq!(
        lane(
            "machine_keep_awake_set",
            r#"{"input":{"payload":{"enabled":true}}}"#
        ),
        Some(Lane::Backend)
    );
    assert_eq!(lane("session_get", r#"{"sessionID":"ses_a"}"#), None);
    assert_eq!(lane("session_status", "{}"), None);
    assert_eq!(mcp::lane(&"not json".into()), None);
    let discover = format!(
        r#"{{"jsonrpc":"2.0","id":1,"method":"server/discover","params":{{"_meta":{}}}}}"#,
        meta()
    );
    assert_eq!(mcp::lane(&discover.as_str().into()), None);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn tools_list_publishes_closed_input_schemas_for_every_tool() {
    let fixture = Fixture::new().await;
    let cx = context(&fixture, standard().unwrap(), &fixture.path);
    let body = format!(
        r#"{{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{{"_meta":{}}}}}"#,
        meta()
    );
    let response = mcp::handle(
        &cx,
        Request {
            body: body.as_str().into(),
            headers: headers("tools/list", None),
        },
    )
    .await;
    assert_eq!(response.status, 200, "{}", response.body);
    let parsed = parse_json(&response.body).unwrap();
    let Some(JsonValue::Array(tools)) = at(&parsed, &["result", "tools"]) else {
        panic!("{}", response.body)
    };
    assert_eq!(tools.len(), 80);
    for tool in tools {
        assert_eq!(
            string(tool, &["inputSchema", "type"]).as_deref(),
            Some("object")
        );
        assert_eq!(
            at(tool, &["inputSchema", "additionalProperties"]),
            Some(&JsonValue::Bool(false))
        );
        assert!(string(tool, &["description"]).is_some_and(|text| !text.is_empty()));
    }
    let named = |name: &str| {
        tools
            .iter()
            .find(|tool| string(tool, &["name"]).as_deref() == Some(name))
            .unwrap()
    };
    let required = |name: &str| match at(named(name), &["inputSchema", "required"]) {
        Some(JsonValue::Array(items)) => items
            .iter()
            .filter_map(|item| match item {
                JsonValue::String(text) => text.as_str().map(str::to_owned),
                _ => None,
            })
            .collect::<Vec<_>>(),
        _ => vec![],
    };
    assert!(required("incident_guidance").contains(&"sessionID".to_owned()));
    assert!(required("session_get").contains(&"sessionID".to_owned()));
    assert!(!required("session_status").contains(&"sessionID".to_owned()));
    assert_eq!(
        at(named("session_get"), &["annotations", "readOnlyHint"]),
        Some(&JsonValue::Bool(true))
    );
    assert_eq!(
        at(named("session_prompt"), &["annotations", "readOnlyHint"]),
        Some(&JsonValue::Bool(false))
    );
    fixture.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn session_scoped_tools_dispatch_through_the_remote_operation_set() {
    let fixture = Fixture::new().await;
    let cx = context(&fixture, standard().unwrap(), &fixture.path);
    let (_, result) = call(
        &cx,
        "session_get",
        &format!(r#"{{"sessionID":{}}}"#, quoted(&fixture.root)),
    )
    .await;
    assert!(!failed(&result), "{}", stringify_json(&result));
    assert_eq!(
        string(&result, &["structuredContent", "data", "id"]),
        Some(fixture.root.clone())
    );
    let Some(JsonValue::Array(content)) = at(&result, &["content"]) else {
        panic!("missing text content")
    };
    assert_eq!(string(&content[0], &["type"]).as_deref(), Some("text"));
    assert_eq!(
        parse_json(&string(&content[0], &["text"]).unwrap()).unwrap(),
        at(&result, &["structuredContent"]).unwrap().clone()
    );

    let (_, managed) = call(
        &cx,
        "session_prompt",
        &format!(
            r#"{{"sessionID":{},"input":{{"payload":{{"id":"msg_child_input","text":"hi"}}}}}}"#,
            quoted(&fixture.child)
        ),
    )
    .await;
    assert!(failed(&managed));
    assert_eq!(
        string(&managed, &["structuredContent", "error", "type"]).as_deref(),
        Some("ycoding.v5.InvalidRequestError")
    );
    assert_eq!(
        string(&managed, &["structuredContent", "error", "value", "kind"]).as_deref(),
        Some("subagent_read_only")
    );

    let (_, missing) = call(&cx, "session_get", r#"{"sessionID":"ses_missing_record"}"#).await;
    assert!(failed(&missing));
    assert!(!invalid_arguments(&missing));
    fixture.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn arguments_are_validated_against_the_v5_domain_before_dispatch() {
    let fixture = Fixture::new().await;
    let cx = context(&fixture, standard().unwrap(), &fixture.path);
    let root = quoted(&fixture.root);
    for (tool, arguments) in [
        ("session_get", "{}".to_owned()),
        (
            "session_get",
            format!(r#"{{"sessionID":{root},"extra":1}}"#),
        ),
        (
            "session_get",
            format!(r#"{{"sessionID":{root},"input":{{"params":{{"other":1}}}}}}"#),
        ),
        (
            "incident_guidance",
            r#"{"input":{"query":{"provider":"p","model":"m"}}}"#.to_owned(),
        ),
        (
            "session_goal_set",
            format!(
                r#"{{"sessionID":{root},"input":{{"payload":{{"goal":"ship","maxNoProgress":0}}}}}}"#
            ),
        ),
        (
            "session_goal_set",
            format!(
                r#"{{"sessionID":{root},"input":{{"payload":{{"goal":"ship","maxNoProgress":null}}}}}}"#
            ),
        ),
        (
            "session_goal_set",
            format!(r#"{{"sessionID":{root},"input":{{"payload":{{"yolo":2}}}}}}"#),
        ),
        (
            "session_prompt",
            format!(r#"{{"sessionID":{root},"input":{{"payload":{{"text":"hi"}}}}}}"#),
        ),
        (
            "session_prompt",
            format!(r#"{{"sessionID":{root},"input":{{"payload":{{"id":"msg_","text":"hi"}}}}}}"#),
        ),
        (
            "session_prompt_generate",
            format!(
                r#"{{"sessionID":{root},"input":{{"payload":{{"mode":"start","intent":" \n\t ","memory":[]}}}}}}"#
            ),
        ),
        (
            "incident_guidance",
            format!(
                r#"{{"sessionID":{root},"input":{{"query":{{"provider":"p","model":"m","location":{{"directory":"/"}}}}}}}}"#
            ),
        ),
        (
            "session_permission_reply",
            format!(
                r#"{{"sessionID":{root},"input":{{"params":{{"requestID":"per_"}},"payload":{{"reply":"once"}}}}}}"#
            ),
        ),
        (
            "session_guardrail_reply",
            format!(
                r#"{{"sessionID":{root},"input":{{"params":{{"requestID":"grq_"}},"payload":{{"reply":"once"}}}}}}"#
            ),
        ),
        (
            "session_permission_reply",
            format!(
                r#"{{"sessionID":{root},"input":{{"params":{{"requestID":"per_x"}},"payload":{{"reply":"PERMISSION_REPLY_ONCE"}}}}}}"#
            ),
        ),
        (
            "session_skill",
            format!(r#"{{"sessionID":{root},"input":{{"payload":{{"skill":"   "}}}}}}"#),
        ),
        (
            "session_create",
            r#"{"input":{"payload":{"agent":"build"}}}"#.to_owned(),
        ),
        (
            "session_skill",
            format!(r#"{{"sessionID":{root},"input":{{"payload":{{"skill":"\ufeff\u3000"}}}}}}"#),
        ),
        (
            "session_form_reply",
            format!(
                r#"{{"sessionID":{root},"input":{{"params":{{"formID":"frm_{}"}},"payload":{{"answer":{{}}}}}}}}"#,
                "a".repeat(61)
            ),
        ),
        (
            "session_form_reply",
            format!(
                r#"{{"sessionID":{root},"input":{{"params":{{"formID":"qst_abc"}},"payload":{{"answer":{{}}}}}}}}"#
            ),
        ),
        (
            "session_log",
            format!(r#"{{"sessionID":{root},"input":{{"query":{{"follow":true}}}}}}"#),
        ),
        ("session_get", r#"{"sessionID":"not a session"}"#.to_owned()),
        (
            "session_status",
            r#"{"sessionID":"ses_unexpected"}"#.to_owned(),
        ),
    ] {
        let (_, result) = call(&cx, tool, &arguments).await;
        assert!(
            invalid_arguments(&result),
            "{tool} {arguments}: {}",
            stringify_json(&result)
        );
    }
    let (_, form) = call(
        &cx,
        "session_form_reply",
        &format!(r#"{{"sessionID":{root},"input":{{"params":{{"formID":"frm_{}"}},"payload":{{"answer":{{}}}}}}}}"#, "a".repeat(60)),
    )
    .await;
    assert!(failed(&form));
    assert!(!invalid_arguments(&form), "{}", stringify_json(&form));
    let (_, guidance) = call(
        &cx,
        "incident_guidance",
        &format!(
            r#"{{"sessionID":{root},"input":{{"query":{{"provider":"fixture","model":"code"}}}}}}"#
        ),
    )
    .await;
    assert!(
        !invalid_arguments(&guidance),
        "{}",
        stringify_json(&guidance)
    );
    let (_, goal) = call(
        &cx,
        "session_goal_set",
        &format!(
            r#"{{"sessionID":{root},"input":{{"payload":{{"goal":"ship","maxNoProgress":1}}}}}}"#
        ),
    )
    .await;
    assert!(!invalid_arguments(&goal), "{}", stringify_json(&goal));
    assert!(
        !failed(&goal) || string(&goal, &["structuredContent", "error", "type"]).is_some(),
        "{}",
        stringify_json(&goal)
    );
    let (_, stop) = call(
        &cx,
        "session_goal_stop",
        &format!(r#"{{"sessionID":{root}}}"#),
    )
    .await;
    assert!(!invalid_arguments(&stop), "{}", stringify_json(&stop));
    fixture.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn session_log_collects_the_bounded_history_to_its_synced_end() {
    let fixture = Fixture::new().await;
    let cx = context(&fixture, standard().unwrap(), &fixture.path);
    let (_, result) = call(
        &cx,
        "session_log",
        &format!(r#"{{"sessionID":{}}}"#, quoted(&fixture.root)),
    )
    .await;
    assert!(!failed(&result), "{}", stringify_json(&result));
    let Some(JsonValue::Array(items)) = at(&result, &["structuredContent", "items"]) else {
        panic!("{}", stringify_json(&result))
    };
    assert!(items.len() >= 2);
    let last = items.last().unwrap();
    assert_eq!(
        string(last, &["sourceEpoch"]).as_deref(),
        Some("derived-source")
    );
    assert_eq!(string(last, &["aggregateID"]), Some(fixture.root.clone()));
    assert!(
        items[..items.len() - 1]
            .iter()
            .all(|item| at(item, &["aggregateID"]).is_none() && at(item, &["id"]).is_some())
    );
    fixture.close().await;
}

fn asset_dispatcher(length: usize) -> Dispatcher {
    let mut dispatcher = Dispatcher::new(OPERATIONS.clone());
    dispatcher
        .handle_asset(
            "session.attachment.read",
            move |_, _: v5::SessionAttachmentReadRequest| async move {
                ycoding_protocol::Asset::new(
                    v5::SessionAttachmentReadResult {
                        data: v5::SessionAssetMetadata {
                            mime: ycoding_protocol::encode_lossless(
                                &"image/png".encode_utf16().collect::<Vec<_>>(),
                            ),
                            bytes: length as u64,
                        },
                    },
                    (0..length).map(|index| (index % 251) as u8).collect(),
                )
                .map_err(|error| Failure::Invalid(error.to_string()))
            },
        )
        .unwrap();
    dispatcher
}

fn base64(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    bytes
        .chunks(3)
        .flat_map(|chunk| {
            let value = (u32::from(chunk[0]) << 16)
                | (u32::from(*chunk.get(1).unwrap_or(&0)) << 8)
                | u32::from(*chunk.get(2).unwrap_or(&0));
            (0..4).map(move |index| {
                if index > chunk.len() {
                    '='
                } else {
                    TABLE[(value >> (18 - index * 6) & 63) as usize] as char
                }
            })
        })
        .collect()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn attachments_return_base64_within_the_result_bound_and_fail_beyond_it() {
    let fixture = Fixture::new().await;
    let arguments = format!(
        r#"{{"sessionID":{},"input":{{"params":{{"digest":"{}"}}}}}}"#,
        quoted(&fixture.root),
        "a".repeat(64)
    );
    let small = context(&fixture, asset_dispatcher(1_000), &fixture.path);
    let (_, result) = call(&small, "session_attachment_read", &arguments).await;
    assert!(!failed(&result), "{}", stringify_json(&result));
    let expected = (0..1_000)
        .map(|index| (index % 251) as u8)
        .collect::<Vec<_>>();
    assert_eq!(
        string(&result, &["structuredContent", "base64"]),
        Some(base64(&expected))
    );
    assert_eq!(
        string(&result, &["structuredContent", "data", "mime"]).as_deref(),
        Some("image/png")
    );
    let large = context(&fixture, asset_dispatcher(1_700_000), &fixture.path);
    let (response, result) = call(&large, "session_attachment_read", &arguments).await;
    assert!(failed(&result));
    assert_eq!(
        string(&result, &["structuredContent", "error", "code"]).as_deref(),
        Some("message_too_large")
    );
    assert!(response.body.len() < 4_096);
    fixture.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_mutation_whose_local_dispatch_aborts_reports_an_unknown_outcome() {
    let fixture = Fixture::new().await;
    let mut dispatcher = Dispatcher::new(OPERATIONS.clone());
    dispatcher
        .handle(
            "session.interrupt",
            |_, _: v5::SessionInterruptRequest| async move {
                if true {
                    panic!("synthetic dispatch abort");
                }
                Ok(v5::SessionInterruptResult { data: v5::Empty {} })
            },
        )
        .unwrap();
    let cx = context(&fixture, dispatcher, &fixture.path);
    let (response, result) = call(
        &cx,
        "session_interrupt",
        &format!(r#"{{"sessionID":{}}}"#, quoted(&fixture.root)),
    )
    .await;
    assert!(response.unknown);
    assert_eq!(
        string(&result, &["structuredContent", "error", "code"]).as_deref(),
        Some("outcome_unknown")
    );
    fixture.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_unauthenticated_peer_dispatches_nothing() {
    let fixture = Fixture::new().await;
    let mut cx = context(&fixture, standard().unwrap(), &fixture.path);
    cx.peer = expired_peer();
    let (response, result) = call(
        &cx,
        "session_get",
        &format!(r#"{{"sessionID":{}}}"#, quoted(&fixture.root)),
    )
    .await;
    assert!(failed(&result));
    assert!(!response.unknown);
    assert_eq!(
        string(&result, &["structuredContent", "error", "code"]).as_deref(),
        Some("unauthorized")
    );
    let id = fresh_session("mcpunauth");
    let project = fixture.path.join("unauthorized");
    std::fs::create_dir_all(&project).unwrap();
    let (_, created) = call(
        &cx,
        "session_create_in_directory",
        &directory_arguments(&id, project.to_str().unwrap()),
    )
    .await;
    assert!(failed(&created));
    assert!(session_record(&id).is_none());
    fixture.close().await;
}

fn directory_arguments(id: &str, directory: &str) -> String {
    format!(
        r#"{{"input":{{"id":{},"directory":{},"agent":"build"}}}}"#,
        quoted(id),
        quoted(directory)
    )
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn directory_creation_accepts_only_existing_strict_descendants_of_home() {
    let fixture = Fixture::new().await;
    let home = fixture.path.join("home");
    let project = home.join("project");
    let outside = fixture.path.join("outside");
    std::fs::create_dir_all(&project).unwrap();
    std::fs::create_dir_all(&outside).unwrap();
    #[cfg(unix)]
    std::os::unix::fs::symlink(&outside, home.join("escape")).unwrap();
    let cx = context(&fixture, standard().unwrap(), &home);
    let id = fresh_session("mcpdir");
    let (_, created) = call(
        &cx,
        "session_create_in_directory",
        &directory_arguments(&id, project.to_str().unwrap()),
    )
    .await;
    assert!(!failed(&created), "{}", stringify_json(&created));
    let record = session_record(&id).unwrap();
    assert_eq!(record.parent_id, None);
    assert_eq!(
        record.location.directory.as_lossless().as_str(),
        std::fs::canonicalize(&project).unwrap().to_str()
    );
    let (_, retried) = call(
        &cx,
        "session_create_in_directory",
        &directory_arguments(&id, project.to_str().unwrap()),
    )
    .await;
    assert!(!failed(&retried), "{}", stringify_json(&retried));
    assert_eq!(
        string(&retried, &["structuredContent", "data", "id"]),
        Some(id.clone())
    );
    let sibling = home.join("sibling");
    std::fs::create_dir_all(&sibling).unwrap();
    let (_, conflict) = call(
        &cx,
        "session_create_in_directory",
        &directory_arguments(&id, sibling.to_str().unwrap()),
    )
    .await;
    assert!(failed(&conflict));

    let candidates: Vec<PathBuf> = vec![
        home.clone(),
        home.join("missing"),
        outside.clone(),
        home.join("project/../.."),
        #[cfg(unix)]
        home.join("escape"),
    ];
    for candidate in candidates {
        let id = fresh_session("mcpreject");
        let (_, rejected) = call(
            &cx,
            "session_create_in_directory",
            &directory_arguments(&id, candidate.to_str().unwrap()),
        )
        .await;
        assert!(failed(&rejected), "{}", candidate.display());
        assert!(session_record(&id).is_none(), "{}", candidate.display());
    }
    for directory in ["project", "~/project"] {
        let id = fresh_session("mcprelative");
        let (_, rejected) = call(
            &cx,
            "session_create_in_directory",
            &directory_arguments(&id, directory),
        )
        .await;
        assert!(invalid_arguments(&rejected), "{directory}");
        assert!(session_record(&id).is_none());
    }
    assert!(!home.join("missing").exists());
    let (_, unknown) = call(
        &cx,
        "session_create_in_directory",
        &format!(
            r#"{{"input":{{"id":{},"directory":{},"location":"/"}}}}"#,
            quoted(&fresh_session("mcpfield")),
            quoted(project.to_str().unwrap())
        ),
    )
    .await;
    assert!(invalid_arguments(&unknown));
    fixture.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn remote_session_creation_keeps_the_advertised_workspace_rule() {
    let fixture = Fixture::new().await;
    let cx = context(&fixture, standard().unwrap(), &fixture.path);
    let id = fresh_session("mcpws");
    let (_, rejected) = call(
        &cx,
        "session_create",
        &format!(
            r#"{{"input":{{"payload":{{"id":{},"location":{{"directory":{}}}}}}}}}"#,
            quoted(&id),
            quoted(&fixture.directory)
        ),
    )
    .await;
    assert!(failed(&rejected));
    assert!(session_record(&id).is_none());
    fixture.close().await;
}

const NESTING_CHILD: &str = "YCODING_MCP_NESTING_CHILD";
const CARRIER_UNITS: usize = 32_768;

fn carried(body: &str) -> &str {
    assert!(
        body.encode_utf16().count() <= CARRIER_UNITS,
        "body exceeds the relay MCP carrier bound"
    );
    body
}

fn isolated(test: &str) {
    let output = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--exact", test, "--nocapture", "--test-threads", "1"])
        .env(NESTING_CHILD, "1")
        .output()
        .unwrap();
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(
        output.status.success() && stdout.contains("nesting-child-complete"),
        "isolated {test} ended with {:?}\n{stdout}\n{}",
        output.status,
        String::from_utf8_lossy(&output.stderr)
    );
}

fn nested(depth: usize) -> String {
    format!("{}{}", "[".repeat(depth), "]".repeat(depth))
}

fn discover_with(pad: &str) -> String {
    format!(
        r#"{{"jsonrpc":"2.0","id":3,"method":"server/discover","params":{{"_meta":{},"pad":{pad}}}}}"#,
        meta()
    )
}

#[test]
fn lane_survives_a_deeply_nested_body_in_an_isolated_process() {
    if std::env::var_os(NESTING_CHILD).is_none() {
        return isolated("lane_survives_a_deeply_nested_body_in_an_isolated_process");
    }
    let deep = call_body(
        "session_prompt",
        &format!(r#"{{"sessionID":"ses_deep","input":{}}}"#, nested(16_000)),
    );
    assert_eq!(mcp::lane(&carried(&deep).into()), None);
    let quoted = call_body(
        "session_prompt",
        &format!(
            r#"{{"sessionID":"ses_text","input":{{"payload":{{"id":"msg_text","text":"{}\"\\{{[\ud800"}}}}}}"#,
            "[{".repeat(5_000)
        ),
    );
    assert_eq!(
        mcp::lane(&carried(&quoted).into()),
        Some(Lane::Session("ses_text".into()))
    );
    println!("nesting-child-complete");
}

#[test]
fn handle_rejects_a_deeply_nested_body_without_dispatch_in_an_isolated_process() {
    if std::env::var_os(NESTING_CHILD).is_none() {
        return isolated(
            "handle_rejects_a_deeply_nested_body_without_dispatch_in_an_isolated_process",
        );
    }
    tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .unwrap()
        .block_on(async {
            let fixture = Fixture::new().await;
            let cx = context(&fixture, standard().unwrap(), &fixture.path);
            let post = |body: String, method: &'static str, name: Option<&'static str>| {
                let cx = &cx;
                async move {
                    mcp::handle(
                        cx,
                        Request {
                            body: body.as_str().into(),
                            headers: headers(method, name),
                        },
                    )
                    .await
                }
            };
            for (body, method, name) in [
                (discover_with(&nested(16_000)), "server/discover", None),
                (format!(
                    r#"{{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{{"name":"session_get","arguments":{{"sessionID":{},"input":{}}},"_meta":{}}}}}"#,
                    quoted(&fixture.root),
                    nested(16_000),
                    meta()
                ), "tools/call", Some("session_get")),
            ] {
                let response = post(carried(&body).to_owned(), method, name).await;
                assert_eq!(response.status, 400, "{}", response.body);
                assert!(!response.unknown);
                let parsed = parse_json(&response.body).unwrap();
                assert!(at(&parsed, &["result"]).is_none());
                assert_eq!(at(&parsed, &["id"]), Some(&JsonValue::Null));
            }
            let text = discover_with(&format!(
                r#""{}\"\\{{[\ud800 ]""#,
                "[{".repeat(5_000)
            ));
            let response = post(carried(&text).to_owned(), "server/discover", None).await;
            assert_eq!(response.status, 200, "{}", response.body);
            let moderate = discover_with(&nested(64));
            let response = post(moderate, "server/discover", None).await;
            assert_eq!(response.status, 200, "{}", response.body);
            fixture.close().await;
        });
    println!("nesting-child-complete");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn nesting_bound_accepts_256_levels_and_rejects_257_before_dispatch() {
    assert_eq!(mcp::NESTING_DEPTH, 256);
    let fixture = Fixture::new().await;
    let cx = context(&fixture, standard().unwrap(), &fixture.path);
    for (pad, status) in [(254, 200), (255, 400)] {
        let body = discover_with(&nested(pad));
        let response = mcp::handle(
            &cx,
            Request {
                body: carried(&body).into(),
                headers: headers("server/discover", None),
            },
        )
        .await;
        assert_eq!(response.status, status, "{pad}: {}", response.body);
        if status == 400 {
            let parsed = parse_json(&response.body).unwrap();
            assert_eq!(
                at(&parsed, &["error", "code"]),
                Some(&JsonValue::Number(-32600.0))
            );
            assert_eq!(at(&parsed, &["id"]), Some(&JsonValue::Null));
        }
    }
    let prompt = |pad: usize| {
        call_body(
            "session_prompt",
            &format!(r#"{{"sessionID":"ses_bound","input":{}}}"#, nested(pad)),
        )
    };
    assert_eq!(
        mcp::lane(&carried(&prompt(253)).into()),
        Some(Lane::Session("ses_bound".into()))
    );
    assert_eq!(mcp::lane(&carried(&prompt(254)).into()), None);
    fixture.close().await;
}

async fn local<Q: prost::Message, R: prost::Message + prost::Name + Default>(
    cx: &Context,
    name: &str,
    session: &str,
    query: Q,
) -> R {
    let descriptor = OPERATIONS
        .iter()
        .find(|descriptor| descriptor.diagnostic_name == name)
        .unwrap();
    let settled = cx
        .dispatcher
        .invoke(
            cx.environment.clone(),
            "mcp-form-local".into(),
            v5::Request {
                request_id: format!("local-{name}"),
                operation_id: descriptor.operation_id,
                scope: v5::Scope {
                    target: Some(v5::scope::Target::Form(session.into())),
                },
                payload: query.encode_to_vec(),
            },
        )
        .await;
    let Some(ycoding_runtime::Settled::Result(result)) = settled else {
        panic!("{name} did not settle inline")
    };
    let Some(v5::result::Outcome::Success(payload)) = result.outcome else {
        panic!("{name} failed: {:?}", result.outcome)
    };
    assert_eq!(payload.type_name, R::full_name());
    ycoding_protocol::decode_strict(&payload.payload).unwrap()
}

fn lossless(value: &str) -> v5::LosslessString {
    ycoding_protocol::encode_lossless(&value.encode_utf16().collect::<Vec<_>>())
}

async fn form_state(cx: &Context, session: &str, form: &str) -> v5::FormState {
    local::<_, v5::SessionFormStateResult>(
        cx,
        "session.form.state",
        session,
        v5::SessionFormStateRequest {
            params: v5::SessionFormStateRequestParams {
                session_id: lossless(session),
                form_id: lossless(form),
            },
        },
    )
    .await
    .data
}

fn answered_name(state: &v5::FormState) -> Option<String> {
    let Some(v5::form_state::Kind::Value2(answered)) = &state.kind else {
        return None;
    };
    answered.answer.entries.iter().find_map(|entry| {
        let Some(v5::form_value::Kind::Value1(value)) = &entry.value.kind else {
            return None;
        };
        (ycoding_protocol::decode_lossless(&entry.key, 64).unwrap()
            == "name".encode_utf16().collect::<Vec<_>>())
        .then(|| {
            String::from_utf16(&ycoding_protocol::decode_lossless(value, 64).unwrap()).unwrap()
        })
    })
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn native_forms_list_reply_once_and_stay_owned_by_their_session() {
    let fixture = Fixture::new().await;
    let cx = context(&fixture, standard().unwrap(), &fixture.path);
    let created = local::<_, v5::SessionFormCreateResult>(
        &cx,
        "session.form.create",
        &fixture.root,
        v5::SessionFormCreateRequest {
            params: v5::SessionFormCreateRequestParams {
                session_id: lossless(&fixture.root),
            },
            payload: v5::FormCreatePayload {
                id: None,
                title: lossless("Profile"),
                metadata: None,
                fields: v5::FormFields {
                    items: vec![v5::FormField {
                        kind: Some(v5::form_field::Kind::Value1(v5::FormStringField {
                            key: lossless("name"),
                            title: Some(lossless("Name")),
                            description: None,
                            required: Some(true),
                            when: None,
                            r#type: 1,
                            format: None,
                            min_length: Some(1),
                            max_length: Some(40),
                            pattern: None,
                            placeholder: None,
                            default: None,
                            options: None,
                            custom: None,
                        })),
                    }],
                },
            },
        },
    )
    .await;
    let form =
        String::from_utf16(&ycoding_protocol::decode_lossless(&created.data.id, 64).unwrap())
            .unwrap();
    assert!(form.starts_with("frm_"), "{form}");
    let root = quoted(&fixture.root);
    let other = quoted(&fixture.other);
    let reply = |session: &str, name: &str| {
        format!(
            r#"{{"sessionID":{session},"input":{{"params":{{"formID":{}}},"payload":{{"answer":{{"name":{}}}}}}}}}"#,
            quoted(&form),
            quoted(name)
        )
    };

    let (_, listed) = call(
        &cx,
        "session_form_list",
        &format!(r#"{{"sessionID":{root}}}"#),
    )
    .await;
    assert!(!failed(&listed), "{}", stringify_json(&listed));
    let Some(JsonValue::Array(items)) = at(&listed, &["structuredContent", "data"]) else {
        panic!("{}", stringify_json(&listed))
    };
    assert_eq!(
        items
            .iter()
            .filter_map(|item| string(item, &["id"]))
            .collect::<Vec<_>>(),
        vec![form.clone()]
    );
    let (_, foreign) = call(
        &cx,
        "session_form_list",
        &format!(r#"{{"sessionID":{other}}}"#),
    )
    .await;
    assert_eq!(
        at(&foreign, &["structuredContent", "data"]),
        Some(&JsonValue::Array(vec![]))
    );

    let (_, mismatched) = call(&cx, "session_form_reply", &reply(&other, "Mallory")).await;
    assert!(failed(&mismatched));
    assert_eq!(
        string(&mismatched, &["structuredContent", "error", "type"]).as_deref(),
        Some("ycoding.v5.FormNotFoundError"),
        "{}",
        stringify_json(&mismatched)
    );
    let (_, cancelled) = call(
        &cx,
        "session_form_cancel",
        &format!(
            r#"{{"sessionID":{other},"input":{{"params":{{"formID":{}}}}}}}"#,
            quoted(&form)
        ),
    )
    .await;
    assert!(failed(&cancelled));
    assert!(matches!(
        form_state(&cx, &fixture.root, &form).await.kind,
        Some(v5::form_state::Kind::Value1(_))
    ));

    let (_, answered) = call(&cx, "session_form_reply", &reply(&root, "Ada")).await;
    assert!(!failed(&answered), "{}", stringify_json(&answered));
    let settled = form_state(&cx, &fixture.root, &form).await;
    assert_eq!(answered_name(&settled).as_deref(), Some("Ada"));

    let (_, replayed) = call(&cx, "session_form_reply", &reply(&root, "Grace")).await;
    assert!(failed(&replayed));
    assert_eq!(
        string(&replayed, &["structuredContent", "error", "type"]).as_deref(),
        Some("ycoding.v5.FormAlreadySettledError"),
        "{}",
        stringify_json(&replayed)
    );
    assert_eq!(form_state(&cx, &fixture.root, &form).await, settled);
    let (_, relisted) = call(
        &cx,
        "session_form_list",
        &format!(r#"{{"sessionID":{root}}}"#),
    )
    .await;
    assert_eq!(
        at(&relisted, &["structuredContent", "data"]),
        Some(&JsonValue::Array(vec![]))
    );
    fixture.close().await;
}
