mod remote_derived_support;
mod support;
mod connector_support {
    pub const WAIT: std::time::Duration = super::support::WAIT;
}

use prost::{Message, Name};
use remote_derived_support::{Fixture, now};
use std::sync::Arc;
use support::{machine, operation, units};
use ycoding_core::{
    ycoding_schema::LosslessString,
    ycoding_store::{KeyPart, session::SessionTable, tuple_key},
};
use ycoding_protocol::{decode_strict, v5};
use ycoding_runtime::{
    Environment, Settled,
    connector::{Credential, Enrolled, Peer},
    standard,
};

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

async fn remote_request(
    environment: Arc<Environment>,
    name: &str,
    payload: Vec<u8>,
) -> v5::TypedPayload {
    let peer = Peer::authenticate(
        &Enrolled::new("https://relay.invalid", "device-a".into()).unwrap(),
        &Credential::new(
            "origin-test".into(),
            now() + 60_000,
            "https://relay.invalid".into(),
            "device-a".into(),
        ),
        now(),
    )
    .unwrap();
    let Some(Settled::Result(result)) = standard()
        .unwrap()
        .invoke_remote(
            environment,
            "origin-connection".into(),
            &peer,
            v5::Request {
                request_id: "origin-request".into(),
                operation_id: operation(name).operation_id,
                scope: machine(),
                payload,
            },
        )
        .await
    else {
        panic!("missing typed settlement")
    };
    match result.outcome.unwrap() {
        v5::result::Outcome::Success(payload) | v5::result::Outcome::Error(payload) => payload,
        _ => panic!("unexpected list asset"),
    }
}

async fn remote(
    environment: Arc<Environment>,
    query: v5::SessionsQuery,
) -> Result<v5::SessionListResult, v5::TypedPayload> {
    let payload = remote_request(environment, "session.list", list_request(query)).await;
    if payload.type_name == v5::SessionListResult::full_name() {
        Ok(decode_strict(&payload.payload).unwrap())
    } else {
        Err(payload)
    }
}

async fn remote_workspace(fixture: &Fixture) -> v5::LosslessString {
    let payload = remote_request(
        fixture.environment(true),
        "workspace.list",
        v5::WorkspaceListRequest {
            payload: v5::WorkspaceListRequestPayload {
                sessions_only: None,
            },
        }
        .encode_to_vec(),
    )
    .await;
    let page = decode_strict::<v5::WorkspaceListResult>(&payload.payload).unwrap();
    page.data
        .items
        .into_iter()
        .find(|item| units(&item.directory) == fixture.directory)
        .unwrap()
        .id
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn remote_list_filters_background_sessions_before_paging_and_rejects_unknown_values() {
    let fixture = Fixture::new().await;
    let id = LosslessString::from(fixture.other.as_str());
    remote_derived_support::world()
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
    let base = v5::SessionsQuery {
        workspace: Some(remote_workspace(&fixture).await),
        limit: Some(50),
        parent_id: Some(v5::SessionsQueryParentId {
            kind: Some(v5::sessions_query_parent_id::Kind::Clear(v5::Empty {})),
        }),
        ..Default::default()
    };
    let default = remote(fixture.environment(true), base.clone())
        .await
        .unwrap();
    assert!(names(&default).contains(&fixture.other));
    let included = remote(
        fixture.environment(true),
        v5::SessionsQuery {
            background: background(v5::SessionsQueryBackground::SessionsqueryBackgroundInclude),
            ..base.clone()
        },
    )
    .await
    .unwrap();
    assert_eq!(names(&included), names(&default));
    let excluded_query = v5::SessionsQuery {
        background: background(v5::SessionsQueryBackground::SessionsqueryBackgroundExclude),
        ..base.clone()
    };
    let excluded = remote(fixture.environment(true), excluded_query.clone())
        .await
        .unwrap();
    assert!(!names(&excluded).contains(&fixture.other));
    assert!(names(&excluded).contains(&fixture.root));
    assert_eq!(
        names(&excluded),
        names(&default)
            .into_iter()
            .filter(|name| name != &fixture.other)
            .collect::<Vec<_>>()
    );

    let mut paged = Vec::new();
    let mut cursor = None;
    loop {
        let page = remote(
            fixture.environment(true),
            v5::SessionsQuery {
                limit: Some(1),
                cursor: cursor.clone(),
                ..excluded_query.clone()
            },
        )
        .await
        .unwrap();
        paged.extend(names(&page));
        cursor = page.data.cursor.next.clone();
        if cursor.is_none() {
            break;
        }
    }
    assert_eq!(paged, names(&excluded));

    let invalid = remote(
        fixture.environment(true),
        v5::SessionsQuery {
            background: Some(99),
            ..base
        },
    )
    .await
    .unwrap_err();
    assert_eq!(invalid.type_name, v5::InvalidRequestError::full_name());
    fixture.close().await;
}
