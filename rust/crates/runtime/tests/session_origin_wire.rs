mod support;

use prost::Message;
use support::{Client, machine, services, start, success, text, units};
use ycoding_core::{
    ycoding_schema::LosslessString,
    ycoding_store::{KeyPart, session::SessionTable, tuple_key},
};
use ycoding_protocol::v5;
use ycoding_runtime::{LocalAuth, standard};

fn list_request(query: v5::SessionsQuery) -> Vec<u8> {
    v5::SessionListRequest { query }.encode_to_vec()
}

fn names(page: &v5::SessionListResult) -> Vec<String> {
    page.data
        .data
        .items
        .iter()
        .map(|info| units(&info.id))
        .collect()
}

fn background(value: v5::SessionsQueryBackground) -> Option<i32> {
    Some(value as i32)
}

async fn local(client: &mut Client, query: v5::SessionsQuery) -> v5::SessionListResult {
    success(
        client
            .call("session.list", machine(), list_request(query))
            .await,
    )
}

fn listed(search: &str) -> v5::SessionsQuery {
    v5::SessionsQuery {
        search: Some(text(search)),
        ..Default::default()
    }
}

async fn mark_local(id: &str) {
    let id = LosslessString::from(id);
    support::world()
        .store
        .submit(move |tx| {
            let mut row = tx
                .get::<SessionTable>(&tuple_key(&[KeyPart::String(&id)]))?
                .unwrap();
            row.origin = Some("dots-executor".into());
            SessionTable::put(tx, &row)
        })
        .unwrap()
        .await
        .unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn local_list_filters_background_sessions_before_paging_and_keeps_the_filter_in_cursors() {
    let server = start(services(LocalAuth::disabled(), true), standard().unwrap()).await;
    let mut client = Client::open(server.address(), &[]).await.unwrap();
    mark_local("ses_list_b").await;

    let default = local(&mut client, listed("ses_list_")).await;
    assert_eq!(names(&default), ["ses_list_c", "ses_list_b", "ses_list_a"]);
    let included = local(
        &mut client,
        v5::SessionsQuery {
            background: background(v5::SessionsQueryBackground::SessionsqueryBackgroundInclude),
            ..listed("ses_list_")
        },
    )
    .await;
    assert_eq!(names(&included), names(&default));
    assert_eq!(included.data.cursor, default.data.cursor);

    let excluded_query = v5::SessionsQuery {
        background: background(v5::SessionsQueryBackground::SessionsqueryBackgroundExclude),
        ..listed("ses_list_")
    };
    let excluded = local(&mut client, excluded_query.clone()).await;
    assert_eq!(names(&excluded), ["ses_list_c", "ses_list_a"]);

    let first = local(
        &mut client,
        v5::SessionsQuery {
            limit: Some(1),
            ..excluded_query.clone()
        },
    )
    .await;
    assert_eq!(names(&first), ["ses_list_c"]);
    let second = local(
        &mut client,
        v5::SessionsQuery {
            limit: Some(1),
            cursor: first.data.cursor.next.clone(),
            ..Default::default()
        },
    )
    .await;
    assert_eq!(names(&second), ["ses_list_a"]);
    let back = local(
        &mut client,
        v5::SessionsQuery {
            limit: Some(1),
            cursor: second.data.cursor.previous.clone(),
            ..Default::default()
        },
    )
    .await;
    assert_eq!(names(&back), ["ses_list_c"]);

    let plain_first = local(
        &mut client,
        v5::SessionsQuery {
            limit: Some(1),
            ..listed("ses_list_")
        },
    )
    .await;
    let included_first = local(
        &mut client,
        v5::SessionsQuery {
            limit: Some(1),
            background: background(v5::SessionsQueryBackground::SessionsqueryBackgroundInclude),
            ..listed("ses_list_")
        },
    )
    .await;
    assert_eq!(plain_first.data.cursor, included_first.data.cursor);
    assert_ne!(plain_first.data.cursor.next, first.data.cursor.next);

    assert_eq!(
        client
            .call_result(
                "session.list",
                machine(),
                list_request(v5::SessionsQuery {
                    background: Some(99),
                    ..listed("ses_list_")
                }),
            )
            .await,
        Err(ycoding_protocol::connection::ProtocolError::Malformed),
        "an unknown background mode must fail wire validation"
    );
    server.shutdown().await.unwrap();
}
