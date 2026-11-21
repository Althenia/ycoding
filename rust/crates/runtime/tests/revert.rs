mod support;

use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
    sync::Arc,
    time::Duration,
};
use support::{wire::*, *};
use ycoding_core::platform::git;
use ycoding_core::session::{revert::Snapshots, snapshot::GitSnapshots};
use ycoding_protocol::v5;

async fn bounded<F: std::future::Future>(future: F) -> F::Output {
    tokio::time::timeout(Duration::from_secs(120), future)
        .await
        .expect("test exceeded its time bound")
}

fn git(directory: &Path, args: &[&str]) {
    let output = Command::new("git")
        .args([
            "-c",
            "core.fsmonitor=false",
            "-c",
            "user.email=test@ycoding.test",
            "-c",
            "user.name=Test",
            "-c",
            "commit.gpgsign=false",
        ])
        .args(args)
        .current_dir(directory)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
}

fn assistant(range: Option<&str>) -> String {
    format!(
        r#"{{"time":{{"created":1}},"agent":"build","model":{{"providerID":"local","id":"test"}},"content":[]{}}}"#,
        range.map_or(String::new(), |range| format!(r#","snapshot":{range}"#))
    )
}

fn stage(session: &str, message: &str, files: Option<bool>) -> v5::SessionRevertStageRequest {
    v5::SessionRevertStageRequest {
        params: v5::SessionRevertStageRequestParams {
            session_id: text(session),
        },
        payload: v5::SessionRevertStageRequestPayload {
            message_id: text(message),
            files,
        },
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn staging_restores_the_project_files_and_clearing_puts_them_back() {
    bounded(async {
        let root = PathBuf::from(env!("CARGO_TARGET_TMPDIR"))
            .join(format!("runtime-revert-{}", std::process::id()));
        let repository = root.join("project");
        fs::create_dir_all(&repository).unwrap();
        let repository = fs::canonicalize(repository).unwrap();
        git(&repository, &["init", "-q"]);
        fs::write(repository.join("a.txt"), "one").unwrap();
        git(&repository, &["add", "."]);
        git(&repository, &["commit", "-q", "-m", "initial"]);
        let path = repository.to_str().unwrap();
        insert_project("prj_revert", path).await;
        insert_session_of("prj_revert", "ses_revert", path, None).await;
        let before = GitSnapshots::new(
            Arc::new(git::Service::new(16 * 1024 * 1024)),
            snapshot_data(),
            "prj_revert".into(),
            repository.clone(),
            repository.clone(),
            true,
        )
        .capture()
        .expect("the project is snapshotted before the agent edits it");
        fs::write(repository.join("a.txt"), "two").unwrap();
        insert_message(
            "ses_revert",
            "msg_rv_boundary",
            "assistant",
            1,
            &assistant(None),
        )
        .await;
        insert_message(
            "ses_revert",
            "msg_rv_later",
            "assistant",
            2,
            &assistant(Some(&format!(
                r#"{{"start":"{}","files":["a.txt"]}}"#,
                before.as_lossless().to_utf8().unwrap()
            ))),
        )
        .await;

        let (server, mut client) = open().await;
        let scope = session_scope("ses_revert");
        let staged: v5::SessionRevertStageResult = ask(
            &mut client,
            "session.revert.stage",
            scope.clone(),
            stage("ses_revert", "msg_rv_boundary", None),
        )
        .await;
        assert_eq!(units(&staged.data.message_id), "msg_rv_boundary");
        assert!(staged.data.snapshot.is_some());
        let diffs = staged.data.files.as_ref().expect("file diffs are reported");
        assert_eq!(diffs.items.len(), 1);
        assert_eq!(units(&diffs.items[0].file), "a.txt");
        assert_eq!(fs::read_to_string(repository.join("a.txt")).unwrap(), "one");

        let get = || v5::SessionGetRequest {
            params: v5::SessionGetRequestParams {
                session_id: text("ses_revert"),
            },
        };
        let staged_session: v5::SessionGetResult =
            ask(&mut client, "session.get", scope.clone(), get()).await;
        assert_eq!(
            units(&staged_session.data.revert.unwrap().message_id),
            "msg_rv_boundary"
        );

        let missing: v5::MessageNotFoundError = refuse(
            &mut client,
            "session.revert.stage",
            scope.clone(),
            stage("ses_revert", "msg_rv_missing", None),
        )
        .await;
        assert_eq!(units(&missing.message_id), "msg_rv_missing");
        let unknown: v5::SessionNotFoundError = refuse(
            &mut client,
            "session.revert.stage",
            session_scope("ses_revert_missing"),
            stage("ses_revert_missing", "msg_rv_boundary", None),
        )
        .await;
        assert_eq!(units(&unknown.session_id), "ses_revert_missing");
        let _: v5::SessionRevertClearResult = ask(
            &mut client,
            "session.revert.clear",
            scope.clone(),
            v5::SessionRevertClearRequest {
                params: v5::SessionRevertClearRequestParams {
                    session_id: text("ses_revert"),
                },
            },
        )
        .await;
        assert_eq!(fs::read_to_string(repository.join("a.txt")).unwrap(), "two");
        let cleared_session: v5::SessionGetResult =
            ask(&mut client, "session.get", scope.clone(), get()).await;
        assert!(cleared_session.data.revert.is_none());

        server.shutdown().await.unwrap();
        fs::remove_dir_all(root).unwrap();
    })
    .await;
}
