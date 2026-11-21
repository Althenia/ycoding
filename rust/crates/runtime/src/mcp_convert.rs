use crate::{convert, dispatch::Failure};
use ycoding_core::{
    resources::mcp::ServerInfo,
    ycoding_schema::{DomainDecode, JsonObject, JsonValue, ObjectEncoder, mcp},
};
use ycoding_protocol::v5;

pub fn config(config: &v5::McpAddRequestPayloadConfig) -> Result<mcp::ServerConfig, Failure> {
    use v5::mcp_add_request_payload_config::Kind;
    let config = match config.kind.as_ref() {
        Some(Kind::Value1(config)) => ObjectEncoder::new()
            .field("type", "local")
            .field(
                "command",
                &config
                    .command
                    .items
                    .iter()
                    .map(convert::domain)
                    .collect::<Result<Vec<_>, _>>()?,
            )
            .optional(
                "cwd",
                &config.cwd.as_ref().map(convert::domain).transpose()?,
            )
            .optional(
                "environment",
                &config
                    .environment
                    .as_ref()
                    .map(|environment| {
                        strings(
                            environment
                                .entries
                                .iter()
                                .map(|entry| (&entry.key, &entry.value)),
                        )
                    })
                    .transpose()?,
            )
            .optional("disabled", &config.disabled)
            .optional("codemode", &config.codemode)
            .optional("timeout", &config.timeout.as_ref().map(timeout))
            .finish(),
        Some(Kind::Value2(config)) => ObjectEncoder::new()
            .field("type", "remote")
            .field("url", &convert::domain(&config.url)?)
            .optional(
                "headers",
                &config
                    .headers
                    .as_ref()
                    .map(|headers| {
                        strings(
                            headers
                                .entries
                                .iter()
                                .map(|entry| (&entry.key, &entry.value)),
                        )
                    })
                    .transpose()?,
            )
            .optional("oauth", &config.oauth.as_ref().map(oauth).transpose()?)
            .optional("disabled", &config.disabled)
            .optional("codemode", &config.codemode)
            .optional("timeout", &config.timeout.as_ref().map(timeout))
            .finish(),
        None => return Err(Failure::Invalid("Missing MCP config".into())),
    };
    mcp::ServerConfig::decode(&config).map_err(|_| Failure::Invalid("Invalid MCP config".into()))
}

fn strings<'a>(
    entries: impl Iterator<Item = (&'a v5::LosslessString, &'a v5::LosslessString)>,
) -> Result<JsonObject, Failure> {
    let mut object = JsonObject::new();
    for (key, value) in entries {
        object.insert(
            convert::domain(key)?,
            JsonValue::String(convert::domain(value)?),
        );
    }
    Ok(object)
}

fn timeout(timeout: &v5::McpTimeoutConfig) -> JsonValue {
    ObjectEncoder::new()
        .optional("startup", &timeout.startup.map(|value| value as f64))
        .optional("catalog", &timeout.catalog.map(|value| value as f64))
        .optional("execution", &timeout.execution.map(|value| value as f64))
        .finish()
}

fn oauth(oauth: &v5::McpRemoteConfigOauth) -> Result<JsonValue, Failure> {
    use v5::mcp_remote_config_oauth::Kind;
    match oauth.kind.as_ref() {
        Some(Kind::Value2(false)) => Ok(JsonValue::Bool(false)),
        Some(Kind::Value1(config)) => Ok(ObjectEncoder::new()
            .optional(
                "client_id",
                &config.client_id.as_ref().map(convert::domain).transpose()?,
            )
            .optional(
                "client_secret",
                &config
                    .client_secret
                    .as_ref()
                    .map(convert::domain)
                    .transpose()?,
            )
            .optional(
                "scope",
                &config.scope.as_ref().map(convert::domain).transpose()?,
            )
            .optional(
                "callback_port",
                &config.callback_port.map(|value| value as f64),
            )
            .optional(
                "redirect_uri",
                &config
                    .redirect_uri
                    .as_ref()
                    .map(convert::domain)
                    .transpose()?,
            )
            .finish()),
        _ => Err(Failure::Invalid("Invalid MCP OAuth config".into())),
    }
}

pub fn server(server: &ServerInfo) -> v5::McpServer {
    use v5::mcp_server_status::Kind;
    v5::McpServer {
        name: convert::text(&server.name),
        integration_id: server.integration_id.as_ref().map(convert::wire),
        status: v5::McpServerStatus {
            kind: Some(match &server.status {
                mcp::Status::Connected => Kind::Value1(v5::McpStatusConnected { status: 1 }),
                mcp::Status::Pending => Kind::Value2(v5::McpStatusPending { status: 1 }),
                mcp::Status::Disabled => Kind::Value3(v5::McpStatusDisabled { status: 1 }),
                mcp::Status::Failed(error) => Kind::Value4(v5::McpStatusFailed {
                    status: 1,
                    error: convert::wire(error),
                }),
                mcp::Status::NeedsAuth => Kind::Value5(v5::McpStatusNeedsAuth { status: 1 }),
                mcp::Status::NeedsClientRegistration(error) => {
                    Kind::Value6(v5::McpStatusNeedsClientRegistration {
                        status: 1,
                        error: convert::wire(error),
                    })
                }
            }),
        },
    }
}

pub fn catalog(catalog: &mcp::ResourceCatalog) -> v5::McpResourceCatalog {
    v5::McpResourceCatalog {
        resources: v5::McpResourceCatalogResources {
            items: catalog
                .resources
                .iter()
                .map(|resource| v5::McpResource {
                    server: convert::wire(&resource.server),
                    name: convert::wire(&resource.name),
                    uri: convert::wire(&resource.uri),
                    description: resource.description.as_ref().map(convert::wire),
                    mime_type: resource.mime_type.as_ref().map(convert::wire),
                })
                .collect(),
        },
        templates: v5::McpResourceCatalogTemplates {
            items: catalog
                .templates
                .iter()
                .map(|resource| v5::McpResourceTemplate {
                    server: convert::wire(&resource.server),
                    name: convert::wire(&resource.name),
                    uri_template: convert::wire(&resource.uri_template),
                    description: resource.description.as_ref().map(convert::wire),
                    mime_type: resource.mime_type.as_ref().map(convert::wire),
                })
                .collect(),
        },
    }
}
