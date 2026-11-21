use super::{Error, Services, error};
use crate::resources::credential;
use ycoding_ai::provider_error::{AuthenticationKind, Reason};
use ycoding_schema::{credential as credential_schema, model};

pub(super) enum Recovery {
    Restart,
    Reconnect(Error),
}

pub(super) fn rejected(failure: &ycoding_ai::Error) -> bool {
    failure.reason == Reason::Authentication
        && failure.authentication_kind == Some(AuthenticationKind::Invalid)
}

pub(super) async fn recover(
    services: &Services,
    selection: &model::Ref,
    connection: Option<&credential::Info>,
    refreshed: &mut bool,
) -> Option<Recovery> {
    let connection = connection?;
    if !matches!(
        connection.secret().domain(),
        Ok(credential_schema::Value::OAuth(_))
    ) {
        return None;
    }
    let detail = if std::mem::replace(refreshed, true) {
        "the provider rejected the refreshed sign-in".to_owned()
    } else {
        let preparation = services.auth.clone().unwrap_or_default();
        match preparation
            .refresh_rejected(
                &services.credentials,
                connection.clone(),
                services.clock.now(),
                services.claude.as_ref().map(|host| &host.accounts),
            )
            .await
        {
            Ok(()) => return Some(Recovery::Restart),
            Err(failure) => failure.to_string(),
        }
    };
    let provider = services
        .models
        .catalog()
        .provider(&selection.provider_id)
        .and_then(|provider| provider.name.to_utf8().ok())
        .or_else(|| selection.provider_id.0.to_utf8().ok())
        .unwrap_or_default();
    Some(Recovery::Reconnect(error(
        "provider.auth",
        &format!(
            "{provider} sign-in expired or was revoked and could not be refreshed: {}. Reconnect {provider}: run /connect, choose {provider}, then Reconnect.",
            detail.trim().trim_end_matches('.')
        ),
    )))
}
