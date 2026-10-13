mod support;

use prost::Message;
use support::*;
use ycoding_protocol::v5;
use ycoding_runtime::{LocalAuth, standard};

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn existing_session_services_are_available_over_the_socket() {
    let server = start(services(LocalAuth::disabled(), true), standard().unwrap()).await;
    let mut client = Client::open(server.address(), &[]).await.unwrap();

    let context: v5::SessionContextResult = success(
        client
            .call(
                "session.context",
                session_scope("ses_rich"),
                v5::SessionContextRequest {
                    params: v5::SessionContextRequestParams {
                        session_id: text("ses_rich"),
                    },
                }
                .encode_to_vec(),
            )
            .await,
    );
    assert!(!context.data.items.is_empty());

    let completions: v5::SessionCompletionsResult = success(
        client
            .call(
                "session.completions",
                machine(),
                v5::SessionCompletionsRequest {
                    query: v5::SessionCompletionsRequestQuery {
                        after: None,
                        limit: None,
                    },
                }
                .encode_to_vec(),
            )
            .await,
    );
    assert!(completions.data.next.is_none());

    let list: v5::SessionInstructionsEntryListResult = success(
        client
            .call(
                "session.instructions.entry.list",
                session_scope("ses_rich"),
                v5::SessionInstructionsEntryListRequest {
                    params: v5::SessionInstructionsEntryListRequestParams {
                        session_id: text("ses_rich"),
                    },
                }
                .encode_to_vec(),
            )
            .await,
    );
    assert!(list.data.items.is_empty());

    let put = v5::SessionInstructionsEntryPutRequest {
        params: v5::SessionInstructionsEntryPutRequestParams {
            session_id: text("ses_rich"),
            key: text("socket-test"),
        },
        payload: v5::SessionInstructionsEntryPutRequestPayload {
            value: v5::Value {
                kind: Some(v5::value::Kind::String(text("stored"))),
            },
        },
    };
    success::<v5::SessionInstructionsEntryPutResult>(
        client
            .call(
                "session.instructions.entry.put",
                session_scope("ses_rich"),
                put.encode_to_vec(),
            )
            .await,
    );
    let list: v5::SessionInstructionsEntryListResult = success(
        client
            .call(
                "session.instructions.entry.list",
                session_scope("ses_rich"),
                v5::SessionInstructionsEntryListRequest {
                    params: v5::SessionInstructionsEntryListRequestParams {
                        session_id: text("ses_rich"),
                    },
                }
                .encode_to_vec(),
            )
            .await,
    );
    assert_eq!(list.data.items.len(), 1);
    assert_eq!(units(&list.data.items[0].key), "socket-test");

    success::<v5::SessionInstructionsEntryRemoveResult>(
        client
            .call(
                "session.instructions.entry.remove",
                session_scope("ses_rich"),
                v5::SessionInstructionsEntryRemoveRequest {
                    params: v5::SessionInstructionsEntryRemoveRequestParams {
                        session_id: text("ses_rich"),
                        key: text("socket-test"),
                    },
                }
                .encode_to_vec(),
            )
            .await,
    );
    let list: v5::SessionInstructionsEntryListResult = success(
        client
            .call(
                "session.instructions.entry.list",
                session_scope("ses_rich"),
                v5::SessionInstructionsEntryListRequest {
                    params: v5::SessionInstructionsEntryListRequestParams {
                        session_id: text("ses_rich"),
                    },
                }
                .encode_to_vec(),
            )
            .await,
    );
    assert!(list.data.items.is_empty());

    success::<v5::SessionWaitResult>(
        client
            .call(
                "session.wait",
                session_scope("ses_rich"),
                v5::SessionWaitRequest {
                    params: v5::SessionWaitRequestParams {
                        session_id: text("ses_rich"),
                    },
                }
                .encode_to_vec(),
            )
            .await,
    );

    success::<v5::SessionBackgroundResult>(
        client
            .call(
                "session.background",
                session_scope("ses_rich"),
                v5::SessionBackgroundRequest {
                    params: v5::SessionBackgroundRequestParams {
                        session_id: text("ses_rich"),
                    },
                }
                .encode_to_vec(),
            )
            .await,
    );

    server.shutdown().await.unwrap();
}
