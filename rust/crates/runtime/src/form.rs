use crate::{
    convert,
    dispatch::{Failure, Invocation},
    ids,
    locations::LocationServices,
};
use ycoding_core::tools::policy::forms::Error;
use ycoding_core::ycoding_schema::{DomainDecode, JsonObject, JsonValue, LosslessString, form};
use ycoding_protocol::v5;

pub async fn create(
    invocation: Invocation,
    request: v5::SessionFormCreateRequest,
) -> Result<v5::SessionFormCreateResult, Failure> {
    let (session, services) = owner(&invocation, &request.params.session_id)?;
    let payload = request.payload;
    let id = match &payload.id {
        Some(id) => convert::domain(id)?,
        None => ids::prefixed("frm_")
            .map_err(|_| Failure::Unavailable("form ID generation failed".into()))?,
    };
    let mut object = JsonObject::new();
    object.insert("id".into(), JsonValue::String(id));
    object.insert("sessionID".into(), JsonValue::String(session.clone()));
    object.insert(
        "title".into(),
        JsonValue::String(convert::domain(&payload.title)?),
    );
    if let Some(metadata) = &payload.metadata {
        object.insert(
            "metadata".into(),
            JsonValue::Object(convert::object_domain(
                metadata
                    .entries
                    .iter()
                    .map(|entry| (&entry.key, &entry.value)),
            )?),
        );
    }
    object.insert(
        "fields".into(),
        JsonValue::Array(
            payload
                .fields
                .items
                .iter()
                .map(field_json)
                .collect::<Result<_, _>>()?,
        ),
    );
    let info = form::Info::decode(&JsonValue::Object(object))
        .map_err(|_| invalid_fields("The form definition is invalid"))?;
    let created = services.forms.create(info).map_err(|error| match error {
        Error::AlreadyExists => Failure::Conflict("Form already exists".into()),
        Error::InvalidForm(message) => invalid_fields(&convert::readable(&message)),
        _ => Failure::Unavailable("Form service unavailable".into()),
    })?;
    Ok(v5::SessionFormCreateResult {
        data: info_wire(&created)?,
    })
}

pub async fn list(
    invocation: Invocation,
    request: v5::SessionFormListRequest,
) -> Result<v5::SessionFormListResult, Failure> {
    let (session, services) = owner(&invocation, &request.params.session_id)?;
    Ok(v5::SessionFormListResult {
        data: v5::SessionFormListResultData {
            items: services
                .forms
                .list(Some(&session))
                .iter()
                .map(info_wire)
                .collect::<Result<_, _>>()?,
        },
    })
}

pub async fn request_list(
    invocation: Invocation,
    request: v5::FormRequestListRequest,
) -> Result<v5::FormRequestListResult, Failure> {
    let services = invocation.location(request.query.location.as_ref())?;
    Ok(v5::FormRequestListResult {
        location: convert::location_info(&services.info),
        data: v5::FormRequestListResultData {
            items: services
                .forms
                .list(None)
                .iter()
                .map(info_wire)
                .collect::<Result<_, _>>()?,
        },
    })
}

pub async fn get(
    invocation: Invocation,
    request: v5::SessionFormGetRequest,
) -> Result<v5::SessionFormGetResult, Failure> {
    let (session, services) = owner(&invocation, &request.params.session_id)?;
    let (_, info) = owned(&services, &session, &request.params.form_id)?;
    Ok(v5::SessionFormGetResult {
        data: info_wire(&info)?,
    })
}

pub async fn state(
    invocation: Invocation,
    request: v5::SessionFormStateRequest,
) -> Result<v5::SessionFormStateResult, Failure> {
    let (session, services) = owner(&invocation, &request.params.session_id)?;
    let (id, _) = owned(&services, &session, &request.params.form_id)?;
    let state = services
        .forms
        .state(&id)
        .map_err(|error| failure(error, &request.params.form_id))?;
    Ok(v5::SessionFormStateResult {
        data: state_wire(&state)?,
    })
}

pub async fn reply(
    invocation: Invocation,
    request: v5::SessionFormReplyRequest,
) -> Result<v5::SessionFormReplyResult, Failure> {
    let (session, services) = owner(&invocation, &request.params.session_id)?;
    let (id, _) = owned(&services, &session, &request.params.form_id)?;
    let mut answer = JsonObject::new();
    for entry in &request.payload.answer.entries {
        answer.insert(convert::domain(&entry.key)?, value_json(&entry.value)?);
    }
    services
        .forms
        .reply(&id, form::Answer(answer))
        .map_err(|error| failure(error, &request.params.form_id))?;
    Ok(v5::SessionFormReplyResult { data: v5::Empty {} })
}

pub async fn cancel(
    invocation: Invocation,
    request: v5::SessionFormCancelRequest,
) -> Result<v5::SessionFormCancelResult, Failure> {
    let (session, services) = owner(&invocation, &request.params.session_id)?;
    let (id, _) = owned(&services, &session, &request.params.form_id)?;
    services
        .forms
        .cancel(&id)
        .map_err(|error| failure(error, &request.params.form_id))?;
    Ok(v5::SessionFormCancelResult { data: v5::Empty {} })
}

fn owner(
    invocation: &Invocation,
    id: &v5::LosslessString,
) -> Result<(LosslessString, std::sync::Arc<LocationServices>), Failure> {
    if let Some(v5::scope::Target::GlobalForm(scope)) = &invocation.scope.target {
        let requested = convert::domain(id)?;
        if requested != LosslessString::from("global") {
            return Err(Failure::Invalid(
                "Global Form scope requires the global owner".into(),
            ));
        }
        let workspace = scope
            .workspace_id
            .as_ref()
            .map(convert::domain)
            .transpose()?;
        let services = invocation
            .core()?
            .locations
            .location(&convert::domain(&scope.directory)?, workspace.as_ref())?;
        return Ok((requested, services));
    }
    let session = invocation.form_session(id)?;
    let (_, services) = invocation.core()?.locations.session(&session)?;
    Ok((session.as_lossless().clone(), services))
}

fn owned(
    services: &LocationServices,
    session: &LosslessString,
    requested: &v5::LosslessString,
) -> Result<(form::Id, form::Info), Failure> {
    let id = convert::identifier::<form::Id>(requested)?;
    services
        .forms
        .get(&id)
        .ok()
        .filter(|info| &info.session_id == session)
        .map(|info| (id, info))
        .ok_or_else(|| missing(requested))
}

fn failure(error: Error, id: &v5::LosslessString) -> Failure {
    match error {
        Error::NotFound => missing(id),
        Error::AlreadySettled => Failure::FormAlreadySettled(readable(id)),
        Error::InvalidAnswer(message) => Failure::FormInvalidAnswer {
            id: readable(id),
            message: convert::readable(&message),
        },
        _ => Failure::Unavailable("Form service unavailable".into()),
    }
}

fn missing(id: &v5::LosslessString) -> Failure {
    Failure::FormNotFound(readable(id))
}

fn readable(id: &v5::LosslessString) -> String {
    convert::domain(id)
        .map(|id| convert::readable(&id))
        .unwrap_or_default()
}

fn invalid_fields(message: &str) -> Failure {
    Failure::InvalidField {
        message: message.into(),
        field: "fields",
    }
}

pub(crate) fn info_wire(info: &form::Info) -> Result<v5::FormInfo, Failure> {
    Ok(v5::FormInfo {
        id: convert::identity(&info.id)?,
        session_id: convert::wire(&info.session_id),
        title: convert::wire(&info.title),
        metadata: info.metadata.as_ref().map(|metadata| v5::FormMetadata {
            entries: metadata
                .iter()
                .map(|(key, value)| v5::FormMetadataEntry {
                    key: convert::wire(key),
                    value: convert::json_to_value(value),
                })
                .collect(),
        }),
        fields: v5::FormFields {
            items: info.fields.0.iter().map(field_wire).collect(),
        },
    })
}

fn state_wire(state: &form::State) -> Result<v5::FormState, Failure> {
    use v5::form_state::Kind;
    Ok(v5::FormState {
        kind: Some(match state {
            form::State::Pending => Kind::Value1(v5::FormStateValue1 { status: 1 }),
            form::State::Cancelled => Kind::Value3(v5::FormStateValue3 { status: 1 }),
            form::State::Answered(answer) => Kind::Value2(v5::FormStateValue2 {
                status: 1,
                answer: v5::FormAnswer {
                    entries: answer
                        .0
                        .iter()
                        .map(|(key, value)| {
                            Ok(v5::FormAnswerEntry {
                                key: convert::wire(key),
                                value: value_wire(value)?,
                            })
                        })
                        .collect::<Result<_, Failure>>()?,
                },
            }),
        }),
    })
}

pub(crate) fn value_wire(value: &JsonValue) -> Result<v5::FormValue, Failure> {
    use v5::form_value::Kind;
    Ok(v5::FormValue {
        kind: Some(match value {
            JsonValue::String(text) => Kind::Value1(convert::wire(text)),
            JsonValue::Number(number) => Kind::Value2(*number),
            JsonValue::Bool(flag) => Kind::Value3(*flag),
            JsonValue::Array(items) => Kind::Value4(v5::FormValueValue4 {
                items: items
                    .iter()
                    .map(|item| match item {
                        JsonValue::String(text) => Ok(convert::wire(text)),
                        _ => Err(unrepresentable()),
                    })
                    .collect::<Result<_, _>>()?,
            }),
            _ => return Err(unrepresentable()),
        }),
    })
}

fn value_json(value: &v5::FormValue) -> Result<JsonValue, Failure> {
    use v5::form_value::Kind;
    match value.kind.as_ref() {
        Some(Kind::Value1(text)) => convert::domain(text).map(JsonValue::String),
        Some(Kind::Value2(number)) => Ok(JsonValue::Number(*number)),
        Some(Kind::Value3(flag)) => Ok(JsonValue::Bool(*flag)),
        Some(Kind::Value4(items)) => items
            .items
            .iter()
            .map(|item| convert::domain(item).map(JsonValue::String))
            .collect::<Result<_, _>>()
            .map(JsonValue::Array),
        None => Err(Failure::Invalid("missing form value".into())),
    }
}

fn unrepresentable() -> Failure {
    Failure::Unavailable("stored form is not representable on the wire".into())
}

fn field_wire(field: &form::Field) -> v5::FormField {
    use v5::form_field::Kind;
    let when = |base: &form::Base| {
        base.when.as_ref().map(|items| {
            items
                .iter()
                .map(|when| v5::FormWhen {
                    key: convert::wire(&when.key),
                    op: match when.op {
                        form::WhenOp::Eq => 1,
                        form::WhenOp::Neq => 2,
                    },
                    value: v5::FormWhenValue {
                        kind: Some(match &when.value {
                            form::WhenValue::String(text) => {
                                v5::form_when_value::Kind::Value1(convert::wire(text))
                            }
                            form::WhenValue::Number(number) => {
                                v5::form_when_value::Kind::Value2(*number)
                            }
                            form::WhenValue::Boolean(flag) => {
                                v5::form_when_value::Kind::Value3(*flag)
                            }
                        }),
                    },
                })
                .collect::<Vec<_>>()
        })
    };
    let options = |options: &[form::Option]| {
        options
            .iter()
            .map(|option| v5::FormOption {
                value: convert::wire(&option.value),
                label: convert::wire(&option.label),
                description: option.description.as_ref().map(convert::wire),
            })
            .collect::<Vec<_>>()
    };
    let text = |value: &Option<LosslessString>| value.as_ref().map(convert::wire);
    let count = |value: &Option<ycoding_core::ycoding_schema::schema::NonNegativeInt>| {
        value.map(|count| count.get() as u64)
    };
    v5::FormField {
        kind: Some(match field {
            form::Field::String(field) => Kind::Value1(v5::FormStringField {
                key: convert::wire(&field.base.key),
                title: text(&field.base.title),
                description: text(&field.base.description),
                required: field.base.required,
                when: when(&field.base).map(|items| v5::FormStringFieldWhen { items }),
                r#type: 1,
                format: field.format.map(|format| match format {
                    form::StringFormat::Email => 1,
                    form::StringFormat::Uri => 2,
                    form::StringFormat::Date => 3,
                    form::StringFormat::DateTime => 4,
                }),
                min_length: count(&field.min_length),
                max_length: count(&field.max_length),
                pattern: text(&field.pattern),
                placeholder: text(&field.placeholder),
                default: text(&field.default),
                options: field
                    .options
                    .as_ref()
                    .map(|items| v5::FormStringFieldOptions {
                        items: options(items),
                    }),
                custom: field.custom,
            }),
            form::Field::Number(field) => Kind::Value2(v5::FormNumberField {
                key: convert::wire(&field.base.key),
                title: text(&field.base.title),
                description: text(&field.base.description),
                required: field.base.required,
                when: when(&field.base).map(|items| v5::FormNumberFieldWhen { items }),
                r#type: 1,
                minimum: field.minimum,
                maximum: field.maximum,
                default: field.default,
            }),
            form::Field::Integer(field) => Kind::Value3(v5::FormIntegerField {
                key: convert::wire(&field.base.key),
                title: text(&field.base.title),
                description: text(&field.base.description),
                required: field.base.required,
                when: when(&field.base).map(|items| v5::FormIntegerFieldWhen { items }),
                r#type: 1,
                minimum: field.minimum,
                maximum: field.maximum,
                default: field.default,
            }),
            form::Field::Boolean(field) => Kind::Value4(v5::FormBooleanField {
                key: convert::wire(&field.base.key),
                title: text(&field.base.title),
                description: text(&field.base.description),
                required: field.base.required,
                when: when(&field.base).map(|items| v5::FormBooleanFieldWhen { items }),
                r#type: 1,
                default: field.default,
            }),
            form::Field::Multiselect(field) => Kind::Value5(v5::FormMultiselectField {
                key: convert::wire(&field.base.key),
                title: text(&field.base.title),
                description: text(&field.base.description),
                required: field.base.required,
                when: when(&field.base).map(|items| v5::FormMultiselectFieldWhen { items }),
                r#type: 1,
                options: v5::FormMultiselectFieldOptions {
                    items: options(&field.options),
                },
                min_items: count(&field.min_items),
                max_items: count(&field.max_items),
                custom: field.custom,
                default: field
                    .default
                    .as_ref()
                    .map(|items| v5::FormMultiselectFieldDefault {
                        items: items.iter().map(convert::wire).collect(),
                    }),
            }),
            form::Field::External(field) => Kind::Value6(v5::FormExternalField {
                key: convert::wire(&field.key),
                r#type: 1,
                url: convert::wire(&field.url),
                title: text(&field.title),
                description: text(&field.description),
            }),
        }),
    }
}

fn field_json(field: &v5::FormField) -> Result<JsonValue, Failure> {
    use v5::form_field::Kind;
    let mut object = JsonObject::new();
    match field.kind.as_ref() {
        Some(Kind::Value1(field)) => {
            base(
                &mut object,
                "string",
                &field.key,
                (&field.title, &field.description, field.required),
                field.when.as_ref().map(|when| &when.items),
            )?;
            if let Some(format) = field.format {
                let format = match format {
                    1 => "email",
                    2 => "uri",
                    3 => "date",
                    4 => "date-time",
                    _ => return Err(invalid_fields("The form string format is invalid")),
                };
                put(&mut object, "format", JsonValue::String(format.into()));
            }
            count(&mut object, "minLength", field.min_length);
            count(&mut object, "maxLength", field.max_length);
            text(&mut object, "pattern", &field.pattern)?;
            text(&mut object, "placeholder", &field.placeholder)?;
            text(&mut object, "default", &field.default)?;
            if let Some(options) = &field.options {
                put(&mut object, "options", options_json(&options.items)?);
            }
            flag(&mut object, "custom", field.custom);
        }
        Some(Kind::Value2(field)) => {
            base(
                &mut object,
                "number",
                &field.key,
                (&field.title, &field.description, field.required),
                field.when.as_ref().map(|when| &when.items),
            )?;
            number(&mut object, "minimum", field.minimum);
            number(&mut object, "maximum", field.maximum);
            number(&mut object, "default", field.default);
        }
        Some(Kind::Value3(field)) => {
            base(
                &mut object,
                "integer",
                &field.key,
                (&field.title, &field.description, field.required),
                field.when.as_ref().map(|when| &when.items),
            )?;
            number(&mut object, "minimum", field.minimum);
            number(&mut object, "maximum", field.maximum);
            number(&mut object, "default", field.default);
        }
        Some(Kind::Value4(field)) => {
            base(
                &mut object,
                "boolean",
                &field.key,
                (&field.title, &field.description, field.required),
                field.when.as_ref().map(|when| &when.items),
            )?;
            flag(&mut object, "default", field.default);
        }
        Some(Kind::Value5(field)) => {
            base(
                &mut object,
                "multiselect",
                &field.key,
                (&field.title, &field.description, field.required),
                field.when.as_ref().map(|when| &when.items),
            )?;
            put(&mut object, "options", options_json(&field.options.items)?);
            count(&mut object, "minItems", field.min_items);
            count(&mut object, "maxItems", field.max_items);
            flag(&mut object, "custom", field.custom);
            if let Some(default) = &field.default {
                put(
                    &mut object,
                    "default",
                    JsonValue::Array(
                        default
                            .items
                            .iter()
                            .map(|item| convert::domain(item).map(JsonValue::String))
                            .collect::<Result<_, _>>()?,
                    ),
                );
            }
        }
        Some(Kind::Value6(field)) => {
            put(&mut object, "type", JsonValue::String("external".into()));
            put(
                &mut object,
                "key",
                JsonValue::String(convert::domain(&field.key)?),
            );
            put(
                &mut object,
                "url",
                JsonValue::String(convert::domain(&field.url)?),
            );
            text(&mut object, "title", &field.title)?;
            text(&mut object, "description", &field.description)?;
        }
        None => return Err(invalid_fields("The form field is missing")),
    }
    Ok(JsonValue::Object(object))
}

fn base(
    object: &mut JsonObject,
    kind: &str,
    key: &v5::LosslessString,
    (title, description, required): (
        &Option<v5::LosslessString>,
        &Option<v5::LosslessString>,
        Option<bool>,
    ),
    when: Option<&Vec<v5::FormWhen>>,
) -> Result<(), Failure> {
    put(object, "type", JsonValue::String(kind.into()));
    put(object, "key", JsonValue::String(convert::domain(key)?));
    text(object, "title", title)?;
    text(object, "description", description)?;
    flag(object, "required", required);
    if let Some(when) = when {
        put(
            object,
            "when",
            JsonValue::Array(
                when.iter()
                    .map(|when| {
                        let mut entry = JsonObject::new();
                        put(
                            &mut entry,
                            "key",
                            JsonValue::String(convert::domain(&when.key)?),
                        );
                        put(
                            &mut entry,
                            "op",
                            JsonValue::String(
                                match when.op {
                                    1 => "eq",
                                    2 => "neq",
                                    _ => {
                                        return Err(invalid_fields(
                                            "The form condition is invalid",
                                        ));
                                    }
                                }
                                .into(),
                            ),
                        );
                        put(
                            &mut entry,
                            "value",
                            match when.value.kind.as_ref() {
                                Some(v5::form_when_value::Kind::Value1(text)) => {
                                    JsonValue::String(convert::domain(text)?)
                                }
                                Some(v5::form_when_value::Kind::Value2(number)) => {
                                    JsonValue::Number(*number)
                                }
                                Some(v5::form_when_value::Kind::Value3(flag)) => {
                                    JsonValue::Bool(*flag)
                                }
                                None => {
                                    return Err(invalid_fields("The form condition is invalid"));
                                }
                            },
                        );
                        Ok(JsonValue::Object(entry))
                    })
                    .collect::<Result<_, Failure>>()?,
            ),
        );
    }
    Ok(())
}

fn options_json(options: &[v5::FormOption]) -> Result<JsonValue, Failure> {
    options
        .iter()
        .map(|option| {
            let mut entry = JsonObject::new();
            put(
                &mut entry,
                "value",
                JsonValue::String(convert::domain(&option.value)?),
            );
            put(
                &mut entry,
                "label",
                JsonValue::String(convert::domain(&option.label)?),
            );
            text(&mut entry, "description", &option.description)?;
            Ok(JsonValue::Object(entry))
        })
        .collect::<Result<_, Failure>>()
        .map(JsonValue::Array)
}

fn put(object: &mut JsonObject, key: &str, value: JsonValue) {
    object.insert(key.into(), value);
}

fn text(
    object: &mut JsonObject,
    key: &str,
    value: &Option<v5::LosslessString>,
) -> Result<(), Failure> {
    if let Some(value) = value {
        put(object, key, JsonValue::String(convert::domain(value)?));
    }
    Ok(())
}

fn flag(object: &mut JsonObject, key: &str, value: Option<bool>) {
    if let Some(value) = value {
        put(object, key, JsonValue::Bool(value));
    }
}

fn number(object: &mut JsonObject, key: &str, value: Option<f64>) {
    if let Some(value) = value {
        put(object, key, JsonValue::Number(value));
    }
}

fn count(object: &mut JsonObject, key: &str, value: Option<u64>) {
    number(object, key, value.map(|value| value as f64));
}
