mod support;

use prost::{Message, Name};
use support::*;
use ycoding_core::ycoding_schema::{ObjectEncoder, model, session};
use ycoding_core::ycoding_store::session::{Document, NewEvent, Task, TaskTable};
use ycoding_protocol::{decode_strict, v5};
use ycoding_runtime::{LocalAuth, standard};

fn string(value: &str) -> v5::Value {
    v5::Value {
        kind: Some(v5::value::Kind::String(text(value))),
    }
}

fn put(session: &str, key: &str, value: v5::Value) -> Vec<u8> {
    v5::SessionInstructionsEntryPutRequest {
        params: v5::SessionInstructionsEntryPutRequestParams {
            session_id: text(session),
            key: text(key),
        },
        payload: v5::SessionInstructionsEntryPutRequestPayload { value },
    }
    .encode_to_vec()
}

fn remove(session: &str, key: &str) -> Vec<u8> {
    v5::SessionInstructionsEntryRemoveRequest {
        params: v5::SessionInstructionsEntryRemoveRequestParams {
            session_id: text(session),
            key: text(key),
        },
    }
    .encode_to_vec()
}

fn list(session: &str) -> Vec<u8> {
    v5::SessionInstructionsEntryListRequest {
        params: v5::SessionInstructionsEntryListRequestParams {
            session_id: text(session),
        },
    }
    .encode_to_vec()
}

fn captured(session: &str, after: Option<u64>, limit: Option<u64>) -> Vec<u8> {
    v5::SessionCapturedInputsRequest {
        params: v5::SessionCapturedInputsRequestParams {
            session_id: text(session),
        },
        query: v5::SessionCapturedInputsRequestQuery { after, limit },
    }
    .encode_to_vec()
}

async fn entries(client: &mut Client, session: &str) -> Vec<v5::InstructionEntryInfo> {
    success::<v5::SessionInstructionsEntryListResult>(
        client
            .call(
                "session.instructions.entry.list",
                session_scope(session),
                list(session),
            )
            .await,
    )
    .data
    .items
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn instruction_entries_preserve_json_sort_keys_isolate_sessions_and_restore_removed_values() {
    let id = "ses_local_entries";
    insert_session(id, "/project", None).await;
    insert_session("ses_local_entries_other", "/project", None).await;
    let server = start(services(LocalAuth::disabled(), true), standard().unwrap()).await;
    let mut client = Client::open(server.address(), &[]).await.unwrap();
    assert!(entries(&mut client, id).await.is_empty());
    let value = v5::Value {
        kind: Some(v5::value::Kind::Object(v5::ValueObject {
            entries: vec![v5::ValueEntry {
                key: text("data"),
                value: v5::Value {
                    kind: Some(v5::value::Kind::List(v5::ValueList {
                        items: vec![
                            v5::Value {
                                kind: Some(v5::value::Kind::Null(v5::Empty {})),
                            },
                            v5::Value {
                                kind: Some(v5::value::Kind::Boolean(true)),
                            },
                            v5::Value {
                                kind: Some(v5::value::Kind::Number(2.5)),
                            },
                            string("é\n"),
                        ],
                    })),
                },
            }],
        })),
    };
    for (key, value) in [("z-last", value.clone()), ("0.first_key", string("first"))] {
        success::<v5::SessionInstructionsEntryPutResult>(
            client
                .call(
                    "session.instructions.entry.put",
                    session_scope(id),
                    put(id, key, value),
                )
                .await,
        );
    }
    let current = entries(&mut client, id).await;
    assert_eq!(
        current
            .iter()
            .map(|entry| units(&entry.key))
            .collect::<Vec<_>>(),
        ["0.first_key", "z-last"]
    );
    assert_eq!(current[1].value, value);
    assert!(
        entries(&mut client, "ses_local_entries_other")
            .await
            .is_empty()
    );
    let null = v5::Value {
        kind: Some(v5::value::Kind::Null(v5::Empty {})),
    };
    for _ in 0..2 {
        success::<v5::SessionInstructionsEntryPutResult>(
            client
                .call(
                    "session.instructions.entry.put",
                    session_scope(id),
                    put(id, "z-last", null.clone()),
                )
                .await,
        );
    }
    assert_eq!(entries(&mut client, id).await[1].value, null);
    for key in ["absent", "z-last", "z-last"] {
        success::<v5::SessionInstructionsEntryRemoveResult>(
            client
                .call(
                    "session.instructions.entry.remove",
                    session_scope(id),
                    remove(id, key),
                )
                .await,
        );
    }
    assert_eq!(entries(&mut client, id).await.len(), 1);
    success::<v5::SessionInstructionsEntryPutResult>(
        client
            .call(
                "session.instructions.entry.put",
                session_scope(id),
                put(id, "z-last", value.clone()),
            )
            .await,
    );
    assert_eq!(entries(&mut client, id).await[1].value, value);
    assert!(
        world()
            .core
            .sessions
            .log(&session::Id::new(id).unwrap(), None, 20)
            .unwrap()
            .events
            .is_empty()
    );
    server.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn instruction_key_and_json_validation_rejects_without_mutating_entries() {
    let id = "ses_local_invalid_entries";
    insert_session(id, "/project", None).await;
    let server = start(services(LocalAuth::disabled(), true), standard().unwrap()).await;
    let mut client = Client::open(server.address(), &[]).await.unwrap();
    for key in [".leading", "_leading", "-leading", "", "Upper", "a/b", "é"] {
        for (operation, payload) in [
            (
                "session.instructions.entry.put",
                put(id, key, string("invalid")),
            ),
            ("session.instructions.entry.remove", remove(id, key)),
        ] {
            let error = rejected(client.call(operation, session_scope(id), payload).await);
            assert_eq!(
                error.type_name,
                v5::InvalidRequestError::full_name(),
                "{operation} {key}"
            );
        }
    }
    let error = rejected(
        client
            .call(
                "session.instructions.entry.put",
                session_scope(id),
                put(
                    id,
                    "bytes",
                    v5::Value {
                        kind: Some(v5::value::Kind::Bytes(vec![1, 2])),
                    },
                ),
            )
            .await,
    );
    assert_eq!(error.type_name, v5::InvalidRequestError::full_name());
    assert!(entries(&mut client, id).await.is_empty());
    assert!(
        world()
            .core
            .sessions
            .log(&session::Id::new(id).unwrap(), None, 20)
            .unwrap()
            .events
            .is_empty()
    );
    server.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn instruction_size_limit_counts_serialized_utf8_and_preserves_prior_value_on_failure() {
    let id = "ses_local_entry_limit";
    insert_session(id, "/project", None).await;
    let server = start(services(LocalAuth::disabled(), true), standard().unwrap()).await;
    let mut client = Client::open(server.address(), &[]).await.unwrap();
    let value = string(&"é".repeat(4095));
    success::<v5::SessionInstructionsEntryPutResult>(
        client
            .call(
                "session.instructions.entry.put",
                session_scope(id),
                put(id, "value", value.clone()),
            )
            .await,
    );
    let error = rejected(
        client
            .call(
                "session.instructions.entry.put",
                session_scope(id),
                put(id, "value", string(&"é".repeat(4096))),
            )
            .await,
    );
    assert_eq!(
        error.type_name,
        v5::InstructionEntryValueTooLargeError::full_name()
    );
    let error = v5::InstructionEntryValueTooLargeError::decode(error.payload.as_slice()).unwrap();
    assert_eq!((error.actual_bytes, error.max_bytes), (8194, 8192));
    assert_eq!(
        units(&error.message),
        "Instruction entry value is 8194 bytes; the limit is 8192 bytes"
    );
    assert_eq!(entries(&mut client, id).await[0].value, value);
    server.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn all_six_operations_report_unknown_sessions_with_the_ts_error_shape() {
    let id = "ses_local_missing";
    let server = start(services(LocalAuth::disabled(), true), standard().unwrap()).await;
    let mut client = Client::open(server.address(), &[]).await.unwrap();
    for (operation, payload) in [
        ("session.capturedInputs", captured(id, None, None)),
        (
            "session.compaction.list",
            v5::SessionCompactionListRequest {
                params: v5::SessionCompactionListRequestParams {
                    session_id: text(id),
                },
            }
            .encode_to_vec(),
        ),
        (
            "session.fileChange.list",
            v5::SessionFileChangeListRequest {
                params: v5::SessionFileChangeListRequestParams {
                    session_id: text(id),
                },
            }
            .encode_to_vec(),
        ),
        ("session.instructions.entry.list", list(id)),
        (
            "session.instructions.entry.put",
            put(id, "context", string("value")),
        ),
        ("session.instructions.entry.remove", remove(id, "context")),
    ] {
        let error = rejected(client.call(operation, session_scope(id), payload).await);
        assert_eq!(
            error.type_name,
            v5::SessionNotFoundError::full_name(),
            "{operation}"
        );
        let error = v5::SessionNotFoundError::decode(error.payload.as_slice()).unwrap();
        assert_eq!(units(&error.session_id), id);
        assert_eq!(units(&error.message), format!("Session not found: {id}"));
    }
    server.shutdown().await.unwrap();
}

#[test]
fn captured_page_wire_contract_rejects_invalid_limits_and_unsafe_cursors() {
    for (after, limit) in [
        (None, Some(0)),
        (None, Some(201)),
        (Some(9_007_199_254_740_992), None),
    ] {
        assert!(
            decode_strict::<v5::SessionCapturedInputsRequest>(&captured("ses_get", after, limit))
                .is_err()
        );
    }
    for (after, limit) in [
        (None, None),
        (Some(0), Some(1)),
        (Some(9_007_199_254_740_991), Some(200)),
    ] {
        assert!(
            decode_strict::<v5::SessionCapturedInputsRequest>(&captured("ses_get", after, limit))
                .is_ok()
        );
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn captured_inputs_empty_and_decode_failures_preserve_ts_settlement_without_private_payloads()
{
    let id = "ses_local_capture_errors";
    insert_session(id, "/project", None).await;
    let server = start(services(LocalAuth::disabled(), true), standard().unwrap()).await;
    let mut client = Client::open(server.address(), &[]).await.unwrap();
    let empty: v5::SessionCapturedInputsResult = success(
        client
            .call(
                "session.capturedInputs",
                session_scope(id),
                captured(id, None, None),
            )
            .await,
    );
    assert!(empty.data.data.items.is_empty());
    assert_eq!(empty.data.next, None);
    insert_message(id, "msg_local_bad_capture", "assistant", 0, r#"{"content":[{"type":"tool","name":"edit","state":{"status":42,"content":"private output","input":"private input"}}]}"#).await;
    for _ in 0..2 {
        let error = rejected(
            client
                .call(
                    "session.capturedInputs",
                    session_scope(id),
                    captured(id, None, None),
                )
                .await,
        );
        assert_eq!(error.type_name, v5::UnknownError::full_name());
        let error = v5::UnknownError::decode(error.payload.as_slice()).unwrap();
        assert_eq!(
            units(&error.message),
            "Unexpected server error. Check server logs for details."
        );
        let reference = units(
            error
                .r#ref
                .as_ref()
                .expect("decode failure has a correlation reference"),
        );
        assert!(reference.starts_with("err_") && reference.len() == 12);
        assert!(reference[4..].bytes().all(|byte| byte.is_ascii_hexdigit()));
    }
    let past: v5::SessionCapturedInputsResult = success(
        client
            .call(
                "session.capturedInputs",
                session_scope(id),
                captured(id, Some(0), None),
            )
            .await,
    );
    assert!(past.data.data.items.is_empty());
    assert_eq!(past.data.next, None);
    server.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn file_changes_accumulate_latest_patch_and_include_only_completed_direct_children_in_path_order()
 {
    let id = "ses_local_file_root";
    for session in [
        id,
        "ses_local_file_done",
        "ses_local_file_running",
        "ses_local_file_failed",
        "ses_local_file_grandchild",
        "ses_local_file_other",
        "ses_local_file_empty",
        "ses_local_file_no_changes",
    ] {
        insert_session(session, "/project", None).await;
    }
    world()
        .store
        .submit(move |tx| {
            for (child, parent, state) in [
                ("ses_local_file_done", id, "completed"),
                ("ses_local_file_running", id, "running"),
                ("ses_local_file_failed", id, "failed"),
                (
                    "ses_local_file_grandchild",
                    "ses_local_file_done",
                    "completed",
                ),
                ("ses_local_file_other", "ses_local_file_empty", "completed"),
            ] {
                TaskTable::insert(
                    tx,
                    &Task {
                        session_id: child.into(),
                        parent_id: parent.into(),
                        parent_assistant_message_id: format!("msg_{child}").into(),
                        tool_call_id: child.into(),
                        input_id: format!("msg_input_{child}").into(),
                        description: "task".into(),
                        agent: "build".into(),
                        model: Document::from_domain(&model::Ref {
                            id: "model".into(),
                            provider_id: ycoding_core::ycoding_schema::provider::Id(
                                "openai".into(),
                            ),
                            variant: None,
                            profile: None,
                        })?,
                        prompt_digest: "digest".into(),
                        background: 1,
                        delivery: "queue".into(),
                        state: state.into(),
                        progress: None,
                        progress_time: None,
                        question_id: None,
                        question: None,
                        question_data: None,
                        question_time: None,
                        attempt_started: 0,
                        owner_pid: None,
                        owner_started: None,
                        revision: 1,
                        time_created: 1,
                        time_updated: 1,
                    },
                )?;
            }
            Ok(())
        })
        .unwrap()
        .await
        .unwrap();
    for (index, session, path, patch, additions, deletions) in [
        (0, id, "z.ts", "first", 2.0, 1.0),
        (1, id, "z.ts", "latest\r\n", 3.0, 4.0),
        (2, "ses_local_file_done", "a.ts", "child", 7.0, 0.0),
        (3, "ses_local_file_done", "z.ts", "duplicate", 1.0, 1.0),
        (4, "ses_local_file_running", "hidden", "excluded", 1.0, 0.0),
        (5, "ses_local_file_failed", "hidden", "excluded", 1.0, 0.0),
        (
            6,
            "ses_local_file_grandchild",
            "hidden",
            "excluded",
            1.0,
            0.0,
        ),
        (7, "ses_local_file_other", "hidden", "excluded", 1.0, 0.0),
        (8, id, "\u{10000}.ts", "astral", 1.0, 0.0),
        (9, id, "\u{e000}.ts", "bmp", 1.0, 0.0),
    ] {
        world()
            .core
            .sessions
            .publish(NewEvent {
                id: format!("evt_local_file_{index}").into(),
                aggregate_id: session.into(),
                created: index,
                type_: "session.file-change.recorded.1".into(),
                data: ObjectEncoder::new()
                    .field("sessionID", session)
                    .field(
                        "change",
                        &ObjectEncoder::new()
                            .field("path", path)
                            .field("patch", patch)
                            .field("additions", &additions)
                            .field("deletions", &deletions)
                            .finish(),
                    )
                    .finish(),
            })
            .await
            .unwrap();
    }
    let server = start(services(LocalAuth::disabled(), true), standard().unwrap()).await;
    let mut client = Client::open(server.address(), &[]).await.unwrap();
    let request = |id: &str| {
        v5::SessionFileChangeListRequest {
            params: v5::SessionFileChangeListRequestParams {
                session_id: text(id),
            },
        }
        .encode_to_vec()
    };
    let changes: v5::SessionFileChangeListResult = success(
        client
            .call("session.fileChange.list", session_scope(id), request(id))
            .await,
    );
    assert_eq!(
        changes
            .data
            .items
            .iter()
            .map(|change| (
                units(&change.path),
                units(&change.patch),
                change.additions,
                change.deletions
            ))
            .collect::<Vec<_>>(),
        [
            ("a.ts".into(), "child".into(), 7, 0),
            ("z.ts".into(), "duplicate".into(), 1, 1),
            ("z.ts".into(), "latest\r\n".into(), 5, 5),
            ("\u{e000}.ts".into(), "bmp".into(), 1, 0),
            ("\u{10000}.ts".into(), "astral".into(), 1, 0),
        ]
    );
    let child: v5::SessionFileChangeListResult = success(
        client
            .call(
                "session.fileChange.list",
                session_scope("ses_local_file_running"),
                request("ses_local_file_running"),
            )
            .await,
    );
    assert_eq!(child.data.items.len(), 1);
    let empty: v5::SessionFileChangeListResult = success(
        client
            .call(
                "session.fileChange.list",
                session_scope("ses_local_file_no_changes"),
                request("ses_local_file_no_changes"),
            )
            .await,
    );
    assert!(empty.data.items.is_empty());
    server.shutdown().await.unwrap();
}
