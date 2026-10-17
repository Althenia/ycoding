mod support;

use std::{collections::BTreeMap, path::Path, time::Duration};
use tokio::time::timeout;
use ycoding_core::{
    job::StartInput,
    resources::{catalog::models_dev, config},
    session::autonomy::YoloLevel,
    tools::context::Context,
    ycoding_schema::{parse_json, session, stringify_json},
    ycoding_store::{
        KeyPart, Metadata, Options, Store, project,
        session::{Document, EventTable, SessionTable, Task, TaskTable},
        tuple_key,
    },
};
use ycoding_runtime::{Core, Production};

const MODELS: &str = r#"{"openai":{"id":"openai","name":"OpenAI","api":"http://127.0.0.1:1","env":["OPENAI_API_KEY"],"npm":"@ai-sdk/openai-compatible","models":{"gpt-runtime":{"id":"gpt-runtime","name":"Runtime","release_date":"2026-01-01","attachment":false,"reasoning":false,"tool_call":true,"limit":{"context":128000,"output":8192},"cost":{"input":2,"output":3}}}}}"#;

const EAGER_PARENT: &str = "ses_eager_parent";
const QUIET_CHILD: &str = "ses_quiet_child";
const QUIET_PARENT: &str = "ses_quiet_parent";
const EAGER_CHILD: &str = "ses_eager_child";

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn subagent_report_auto_answers_by_the_asking_childs_own_toggle_not_its_parents() {
    timeout(Duration::from_secs(60), flow()).await.unwrap();
}

async fn flow() {
    let root = std::env::temp_dir().join(format!(
        "subagent-auto-answer-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let roots = config::Roots::development(&root).unwrap();
    roots.initialize().unwrap();
    let eager = root.join("eager");
    let quiet = root.join("quiet");
    for (directory, configuration) in [(&eager, "{}"), (&quiet, "{}")] {
        std::fs::create_dir_all(directory).unwrap();
        std::fs::write(directory.join("ycoding.json"), configuration).unwrap();
    }
    std::fs::write(roots.config.join("ycoding.json"), "{}").unwrap();
    let store = Store::initialize(
        root.join("store.redb"),
        Options::core(),
        ycoding_core::ycoding_store::import::catalog(
            ycoding_core::ycoding_store::import::DatabaseKind::Core,
        ),
        Metadata::new([9; 16], 1),
    )
    .unwrap();
    let placed = [
        (EAGER_PARENT, &eager, None),
        (QUIET_CHILD, &quiet, Some(EAGER_PARENT)),
        (QUIET_PARENT, &quiet, None),
        (EAGER_CHILD, &eager, Some(QUIET_PARENT)),
    ]
    .map(|(id, directory, parent)| (id, text(directory), parent));
    let projects = [("prj_eager", text(&eager)), ("prj_quiet", text(&quiet))];
    let rows = placed.clone();
    store
        .submit(move |tx| {
            for (id, worktree) in &projects {
                project::ProjectTable::insert(
                    tx,
                    &project::Project {
                        id: (*id).into(),
                        worktree: worktree.as_str().into(),
                        vcs: None,
                        name: None,
                        icon_url: None,
                        icon_url_override: None,
                        icon_color: None,
                        time_created: 1,
                        time_updated: 1,
                        time_initialized: None,
                        sandboxes: vec![],
                        commands: None,
                    },
                )?;
            }
            for (id, directory, parent) in &rows {
                let mut row = support::record(id);
                row.project_id = projects
                    .iter()
                    .find(|(_, worktree)| worktree == directory)
                    .unwrap()
                    .0
                    .into();
                row.directory = directory.as_str().into();
                row.parent_id = parent.map(Into::into);
                row.time_updated = now();
                SessionTable::insert(tx, &row)?;
            }
            Ok(())
        })
        .unwrap()
        .wait()
        .unwrap();
    let core = Core::production(
        store.client(),
        Production {
            analytics: roots.data.join("analytics"),
            configuration: config::LoadOptions {
                directory: eager.clone(),
                roots: roots.clone(),
                project: true,
                file: None,
                content: None,
                env: BTreeMap::new(),
            },
            catalog: models_dev::Options {
                source: "https://models.dev".into(),
                cache: roots.cache.join("models.json"),
                file: None,
                bundled: Some(parse_json(MODELS).unwrap()),
                fetch: false,
                user_agent: "ycoding-test".into(),
            },
            cursor: None,
            steer: None,
            ripgrep: "rg".into(),
            meeting: false,
        },
    )
    .await
    .unwrap();
    for parent in [EAGER_PARENT, QUIET_PARENT] {
        core.autonomy
            .set_yolo(&id(parent), YoloLevel::GUARDRAILS)
            .await
            .unwrap();
    }
    for (session, enabled) in [
        (EAGER_PARENT, true),
        (EAGER_CHILD, true),
        (QUIET_PARENT, false),
    ] {
        core.autonomy
            .set_auto_answer(&id(session), enabled)
            .await
            .unwrap();
    }
    let tasks = placed
        .iter()
        .filter_map(|(child, _, parent)| parent.map(|parent| running_task(child, parent)))
        .collect::<Vec<_>>();
    store
        .submit(move |tx| tasks.iter().try_for_each(|task| TaskTable::put(tx, task)))
        .unwrap()
        .wait()
        .unwrap();
    core.execution
        .jobs()
        .start(StartInput {
            id: Some(QUIET_CHILD.into()),
            kind: "subagent".into(),
            title: None,
            metadata: None,
            run: Box::pin(std::future::pending()),
        })
        .unwrap();

    report(
        &core,
        QUIET_CHILD,
        "Which branch should the quiet child use?",
    )
    .await;
    assert!(
        question_pending(&store, QUIET_CHILD),
        "a child without its own auto-answer toggle must ask its parent even when the parent enables auto-answer"
    );
    assert!(!parent_answer_admitted(&store, QUIET_CHILD));
    assert!(core.execution.jobs().cancel(QUIET_CHILD).await.is_some());

    report(
        &core,
        EAGER_CHILD,
        "Which branch should the eager child use?",
    )
    .await;
    assert!(
        !question_pending(&store, EAGER_CHILD),
        "a child with its own auto-answer toggle must not wait on its parent"
    );
    assert!(
        parent_answer_admitted(&store, EAGER_CHILD),
        "a child with its own auto-answer toggle receives the automatic parent answer even when the parent disables auto-answer"
    );

    core.shutdown().await.unwrap();
}

async fn report(core: &Core, child: &str, question: &str) {
    let (_, services) = core.locations.session(&id(child)).unwrap();
    let agent = services.agents.default().unwrap();
    let settlement = services
        .production
        .as_ref()
        .unwrap()
        .tools
        .materialize(&agent.permissions)
        .invoke(
            "subagent_report",
            parse_json(&format!(r#"{{"action":"question","text":"{question}"}}"#)).unwrap(),
            Context::new(
                child,
                agent.id.as_str().unwrap(),
                &format!("msg_{child}_report"),
                &format!("call_{child}_report"),
            )
            .unwrap(),
        )
        .await
        .unwrap();
    assert!(settlement.error.is_none(), "{:?}", settlement.error);
}

fn running_task(child: &str, parent: &str) -> Task {
    Task {
        session_id: child.into(),
        parent_id: parent.into(),
        parent_assistant_message_id: format!("msg_{child}_launch").as_str().into(),
        tool_call_id: format!("call_{child}_launch").as_str().into(),
        input_id: format!("msg_{child}_input").as_str().into(),
        description: "Explore".into(),
        agent: "build".into(),
        model: Document::new(parse_json(r#"{"providerID":"openai","id":"gpt-runtime"}"#).unwrap())
            .unwrap(),
        prompt_digest: "d".repeat(64).as_str().into(),
        background: 1,
        delivery: "steer".into(),
        state: "running".into(),
        progress: None,
        progress_time: None,
        question_id: None,
        question: None,
        question_data: None,
        question_time: None,
        attempt_started: now(),
        owner_pid: None,
        owner_started: None,
        revision: 0,
        time_created: now(),
        time_updated: now(),
        usage_anchor: None,
    }
}

fn question_pending(store: &Store, child: &str) -> bool {
    store
        .snapshot()
        .unwrap()
        .get::<TaskTable>(&tuple_key(&[KeyPart::String(&child.into())]))
        .unwrap()
        .unwrap()
        .question_id
        .is_some()
}

fn parent_answer_admitted(store: &Store, child: &str) -> bool {
    store
        .snapshot()
        .unwrap()
        .scan::<EventTable>(
            std::ops::Bound::Unbounded,
            std::ops::Bound::Unbounded,
            usize::MAX,
        )
        .unwrap()
        .into_iter()
        .any(|event| {
            event.aggregate_id.as_str() == Some(child)
                && event.type_.as_str() == Some("session.input.admitted.1")
                && stringify_json(&event.data).contains("subagent_parent")
        })
}

fn id(value: &str) -> session::Id {
    session::Id::new(value).unwrap()
}

fn text(path: &Path) -> String {
    path.to_str().unwrap().to_owned()
}

fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64
}
