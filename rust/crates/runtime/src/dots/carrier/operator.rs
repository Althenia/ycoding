use super::supervisor;
use std::{io, path::PathBuf};

#[cfg(test)]
#[path = "operator_tests.rs"]
mod tests;

const SKILL: &str =
    include_str!("../../../../../../packages/cli/src/remote-control/session-operator.md");

pub(super) fn prepare(data: PathBuf, next: supervisor::Prepare) -> supervisor::Prepare {
    Box::new(move || {
        let future: supervisor::Boxed<Result<(), supervisor::PrepareError>> =
            Box::pin(async move {
                ensure(data)
                    .await
                    .map_err(|_| supervisor::PrepareError::Held {
                        reason: "operator skill provisioning failed",
                    })?;
                (next)().await
            });
        future
    })
}

const REPLACED: &str = "ycoding-operator";

async fn remove_replaced(skills: &std::path::Path) -> io::Result<()> {
    let directory = skills.join(REPLACED);
    match tokio::fs::remove_file(directory.join("SKILL.md")).await {
        Err(error) if error.kind() != io::ErrorKind::NotFound => return Err(error),
        _ => {}
    }
    match tokio::fs::remove_dir(&directory).await {
        Err(error)
            if !matches!(
                error.kind(),
                io::ErrorKind::NotFound | io::ErrorKind::DirectoryNotEmpty
            ) =>
        {
            Err(error)
        }
        _ => Ok(()),
    }
}

async fn ensure(data: PathBuf) -> io::Result<()> {
    let skills = data.join("dots").join("skills");
    remove_replaced(&skills).await?;
    let file = skills.join("session-operator").join("SKILL.md");
    let current = match tokio::fs::read(&file).await {
        Ok(bytes) => Some(bytes),
        Err(error) if error.kind() == io::ErrorKind::NotFound => None,
        Err(error) => return Err(error),
    };
    if current.as_deref() == Some(SKILL.as_bytes()) {
        return Ok(());
    }
    if let Some(parent) = file.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    tokio::fs::write(&file, SKILL).await
}
