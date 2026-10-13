use crate::{
    convert,
    dispatch::{Failure, Invocation},
    platform_services,
};
use ycoding_core::ycoding_schema::{DomainDecode, JsonValue, schema::NonNegativeInt, shell};
use ycoding_protocol::v5;

fn failure(id: &v5::LosslessString, error: std::io::Error) -> Failure {
    if error.kind() == std::io::ErrorKind::NotFound {
        return Failure::ShellNotFound(convert::readable(&convert::domain(id).unwrap_or_default()));
    }
    platform_services::io(error)
}

fn info(info: &shell::Info) -> Result<v5::ShellInfo, Failure> {
    Ok(v5::ShellInfo {
        id: convert::identity(&info.id)?,
        command: convert::wire(&info.command),
        cwd: convert::wire(&info.cwd),
        shell: convert::wire(&info.shell),
        file: convert::wire(&info.file),
        status: match info.status {
            shell::Status::Running => v5::ShellInfoStatus::Running,
            shell::Status::Exited => v5::ShellInfoStatus::Exited,
            shell::Status::Timeout => v5::ShellInfoStatus::Timeout,
            shell::Status::MemoryLimit => v5::ShellInfoStatus::MemoryLimit,
            shell::Status::Killed => v5::ShellInfoStatus::Killed,
        } as i32,
        pid: info.pid.map(|value| value.get() as u64),
        exit: info.exit.map(|value| value.get()),
        metadata: v5::ShellInfoMetadata {
            entries: info
                .metadata
                .iter()
                .map(|(key, value)| v5::ShellInfoMetadataEntry {
                    key: convert::wire(key),
                    value: convert::json_to_value(value),
                })
                .collect(),
        },
        tool_call_id: info.tool_call_id.as_ref().map(convert::wire),
        time: v5::ShellInfoTime {
            started: info.time.started.get(),
            completed: info.time.completed.map(|value| value.get()),
        },
    })
}

pub async fn create(
    invocation: Invocation,
    request: v5::ShellCreateRequest,
) -> Result<v5::ShellCreateResult, Failure> {
    let query = request.query.location.as_ref();
    let (location, services) = platform_services::resolve(
        &invocation,
        query.and_then(|q| q.directory.as_ref()),
        query.and_then(|q| q.workspace.as_ref()),
    )?;
    let input = shell::CreateInput {
        command: convert::domain(&request.payload.command)?,
        cwd: Some(platform_services::cwd(
            &services,
            request.payload.cwd.as_ref(),
        )?),
        timeout: NonNegativeInt::new(request.payload.timeout as i64)
            .map_err(|error| Failure::Invalid(error.to_string()))?,
        memory_limit_mb: request
            .payload
            .memory_limit_mb
            .map(|value| shell::MemoryLimitMb::decode(&JsonValue::Number(value as f64)))
            .transpose()
            .map_err(|error| Failure::Invalid(error.to_string()))?,
        metadata: request
            .payload
            .metadata
            .map(|value| {
                convert::object_domain(value.entries.iter().map(|entry| (&entry.key, &entry.value)))
            })
            .transpose()?,
    };
    let mut prepared = services
        .shell
        .prepare(input, &services.config)
        .map_err(|error| {
            if error.kind() == std::io::ErrorKind::Unsupported {
                let message = error.to_string();
                return Failure::ServiceUnavailable {
                    service: if message.contains("memory") {
                        "shell-memory"
                    } else {
                        "shell-sandbox"
                    },
                    message,
                };
            }
            platform_services::io(error)
        })?;
    Ok(v5::ShellCreateResult {
        location: convert::location_info(&location),
        data: info(
            &services
                .shell
                .create(&mut prepared)
                .await
                .map_err(platform_services::io)?,
        )?,
    })
}

pub async fn list(
    invocation: Invocation,
    request: v5::ShellListRequest,
) -> Result<v5::ShellListResult, Failure> {
    let q = request.query.location.as_ref();
    let (location, services) = platform_services::resolve(
        &invocation,
        q.and_then(|q| q.directory.as_ref()),
        q.and_then(|q| q.workspace.as_ref()),
    )?;
    Ok(v5::ShellListResult {
        location: convert::location_info(&location),
        data: v5::ShellListResultData {
            items: services
                .shell
                .list()
                .iter()
                .map(info)
                .collect::<Result<_, _>>()?,
        },
    })
}

pub async fn get(
    invocation: Invocation,
    request: v5::ShellGetRequest,
) -> Result<v5::ShellGetResult, Failure> {
    let q = request.query.location.as_ref();
    let (location, services) = platform_services::resolve(
        &invocation,
        q.and_then(|q| q.directory.as_ref()),
        q.and_then(|q| q.workspace.as_ref()),
    )?;
    Ok(v5::ShellGetResult {
        location: convert::location_info(&location),
        data: info(
            &services
                .shell
                .get(&convert::identifier(&request.params.id)?)
                .await
                .map_err(|error| failure(&request.params.id, error))?,
        )?,
    })
}

pub async fn timeout(
    invocation: Invocation,
    request: v5::ShellTimeoutRequest,
) -> Result<v5::ShellTimeoutResult, Failure> {
    let q = request.query.location.as_ref();
    let (location, services) = platform_services::resolve(
        &invocation,
        q.and_then(|q| q.directory.as_ref()),
        q.and_then(|q| q.workspace.as_ref()),
    )?;
    let id = convert::identifier(&request.params.id)?;
    services
        .shell
        .timeout(&id, request.payload.timeout)
        .await
        .map_err(|error| failure(&request.params.id, error))?;
    Ok(v5::ShellTimeoutResult {
        location: convert::location_info(&location),
        data: info(
            &services
                .shell
                .get(&id)
                .await
                .map_err(|error| failure(&request.params.id, error))?,
        )?,
    })
}

pub async fn output(
    invocation: Invocation,
    request: v5::ShellOutputRequest,
) -> Result<v5::ShellOutputResult, Failure> {
    let q = request.query.location.as_ref();
    let (location, services) = platform_services::resolve(
        &invocation,
        q.and_then(|q| q.directory.as_ref()),
        q.and_then(|q| q.workspace.as_ref()),
    )?;
    let page = services
        .shell
        .output(
            &convert::identifier(&request.params.id)?,
            request.query.cursor.unwrap_or(0) as usize,
            request.query.limit.unwrap_or(65536) as usize,
        )
        .await
        .map_err(|error| failure(&request.params.id, error))?;
    Ok(v5::ShellOutputResult {
        location: Some(convert::location_info(&location)),
        data: v5::ShellOutputResultData {
            output: convert::text(&page.output),
            cursor: page.cursor as u64,
            size: page.size as u64,
            truncated: page.truncated,
        },
    })
}

pub async fn remove(
    invocation: Invocation,
    request: v5::ShellRemoveRequest,
) -> Result<v5::ShellRemoveResult, Failure> {
    let q = request.query.location.as_ref();
    let (_, services) = platform_services::resolve(
        &invocation,
        q.and_then(|q| q.directory.as_ref()),
        q.and_then(|q| q.workspace.as_ref()),
    )?;
    services
        .shell
        .remove(&convert::identifier(&request.params.id)?)
        .await
        .map_err(|error| failure(&request.params.id, error))?;
    Ok(v5::ShellRemoveResult { data: v5::Empty {} })
}
