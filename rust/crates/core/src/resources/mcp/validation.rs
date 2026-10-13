use super::oauth::Error;
use serde_json::Value;
use url::Url;

fn strings(value: &Value) -> bool {
    value
        .as_array()
        .is_some_and(|values| values.iter().all(Value::is_string))
}
fn optional(value: &Value, fields: &[&str], valid: impl Fn(&Value) -> bool) -> bool {
    fields
        .iter()
        .all(|field| value.get(field).is_none_or(&valid))
}
fn safe(value: &Value) -> bool {
    value.as_str().is_some_and(|value| safe_url(value).is_ok())
}
pub(crate) fn safe_url(value: &str) -> Result<Url, Error> {
    let url = Url::parse(value).map_err(|_| Error::Discovery)?;
    if ["javascript", "data", "vbscript"].contains(&url.scheme()) {
        return Err(Error::Discovery);
    }
    Ok(url)
}
pub(crate) fn authorization(value: &Value, oidc: bool) -> Result<(), Error> {
    if !value.is_object()
        || !value["issuer"].is_string()
        || !safe(&value["authorization_endpoint"])
        || !safe(&value["token_endpoint"])
        || !strings(&value["response_types_supported"])
        || !optional(
            value,
            &[
                "scopes_supported",
                "response_modes_supported",
                "grant_types_supported",
                "token_endpoint_auth_methods_supported",
                "token_endpoint_auth_signing_alg_values_supported",
                "code_challenge_methods_supported",
            ],
            strings,
        )
        || !optional(value, &["registration_endpoint"], safe)
        || !optional(
            value,
            &["client_id_metadata_document_supported"],
            Value::is_boolean,
        )
    {
        return Err(Error::Discovery);
    }
    if !oidc
        && (!optional(
            value,
            &["service_documentation", "revocation_endpoint"],
            safe,
        ) || !optional(
            value,
            &[
                "revocation_endpoint_auth_methods_supported",
                "revocation_endpoint_auth_signing_alg_values_supported",
                "introspection_endpoint_auth_methods_supported",
                "introspection_endpoint_auth_signing_alg_values_supported",
            ],
            strings,
        ) || !optional(value, &["introspection_endpoint"], Value::is_string))
    {
        return Err(Error::Discovery);
    }
    if oidc
        && (!safe(&value["jwks_uri"])
            || !strings(&value["subject_types_supported"])
            || !strings(&value["id_token_signing_alg_values_supported"])
            || !optional(value, &["userinfo_endpoint"], safe)
            || !optional(
                value,
                &[
                    "acr_values_supported",
                    "id_token_encryption_alg_values_supported",
                    "id_token_encryption_enc_values_supported",
                    "userinfo_signing_alg_values_supported",
                    "userinfo_encryption_alg_values_supported",
                    "userinfo_encryption_enc_values_supported",
                    "request_object_signing_alg_values_supported",
                    "request_object_encryption_alg_values_supported",
                    "request_object_encryption_enc_values_supported",
                    "display_values_supported",
                    "claim_types_supported",
                    "claims_supported",
                    "claims_locales_supported",
                    "ui_locales_supported",
                ],
                strings,
            )
            || !optional(
                value,
                &["service_documentation", "op_policy_uri", "op_tos_uri"],
                Value::is_string,
            )
            || !optional(
                value,
                &[
                    "claims_parameter_supported",
                    "request_parameter_supported",
                    "request_uri_parameter_supported",
                    "require_request_uri_registration",
                ],
                Value::is_boolean,
            ))
    {
        return Err(Error::Discovery);
    }
    Ok(())
}
pub(crate) fn protected(value: &Value) -> Result<(), Error> {
    if !value.is_object()
        || !value["resource"]
            .as_str()
            .is_some_and(|value| Url::parse(value).is_ok())
        || !optional(value, &["authorization_servers"], |value| {
            value
                .as_array()
                .is_some_and(|values| values.iter().all(safe))
        })
        || !optional(
            value,
            &[
                "jwks_uri",
                "resource_documentation",
                "resource_policy_uri",
                "resource_tos_uri",
            ],
            |value| {
                value
                    .as_str()
                    .is_some_and(|value| Url::parse(value).is_ok())
            },
        )
        || !optional(
            value,
            &[
                "scopes_supported",
                "bearer_methods_supported",
                "resource_signing_alg_values_supported",
                "authorization_details_types_supported",
                "dpop_signing_alg_values_supported",
            ],
            strings,
        )
        || !optional(value, &["resource_name"], Value::is_string)
        || !optional(
            value,
            &[
                "tls_client_certificate_bound_access_tokens",
                "dpop_bound_access_tokens_required",
            ],
            Value::is_boolean,
        )
    {
        return Err(Error::Discovery);
    }
    Ok(())
}
pub(crate) fn client(mut value: Value) -> Result<Value, Error> {
    if !value.is_object()
        || !value["client_id"].is_string()
        || !value["redirect_uris"]
            .as_array()
            .is_some_and(|values| values.iter().all(safe))
        || !optional(
            &value,
            &[
                "client_secret",
                "token_endpoint_auth_method",
                "client_name",
                "scope",
                "policy_uri",
                "software_id",
                "software_version",
                "software_statement",
            ],
            Value::is_string,
        )
        || !optional(
            &value,
            &["client_id_issued_at", "client_secret_expires_at"],
            Value::is_number,
        )
        || !optional(&value, &["client_uri", "jwks_uri"], safe)
        || !optional(&value, &["logo_uri", "tos_uri"], |value| {
            value.as_str() == Some("") || safe(value)
        })
        || !optional(
            &value,
            &["grant_types", "response_types", "contacts"],
            strings,
        )
    {
        return Err(Error::Registration);
    }
    let object = value.as_object_mut().ok_or(Error::Registration)?;
    for field in ["logo_uri", "tos_uri"] {
        if object
            .get(field)
            .is_some_and(|value| value.as_str() == Some(""))
        {
            object.remove(field);
        }
    }
    object.retain(|field, _| {
        [
            "redirect_uris",
            "token_endpoint_auth_method",
            "grant_types",
            "response_types",
            "client_name",
            "client_uri",
            "logo_uri",
            "scope",
            "contacts",
            "tos_uri",
            "policy_uri",
            "jwks_uri",
            "jwks",
            "software_id",
            "software_version",
            "software_statement",
            "client_id",
            "client_secret",
            "client_id_issued_at",
            "client_secret_expires_at",
        ]
        .contains(&field.as_str())
    });
    Ok(value)
}
