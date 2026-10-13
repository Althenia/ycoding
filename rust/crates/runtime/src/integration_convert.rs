use crate::{convert, dispatch::Failure};
use ycoding_core::ycoding_schema::integration;
use ycoding_protocol::v5;

pub fn info(info: &integration::Info) -> v5::IntegrationInfo {
    use v5::connection_info::Kind;
    use ycoding_core::ycoding_schema::connection;
    v5::IntegrationInfo {
        id: convert::wire(info.id.as_lossless()),
        name: convert::wire(&info.name),
        methods: v5::IntegrationInfoMethods {
            items: info.methods.iter().map(method).collect(),
        },
        connections: v5::IntegrationInfoConnections {
            items: info
                .connections
                .iter()
                .map(|connection| v5::ConnectionInfo {
                    kind: Some(match connection {
                        connection::Info::Credential(connection) => {
                            Kind::Value1(v5::ConnectionCredentialInfo {
                                r#type: 1,
                                id: convert::wire(&connection.id.0),
                                label: convert::wire(&connection.label),
                                active: connection.active,
                            })
                        }
                        connection::Info::Env(connection) => Kind::Value2(v5::ConnectionEnvInfo {
                            r#type: 1,
                            name: convert::wire(&connection.name),
                        }),
                    }),
                })
                .collect(),
        },
    }
}

fn method(method: &integration::Method) -> v5::IntegrationMethod {
    use v5::integration_method::Kind;
    v5::IntegrationMethod {
        kind: Some(match method {
            integration::Method::OAuth(method) => Kind::Value1(v5::IntegrationOAuthMethod {
                id: convert::wire(method.id.as_lossless()),
                r#type: 1,
                label: convert::wire(&method.label),
                remote: method.remote,
                prompts: method
                    .prompts
                    .as_ref()
                    .map(|prompts| v5::IntegrationOAuthMethodPrompts {
                        items: prompts.iter().map(prompt).collect(),
                    }),
            }),
            integration::Method::Command(method) => Kind::Value2(v5::IntegrationCommandMethod {
                id: convert::wire(method.id.as_lossless()),
                r#type: 1,
                label: convert::wire(&method.label),
                command: v5::IntegrationCommandMethodCommand {
                    items: method.command.iter().map(convert::wire).collect(),
                },
            }),
            integration::Method::Key(method) => Kind::Value3(v5::IntegrationKeyMethod {
                r#type: 1,
                label: method.label.as_ref().map(convert::wire),
            }),
            integration::Method::Env(method) => Kind::Value4(v5::IntegrationEnvMethod {
                r#type: 1,
                names: v5::IntegrationEnvMethodNames {
                    items: method.names.iter().map(convert::wire).collect(),
                },
            }),
        }),
    }
}

fn prompt(prompt: &integration::Prompt) -> v5::IntegrationOAuthMethodPromptsItem {
    use v5::integration_o_auth_method_prompts_item::Kind;
    v5::IntegrationOAuthMethodPromptsItem {
        kind: Some(match prompt {
            integration::Prompt::Text(prompt) => Kind::Value1(v5::IntegrationTextPrompt {
                r#type: 1,
                key: convert::wire(&prompt.key),
                message: convert::wire(&prompt.message),
                placeholder: prompt.placeholder.as_ref().map(convert::wire),
                when: prompt.when.as_ref().map(when),
            }),
            integration::Prompt::Select(prompt) => Kind::Value2(v5::IntegrationSelectPrompt {
                r#type: 1,
                key: convert::wire(&prompt.key),
                message: convert::wire(&prompt.message),
                when: prompt.when.as_ref().map(when),
                options: v5::IntegrationSelectPromptOptions {
                    items: prompt
                        .options
                        .iter()
                        .map(|option| v5::IntegrationSelectPromptOptionsItem {
                            label: convert::wire(&option.label),
                            value: convert::wire(&option.value),
                            hint: option.hint.as_ref().map(convert::wire),
                        })
                        .collect(),
                },
            }),
        }),
    }
}

fn when(when: &integration::When) -> v5::IntegrationWhen {
    v5::IntegrationWhen {
        key: convert::wire(&when.key),
        op: if when.op.as_str() == Some("eq") { 1 } else { 2 },
        value: convert::wire(&when.value),
    }
}

pub fn command_status(
    status: &integration::CommandAttemptStatus,
) -> v5::IntegrationCommandAttemptStatus {
    use v5::integration_command_attempt_status::Kind;
    v5::IntegrationCommandAttemptStatus {
        kind: Some(match status {
            integration::CommandAttemptStatus::Pending { message, time } => {
                Kind::Value1(v5::IntegrationCommandAttemptStatusValue1 {
                    status: 1,
                    message: message.as_ref().map(convert::wire),
                    time: v5::IntegrationCommandAttemptStatusValue1Time {
                        created: time.created,
                        expires: time.expires,
                    },
                })
            }
            integration::CommandAttemptStatus::Complete(time) => {
                Kind::Value2(v5::IntegrationCommandAttemptStatusValue2 {
                    status: 1,
                    time: v5::IntegrationCommandAttemptStatusValue2Time {
                        created: time.created,
                        expires: time.expires,
                    },
                })
            }
            integration::CommandAttemptStatus::Failed { message, time } => {
                Kind::Value3(v5::IntegrationCommandAttemptStatusValue3 {
                    status: 1,
                    message: convert::wire(message),
                    time: v5::IntegrationCommandAttemptStatusValue3Time {
                        created: time.created,
                        expires: time.expires,
                    },
                })
            }
            integration::CommandAttemptStatus::Expired(time) => {
                Kind::Value4(v5::IntegrationCommandAttemptStatusValue4 {
                    status: 1,
                    time: v5::IntegrationCommandAttemptStatusValue4Time {
                        created: time.created,
                        expires: time.expires,
                    },
                })
            }
        }),
    }
}

pub fn attempt(attempt: &integration::Attempt) -> Result<v5::IntegrationAttempt, Failure> {
    Ok(v5::IntegrationAttempt {
        attempt_id: convert::wire(&attempt.attempt_id.0),
        url: convert::wire(&attempt.url),
        instructions: convert::wire(&attempt.instructions),
        mode: match attempt.mode.as_str() {
            Some("auto") => 1,
            Some("code") => 2,
            _ => return Err(Failure::Unavailable("Invalid OAuth attempt mode".into())),
        },
        manual_code: attempt.manual_code,
        time: v5::IntegrationAttemptTime {
            created: attempt.time.created,
            expires: attempt.time.expires,
        },
    })
}

pub fn status(status: &integration::AttemptStatus) -> v5::IntegrationAttemptStatus {
    use v5::integration_attempt_status::Kind;
    let kind = match status {
        integration::AttemptStatus::Pending(time) => {
            Kind::Value1(v5::IntegrationAttemptStatusValue1 {
                status: 1,
                time: v5::IntegrationAttemptStatusValue1Time {
                    created: time.created,
                    expires: time.expires,
                },
            })
        }
        integration::AttemptStatus::Complete(time) => {
            Kind::Value2(v5::IntegrationAttemptStatusValue2 {
                status: 1,
                time: v5::IntegrationAttemptStatusValue2Time {
                    created: time.created,
                    expires: time.expires,
                },
            })
        }
        integration::AttemptStatus::Failed { time, message } => {
            Kind::Value3(v5::IntegrationAttemptStatusValue3 {
                status: 1,
                message: convert::wire(message),
                time: v5::IntegrationAttemptStatusValue3Time {
                    created: time.created,
                    expires: time.expires,
                },
            })
        }
        integration::AttemptStatus::Expired(time) => {
            Kind::Value4(v5::IntegrationAttemptStatusValue4 {
                status: 1,
                time: v5::IntegrationAttemptStatusValue4Time {
                    created: time.created,
                    expires: time.expires,
                },
            })
        }
    };
    v5::IntegrationAttemptStatus { kind: Some(kind) }
}
