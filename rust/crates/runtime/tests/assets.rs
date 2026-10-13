mod support;
use prost::Message;
use support::*;
use ycoding_protocol::{Asset, connection::Outcome, v5};
use ycoding_runtime::Failure;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn typed_asset_registration_delivers_metadata_and_exact_raw_bytes_including_empty_body() {
    let mut dispatcher = ycoding_runtime::Dispatcher::new(ycoding_protocol::OPERATIONS.clone());
    dispatcher
        .handle_asset::<v5::FsReadRequest, v5::FsReadResult, _, _>(
            "fs.read",
            |_, request| async move {
                let data = if units(&request.params.path) == "empty" {
                    Vec::new()
                } else {
                    vec![255; 65537]
                };
                Asset::new(
                    v5::FsReadResult {
                        data: v5::PlatformAssetMetadata {
                            mime: text("application/octet-stream"),
                            byte_count: data.len() as u64,
                        },
                    },
                    data,
                )
                .map_err(|error| Failure::Invalid(error.to_string()))
            },
        )
        .unwrap();
    let server = start(
        services(ycoding_runtime::LocalAuth::disabled(), false),
        dispatcher,
    )
    .await;
    let mut client = Client::open(server.address(), &[]).await.unwrap();
    for (path, length) in [("empty", 0), ("bytes", 65537)] {
        let request = v5::FsReadRequest {
            params: v5::PlatformAssetPath { path: text(path) },
            query: Default::default(),
        };
        let outcome = client
            .call(
                "fs.read",
                wire::location_scope("/project"),
                request.encode_to_vec(),
            )
            .await;
        let Outcome::AssetSuccess {
            metadata, bytes, ..
        } = outcome
        else {
            panic!("asset success")
        };
        assert_eq!(metadata.byte_count, length as u64);
        assert_eq!(units(&metadata.mime), "application/octet-stream");
        assert_eq!(metadata.metadata.type_name, "ycoding.v5.fs_read_Result");
        assert_eq!(bytes.as_slice(), vec![255; length]);
    }
    server.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn inline_asset_success_is_an_established_adapter_protocol_failure() {
    let mut dispatcher = bare_dispatcher();
    dispatcher
        .handle("fs.read", |_, _: v5::FsReadRequest| async {
            Ok(v5::FsReadResult {
                data: v5::PlatformAssetMetadata {
                    mime: text("application/octet-stream"),
                    byte_count: 0,
                },
            })
        })
        .unwrap();
    let server = start(
        services(ycoding_runtime::LocalAuth::disabled(), false),
        dispatcher,
    )
    .await;
    let mut client = Client::open(server.address(), &[]).await.unwrap();
    let request_id = client
        .send(
            "fs.read",
            wire::location_scope("/project"),
            v5::FsReadRequest {
                params: v5::PlatformAssetPath {
                    path: text("empty"),
                },
                query: Default::default(),
            }
            .encode_to_vec(),
        )
        .await;
    assert_eq!(client.closed().await, (1002, "malformed".into()));
    assert!(!client.events.iter().any(|event| matches!(event,
        Event::Settled(id, Outcome::Success { .. } | Outcome::AssetSuccess { .. }, _) if id == &request_id
    )));
    server.shutdown().await.unwrap();
}
