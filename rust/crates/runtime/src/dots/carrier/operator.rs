use super::supervisor;
use std::{io, path::PathBuf};

#[cfg(test)]
#[path = "operator_tests.rs"]
mod tests;

const SKILL: &str =
    include_str!("../../../../../../packages/cli/src/remote-control/ycoding-operator.md");

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

async fn ensure(data: PathBuf) -> io::Result<()> {
    let file = data
        .join("dots")
        .join("skills")
        .join("ycoding-operator")
        .join("SKILL.md");
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
