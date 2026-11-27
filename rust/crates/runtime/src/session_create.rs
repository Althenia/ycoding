use crate::{
    convert,
    dispatch::{Failure, Invocation},
    ids, session_placement,
};
use std::path::Path;
use ycoding_core::ycoding_schema::{
    DomainDecode, JsonValue, LosslessString, ObjectEncoder, location, model, schema::RelativePath,
    session,
};
use ycoding_core::ycoding_store::session::NewEvent;
use ycoding_protocol::v5;

const DECISION_AGENT: &str = "decision";
pub(crate) const TITLE_MAX_CHARS: usize = 120;

pub async fn create(
    invocation: Invocation,
    request: v5::SessionCreateRequest,
) -> Result<v5::SessionCreateResult, Failure> {
    let core = invocation.core()?;
    let payload = request.payload;
    let scope = payload.scope.map(scope_domain).transpose()?;
    if scope == Some(session::Scope::Standalone)
        || (payload.parent_id.is_some() && (scope.is_some() || payload.location.is_some()))
    {
        return Err(Failure::InvalidField {
            message: "Standalone creation or conflicting child placement is unavailable".into(),
            field: "scope",
        });
    }
    let id = match &payload.id {
        Some(id) => convert::identifier::<session::Id>(id)?,
        None => ids::session_id()
            .map_err(|_| Failure::Unavailable("Session ID generation failed".into()))?,
    };
    let parent = payload
        .parent_id
        .as_ref()
        .map(|parent| {
            let parent = convert::identifier::<session::Id>(parent)?;
            core.sessions
                .get(&parent)
                .map_err(store)?
                .ok_or_else(|| Failure::SessionNotFound(convert::readable(parent.as_lossless())))
        })
        .transpose()?;
    if parent
        .as_ref()
        .is_some_and(|parent| parent.scope == session::Scope::Standalone)
    {
        return Err(Failure::Invalid(
            "Standalone Session creation is unavailable".into(),
        ));
    }
    let opened = parent.is_none()
        && !invocation.remote
        && payload
            .location
            .as_ref()
            .is_some_and(|location| location.workspace_id.is_none());
    let (project, location, subpath, resolved, canonical) = match &parent {
        Some(parent) => (
            parent.project_id.clone(),
            parent.location.clone(),
            parent.subpath.clone(),
            None,
            session_placement::bound(&core.state, parent.location.directory.as_lossless())?,
        ),
        None => {
            let requested = payload
                .location
                .as_ref()
                .map(|location| v5::LocationQueryLocation {
                    directory: Some(location.directory.clone()),
                    workspace: location.workspace_id.clone(),
                });
            let (directory, _) = invocation.location_key(requested.as_ref())?;
            let directory = if opened {
                admitted_directory(
                    &directory,
                    core.roots.as_ref().map(|roots| roots.home.as_path()),
                )?
            } else {
                directory
            };
            let missing = opened && missing_directory(&directory)?;
            let canonical = session_placement::bound(&core.state, &directory)?;
            let services = if opened {
                if missing {
                    std::fs::create_dir_all(convert::readable(&directory)).map_err(|_| {
                        invalid_directory("The selected directory could not be created")
                    })?;
                }
                core.locations.location(&directory, None)?
            } else {
                invocation.location(requested.as_ref())?
            };
            (
                services.info.project.id.clone(),
                location::Ref {
                    directory: services.info.directory.clone(),
                    workspace_id: services.info.workspace_id.clone(),
                },
                subpath(&services.info),
                Some(services),
                canonical,
            )
        }
    };
    if let Some(recorded) = core.sessions.get(&id).map_err(store)? {
        if invocation.remote {
            crate::remote_derived::target::verify(core, &id)?;
            let services = invocation.location(None)?;
            if recorded.parent_id.is_some()
                || recorded.project_id != services.info.project.id
                || recorded.location.directory != services.info.directory
                || recorded.location.workspace_id != services.info.workspace_id
            {
                return Err(Failure::Invalid(
                    "Session ID belongs to another workspace".into(),
                ));
            }
        }
        if recorded.scope != session::Scope::Bound
            || recorded.parent_id != parent.as_ref().map(|parent| parent.id.clone())
            || recorded.location.workspace_id != location.workspace_id
            || session_placement::physical(&session_placement::path(
                recorded.location.directory.as_lossless(),
            )?)? != canonical
        {
            return Err(Failure::SessionPlacementConflict(convert::readable(
                id.as_lossless(),
            )));
        }
        return result(&recorded);
    }
    let agent = payload.agent.as_ref().map(convert::domain).transpose()?;
    if agent.as_ref().and_then(LosslessString::as_str) == Some(DECISION_AGENT) {
        return Err(Failure::InvalidField {
            message:
                "The internal decision helper cannot be selected as a foreground Session agent."
                    .into(),
            field: "agent",
        });
    }
    if let Some(services) = &resolved {
        core.locations.record(&services.info, opened).await?;
    }
    let model = payload
        .model
        .as_ref()
        .map(model_domain)
        .transpose()?
        .or_else(|| parent.as_ref().and_then(|parent| parent.model.clone()));
    let now = ids::now_millis();
    let title = match &payload.title {
        Some(title) => session_title(convert::domain(title)?)?,
        None => LosslessString::from(format!("New session - {}", iso(now)).as_str()),
    };
    let event = NewEvent {
        id: ids::event_id()
            .map_err(|_| Failure::Unavailable("event ID generation failed".into()))?
            .as_lossless()
            .clone(),
        aggregate_id: id.as_lossless().clone(),
        created: now,
        type_: "session.created.2".into(),
        data: ObjectEncoder::new()
            .field("sessionID", &id)
            .field("projectID", &project)
            .field("scope", &session::Scope::Bound)
            .field("location", &location)
            .optional("parentID", &parent.as_ref().map(|parent| parent.id.clone()))
            .optional("agent", &agent)
            .optional("model", &model)
            .field("title", &title)
            .optional("subpath", &subpath)
            .field("created", &(now as f64))
            .finish(),
    };
    let created = if model.as_ref().is_some_and(|model| model.profile.is_some()) {
        let services = core.locations.location(
            location.directory.as_lossless(),
            location.workspace_id.as_ref().map(|id| id.as_lossless()),
        )?;
        let (_, services) = core.session_services(&services)?;
        let inherited_binding = parent
            .as_ref()
            .filter(|_| payload.model.is_none())
            .map(|parent| core.sessions.profile_binding(&parent.id))
            .transpose()
            .map_err(store)?
            .flatten();
        services
            .runner
            .create(event, inherited_binding.as_ref())
            .await
            .map_err(create_failure)?
    } else {
        core.sessions.create(event).await.map_err(store)?
    };
    if parent.is_none() {
        crate::autonomy_defaults::apply_to_new_root(core, &created.id).await;
    }
    result(&created)
}

fn session_title(title: LosslessString) -> Result<LosslessString, Failure> {
    let units = title.code_units().collect::<Vec<_>>();
    let edge = |unit: Option<&u16>| unit.is_none_or(|unit| ecmascript_space(*unit));
    if units
        .iter()
        .any(|unit| matches!(unit, 0x00..=0x1f | 0x7f..=0x9f | 0x202a..=0x202e | 0x2066..=0x2069))
        || edge(units.first())
        || edge(units.last())
        || char::decode_utf16(units.iter().copied()).count() > TITLE_MAX_CHARS
    {
        return Err(Failure::InvalidField {
            message: format!(
                "Title must be trimmed, nonblank, at most {TITLE_MAX_CHARS} characters, and free of control characters"
            ),
            field: "title",
        });
    }
    Ok(title)
}

fn invalid_directory(message: &str) -> Failure {
    Failure::InvalidField {
        message: message.into(),
        field: "location.directory",
    }
}

fn admitted_directory(
    requested: &LosslessString,
    home: Option<&Path>,
) -> Result<LosslessString, Failure> {
    let absolute = || invalid_directory("Choose an absolute directory or one starting with ~");
    let text = requested.to_utf8().map_err(|_| absolute())?;
    let expanded = match text.strip_prefix('~') {
        Some(rest) if rest.is_empty() || rest.starts_with(['/', '\\']) => home
            .ok_or_else(|| invalid_directory("The machine home directory is unavailable"))?
            .join(rest.trim_start_matches(['/', '\\'])),
        _ => std::path::PathBuf::from(&text),
    };
    if !expanded.is_absolute() {
        return Err(absolute());
    }
    ycoding_core::platform::filesystem::normalize(&expanded)
        .to_str()
        .map(LosslessString::from)
        .ok_or_else(absolute)
}

fn missing_directory(directory: &LosslessString) -> Result<bool, Failure> {
    match std::fs::metadata(convert::readable(directory)) {
        Ok(metadata) if metadata.is_dir() => Ok(false),
        Ok(_) => Err(invalid_directory("The selected path is not a directory")),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(true),
        Err(_) => Err(invalid_directory(
            "The selected directory could not be created",
        )),
    }
}

fn ecmascript_space(unit: u16) -> bool {
    matches!(
        unit,
        0x20 | 0xa0 | 0x1680 | 0x2000
            ..=0x200a | 0x2028 | 0x2029 | 0x202f | 0x205f | 0x3000 | 0xfeff
    )
}

fn create_failure(error: ycoding_core::session::run_coordinator::Error) -> Failure {
    let field = match error {
        ycoding_core::session::run_coordinator::Error::Runner(error) => match error.r#type.as_str()
        {
            Some("model.profile") => {
                return Failure::InvalidField {
                    field: "model.profile",
                    message: "Selected model profile is unavailable. Reconnect or select the profile again.".into(),
                };
            }
            Some("model.variant") => "model.variant",
            _ => "model",
        },
        error => return store(error),
    };
    Failure::InvalidField {
        field,
        message: "Selected model credentials or configuration are unavailable. Reconnect the provider or select an available model.".into(),
    }
}

fn result(info: &session::Info) -> Result<v5::SessionCreateResult, Failure> {
    Ok(v5::SessionCreateResult {
        data: convert::session_info(info)
            .map_err(|_| Failure::Unavailable("stored Session is not representable".into()))?,
    })
}

fn model_domain(model: &v5::ModelRef) -> Result<model::Ref, Failure> {
    let mut object = ycoding_core::ycoding_schema::JsonObject::new();
    object.insert("id".into(), JsonValue::String(convert::domain(&model.id)?));
    object.insert(
        "providerID".into(),
        JsonValue::String(convert::domain(&model.provider_id)?),
    );
    if let Some(variant) = &model.variant {
        object.insert(
            "variant".into(),
            JsonValue::String(convert::domain(variant)?),
        );
    }
    if let Some(profile) = &model.profile {
        object.insert(
            "profile".into(),
            JsonValue::String(convert::domain(profile)?),
        );
    }
    model::Ref::decode(&JsonValue::Object(object)).map_err(|_| Failure::InvalidField {
        message: "The selected model is invalid".into(),
        field: "model",
    })
}

fn scope_domain(scope: i32) -> Result<session::Scope, Failure> {
    match v5::SessionCreateRequestPayloadScope::try_from(scope) {
        Ok(v5::SessionCreateRequestPayloadScope::Bound) => Ok(session::Scope::Bound),
        Ok(v5::SessionCreateRequestPayloadScope::Standalone) => Ok(session::Scope::Standalone),
        Err(_) => Err(Failure::InvalidField {
            message: "Session scope is invalid".into(),
            field: "scope",
        }),
    }
}

fn subpath(info: &location::Info) -> Option<RelativePath> {
    let relative = Path::new(&convert::readable(info.directory.as_lossless()))
        .strip_prefix(convert::readable(info.project.directory.as_lossless()))
        .ok()?
        .to_str()?
        .replace('\\', "/");
    RelativePath::new(relative)
        .ok()
        .filter(|path| !path.as_lossless().is_empty())
}

fn store(_: impl std::fmt::Debug) -> Failure {
    Failure::Unavailable("Session store unavailable".into())
}

pub(crate) fn iso(millis: i64) -> String {
    let days = millis.div_euclid(86_400_000);
    let time = millis.rem_euclid(86_400_000);
    let shifted = days + 719_468;
    let era = shifted.div_euclid(146_097);
    let day_of_era = shifted.rem_euclid(146_097);
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_index = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_index + 2) / 5 + 1;
    let month = if month_index < 10 {
        month_index + 3
    } else {
        month_index - 9
    };
    let year = year_of_era + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        time / 3_600_000,
        time / 60_000 % 60,
        time / 1_000 % 60,
        time % 1_000
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn title(value: &str) -> Result<LosslessString, Failure> {
        session_title(LosslessString::from(value))
    }

    #[test]
    fn titles_follow_the_trimmed_bounded_control_free_contract() {
        let longest = "\u{1F600}".repeat(120);
        for valid in ["Release review", "a b", longest.as_str()] {
            assert!(title(valid).is_ok(), "{valid:?}");
        }
        let too_long = "\u{1F600}".repeat(121);
        for invalid in [
            "",
            " padded",
            "padded ",
            "\u{a0}edge",
            "\u{feff}edge",
            "bell\u{7}",
            "line\nbreak",
            "tab\tbreak",
            "del\u{7f}",
            "c1\u{85}",
            "bidi\u{202e}flip",
            "iso\u{2066}late",
            too_long.as_str(),
        ] {
            assert!(
                matches!(
                    title(invalid),
                    Err(Failure::InvalidField { field: "title", .. })
                ),
                "{invalid:?}"
            );
        }
    }

    #[test]
    fn explicit_root_directories_expand_home_normalize_and_reject_relative_paths() {
        let home = Path::new("/home/test");
        for (input, expected) in [
            ("~", "/home/test"),
            ("~/", "/home/test"),
            ("~/Workspace/app", "/home/test/Workspace/app"),
            ("/work/new/./project/", "/work/new/project"),
            ("/work/new/../other", "/work/other"),
        ] {
            assert_eq!(
                admitted_directory(&input.into(), Some(home))
                    .unwrap()
                    .as_str(),
                Some(expected),
                "{input}"
            );
        }
        for input in ["", "relative/project", "~other/project", "./here"] {
            assert!(
                matches!(
                    admitted_directory(&input.into(), Some(home)),
                    Err(Failure::InvalidField {
                        field: "location.directory",
                        ..
                    })
                ),
                "{input}"
            );
        }
        assert!(matches!(
            admitted_directory(&"~/app".into(), None),
            Err(Failure::InvalidField {
                field: "location.directory",
                ..
            })
        ));
    }

    #[test]
    fn a_lone_surrogate_counts_as_one_character_and_is_preserved() {
        let lone = LosslessString::from_utf16(vec![0x61, 0xd800, 0x62]);
        assert_eq!(session_title(lone.clone()).unwrap(), lone);
        let long = LosslessString::from_utf16(vec![0xd800; 121]);
        assert!(session_title(long).is_err());
    }
}
