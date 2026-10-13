use super::*;
use prost::Name;

pub fn location_scope(directory: &str) -> v5::Scope {
    v5::Scope {
        target: Some(v5::scope::Target::Location(text(directory))),
    }
}

pub fn form_scope(session: &str) -> v5::Scope {
    v5::Scope {
        target: Some(v5::scope::Target::Form(session.into())),
    }
}

pub fn query(directory: &str, workspace: Option<&str>) -> v5::LocationQuery {
    v5::LocationQuery {
        location: Some(v5::LocationQueryLocation {
            directory: Some(text(directory)),
            workspace: workspace.map(text),
        }),
    }
}

pub async fn open() -> (Server, Client) {
    let server = start(
        services(LocalAuth::disabled(), true),
        ycoding_runtime::standard().unwrap(),
    )
    .await;
    let client = Client::open(server.address(), &[]).await.unwrap();
    (server, client)
}

pub async fn ask<Q: Message, R: Message + Default>(
    client: &mut Client,
    name: &str,
    scope: v5::Scope,
    request: Q,
) -> R {
    success(client.call(name, scope, request.encode_to_vec()).await)
}

pub async fn refuse<Q: Message, E: Message + Name + Default>(
    client: &mut Client,
    name: &str,
    scope: v5::Scope,
    request: Q,
) -> E {
    let payload = rejected(client.call(name, scope, request.encode_to_vec()).await);
    assert!(
        operation(name).error_types.contains(&payload.type_name),
        "{name} answered an undeclared {}",
        payload.type_name
    );
    assert_eq!(payload.type_name, E::full_name());
    E::decode(payload.payload.as_slice()).unwrap()
}
