use std::{
    io::{self, Read, Write},
    path::PathBuf,
};
use ycoding_core::{
    resources::{
        memory::{Error, Limits, Options, Repository, Scope, Search, Service},
        skill,
    },
    tools::builtin::memory::{listing_output, read_output, search_output},
    ycoding_schema::{
        DomainEncode, JsonPath, JsonValue, LosslessString, ObjectDecoder, ObjectEncoder,
        parse_json, skill::Source, stringify_json,
    },
};

const LIMIT: usize = 16 * 1024 * 1024;

pub fn run() -> io::Result<()> {
    let mut input = Vec::new();
    io::stdin()
        .lock()
        .take((LIMIT + 1) as u64)
        .read_to_end(&mut input)?;
    let result = if input.len() > LIMIT {
        Err(Error::TooLarge)
    } else {
        std::str::from_utf8(&input)
            .ok()
            .and_then(|text| parse_json(text).ok())
            .ok_or(Error::InvalidConcept)
            .and_then(dispatch)
    };
    let output = match result {
        Ok(value) => stringify_json(
            &ObjectEncoder::new()
                .field("ok", &true)
                .field("value", &value)
                .finish(),
        ),
        Err(error) => failure(error),
    };
    let output = if output.len() > LIMIT {
        failure(Error::TooLarge)
    } else {
        output
    };
    io::stdout().lock().write_all(output.as_bytes())
}

fn failure(error: Error) -> String {
    let code = match error {
        Error::InvalidYaml | Error::UnterminatedFrontmatter => "InvalidConcept".into(),
        other => format!("{other:?}"),
    };
    stringify_json(
        &ObjectEncoder::new()
            .field("ok", &false)
            .field("code", &LosslessString::from(code))
            .finish(),
    )
}

fn dispatch(input: JsonValue) -> Result<JsonValue, Error> {
    let root = JsonPath::default();
    let request = object(&input, &root)?;
    match text(&request, "operation")?.as_str() {
        "memory" => read_memory(&request, &root),
        "skill" => {
            let sources: Vec<Source> = request
                .field("sources")
                .map_err(|_| Error::InvalidConcept)?;
            if sources
                .iter()
                .any(|source| matches!(source, Source::Url(_)))
            {
                return Err(Error::InvalidConcept);
            }
            let runtime = tokio::runtime::Builder::new_current_thread().build()?;
            let skills = runtime
                .block_on(skill::Service::list_resolved(sources))
                .map_err(|_| Error::Unavailable)?;
            Ok(skills.encode())
        }
        _ => Err(Error::InvalidConcept),
    }
}

fn read_memory(request: &ObjectDecoder<'_>, root: &JsonPath) -> Result<JsonValue, Error> {
    let action = text(request, "action")?;
    if !matches!(action.as_str(), "list" | "read" | "search") {
        return Err(Error::InvalidConcept);
    }
    let scope = match text(request, "scope")?.as_str() {
        "repository" => Scope::Repository,
        "knowledge" => Scope::Knowledge,
        _ => return Err(Error::InvalidConcept),
    };
    let approved = absolute(request, "approvedRoot")?;
    let limits: JsonValue = request.field("limits").map_err(|_| Error::InvalidConcept)?;
    let limits_path = root.key("limits");
    let limits = object(&limits, &limits_path)?;
    let repository: Option<JsonValue> = request
        .optional("repository")
        .map_err(|_| Error::InvalidConcept)?;
    let repository_path = root.key("repository");
    let repository = repository
        .as_ref()
        .map(|value| -> Result<Repository, Error> {
            let value = object(value, &repository_path)?;
            let worktrees: Vec<LosslessString> = value
                .field("worktrees")
                .map_err(|_| Error::InvalidConcept)?;
            let worktrees = worktrees.iter().map(path).collect::<Result<_, _>>()?;
            Ok(Repository {
                directory: absolute(&value, "directory")?,
                common_directory: absolute(&value, "commonDirectory")?,
                worktrees,
            })
        })
        .transpose()?;
    let service = Service::new(Options {
        directory: absolute(request, "directory")?,
        home: absolute(request, "home")?,
        data: absolute(request, "data")?,
        repository,
        limits: Limits {
            enabled: limits.field("enabled").map_err(|_| Error::InvalidConcept)?,
            path: optional_text(&limits, "path")?,
            max_concept_bytes: number(&limits, "max_concept_bytes")?
                .ok_or(Error::InvalidConcept)?,
            max_bundle_bytes: number(&limits, "max_bundle_bytes")?.ok_or(Error::InvalidConcept)?,
            max_concepts: number(&limits, "max_concepts")?.ok_or(Error::InvalidConcept)?,
        },
    })?;
    let state = service.status(scope)?;
    if state.root.as_os_str() != approved.as_os_str() {
        return Err(Error::UnsafePath);
    }
    match action.as_str() {
        "list" => service
            .list_at(
                &state,
                number(request, "limit")?,
                number(request, "offset")?,
            )
            .map(listing_output),
        "read" => service
            .read_at(&state, &text(request, "id")?)
            .map(read_output),
        "search" => service
            .search_at(
                &state,
                Search {
                    query: &text(request, "query")?,
                    limit: number(request, "limit")?,
                    type_: optional_text(request, "type")?.as_deref(),
                    tag: optional_text(request, "tag")?.as_deref(),
                },
            )
            .map(search_output),
        _ => unreachable!(),
    }
}

fn object<'a>(value: &'a JsonValue, path: &'a JsonPath) -> Result<ObjectDecoder<'a>, Error> {
    ObjectDecoder::new(value, path).map_err(|_| Error::InvalidConcept)
}

fn text(object: &ObjectDecoder<'_>, key: &str) -> Result<String, Error> {
    optional_text(object, key)?.ok_or(Error::InvalidConcept)
}

fn optional_text(object: &ObjectDecoder<'_>, key: &str) -> Result<Option<String>, Error> {
    object
        .optional::<LosslessString>(key)
        .map_err(|_| Error::InvalidConcept)?
        .map(|value| {
            value
                .as_str()
                .map(str::to_owned)
                .ok_or(Error::InvalidConcept)
        })
        .transpose()
}

fn number(object: &ObjectDecoder<'_>, key: &str) -> Result<Option<usize>, Error> {
    object
        .optional::<f64>(key)
        .map_err(|_| Error::InvalidConcept)?
        .map(|value| {
            if !(0.0..=9_007_199_254_740_991.0).contains(&value) || value.fract() != 0.0 {
                return Err(Error::InvalidConcept);
            }
            usize::try_from(value as u64).map_err(|_| Error::InvalidConcept)
        })
        .transpose()
}

fn absolute(object: &ObjectDecoder<'_>, key: &str) -> Result<PathBuf, Error> {
    path(&object.field(key).map_err(|_| Error::InvalidConcept)?)
}

fn path(value: &LosslessString) -> Result<PathBuf, Error> {
    let path = PathBuf::from(value.as_str().ok_or(Error::UnsafePath)?);
    if !path.is_absolute() {
        return Err(Error::UnsafePath);
    }
    Ok(path)
}
