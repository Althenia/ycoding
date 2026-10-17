use crate::{
    DecodeError, DecodeErrorKind, DomainDecode, DomainEncode, JsonPath, JsonValue, LosslessString,
    ObjectDecoder, ObjectEncoder, domain, model, provider, session, usage_anchor,
};

#[derive(Clone, Debug, PartialEq)]
pub enum ReportDimensions {
    Provider {
        provider_id: provider::Id,
    },
    ProviderProfileModel {
        provider_id: provider::Id,
        profile: Option<model::ProfileName>,
        model_id: model::Id,
    },
    ProviderModel {
        provider_id: provider::Id,
        model_id: model::Id,
    },
    ModelId {
        model_id: model::Id,
    },
    Profile {
        provider_id: provider::Id,
        profile: Option<model::ProfileName>,
    },
    Prompt {
        anchor: Option<usage_anchor::Ref>,
        attribution: Attribution,
    },
    Task {
        session_id: Option<session::Id>,
        attribution: Attribution,
    },
}

#[derive(Clone, Debug, PartialEq)]
pub enum Attribution {
    Complete,
    Partial,
    Unattributed,
}
impl Attribution {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Complete => "complete",
            Self::Partial => "partial",
            Self::Unattributed => "unattributed",
        }
    }
}

impl DomainDecode for Attribution {
    fn decode_at(value: &JsonValue, path: &JsonPath) -> Result<Self, DecodeError> {
        Ok(
            match domain::literal_enum(value, &["complete", "partial", "unattributed"], path)?
                .as_str()
            {
                Some("complete") => Self::Complete,
                Some("partial") => Self::Partial,
                _ => Self::Unattributed,
            },
        )
    }
}
impl DomainEncode for Attribution {
    fn encode(&self) -> JsonValue {
        LosslessString::from(self.as_str()).encode()
    }
}
impl ReportDimensions {
    pub fn group(&self) -> &'static str {
        match self {
            Self::Provider { .. } => "provider",
            Self::ProviderProfileModel { .. } => "provider-profile-model",
            Self::ProviderModel { .. } => "provider-model",
            Self::ModelId { .. } => "model-id",
            Self::Profile { .. } => "profile",
            Self::Prompt { .. } => "prompt",
            Self::Task { .. } => "task",
        }
    }
}
impl DomainDecode for ReportDimensions {
    fn decode_at(value: &JsonValue, path: &JsonPath) -> Result<Self, DecodeError> {
        let object = ObjectDecoder::new(value, path)?;
        let group: LosslessString = object.field("group")?;
        if object
            .optional::<LosslessString>("providerID")?
            .is_some_and(|value| value.is_empty())
        {
            return Err(path
                .key("providerID")
                .error(DecodeErrorKind::Expected("nonempty string")));
        }
        if object
            .optional::<LosslessString>("modelID")?
            .is_some_and(|value| value.is_empty())
        {
            return Err(path
                .key("modelID")
                .error(DecodeErrorKind::Expected("nonempty string")));
        }
        let profile = || -> Result<Option<model::ProfileName>, DecodeError> {
            let profile: Option<model::ProfileName> = object.optional("profile")?;
            let state = object.tag("profileState", &["recorded", "provider-default"])?;
            if (state.as_str() == Some("recorded")) != profile.is_some() {
                return Err(path.error(DecodeErrorKind::Expected(
                    "profile presence matching profileState",
                )));
            }
            Ok(profile)
        };
        Ok(match group.as_str() {
            Some("provider") => Self::Provider {
                provider_id: object.field("providerID")?,
            },
            Some("provider-profile-model") => Self::ProviderProfileModel {
                provider_id: object.field("providerID")?,
                profile: profile()?,
                model_id: object.field("modelID")?,
            },
            Some("provider-model") => Self::ProviderModel {
                provider_id: object.field("providerID")?,
                model_id: object.field("modelID")?,
            },
            Some("model-id") => Self::ModelId {
                model_id: object.field("modelID")?,
            },
            Some("profile") => Self::Profile {
                provider_id: object.field("providerID")?,
                profile: profile()?,
            },
            Some("prompt") => Self::Prompt {
                anchor: object.optional("anchor")?,
                attribution: object.field("attribution")?,
            },
            Some("task") => Self::Task {
                session_id: object.optional("sessionID")?,
                attribution: object.field("attribution")?,
            },
            _ => {
                return Err(path
                    .key("group")
                    .error(DecodeErrorKind::Expected("usage report dimension")));
            }
        })
    }
}
impl DomainEncode for ReportDimensions {
    fn encode(&self) -> JsonValue {
        let object = ObjectEncoder::new().field("group", &LosslessString::from(self.group()));
        match self {
            Self::Provider { provider_id } => object.field("providerID", provider_id),
            Self::ProviderProfileModel {
                provider_id,
                profile,
                model_id,
            } => object
                .field("providerID", provider_id)
                .optional("profile", profile)
                .field(
                    "profileState",
                    &LosslessString::from(if profile.is_some() {
                        "recorded"
                    } else {
                        "provider-default"
                    }),
                )
                .field("modelID", model_id),
            Self::ProviderModel {
                provider_id,
                model_id,
            } => object
                .field("providerID", provider_id)
                .field("modelID", model_id),
            Self::ModelId { model_id } => object.field("modelID", model_id),
            Self::Profile {
                provider_id,
                profile,
            } => object
                .field("providerID", provider_id)
                .optional("profile", profile)
                .field(
                    "profileState",
                    &LosslessString::from(if profile.is_some() {
                        "recorded"
                    } else {
                        "provider-default"
                    }),
                ),
            Self::Prompt {
                anchor,
                attribution,
            } => object
                .optional("anchor", anchor)
                .field("attribution", attribution),
            Self::Task {
                session_id,
                attribution,
            } => object
                .optional("sessionID", session_id)
                .field("attribution", attribution),
        }
        .finish()
    }
}
