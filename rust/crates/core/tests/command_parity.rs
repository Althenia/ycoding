use std::{
    fs,
    path::{Path, PathBuf},
};
use ycoding_core::resources::{command::Service, config::Entry};
use ycoding_schema::{command::Info, parse_json, schema::AbsolutePath};

const INITIALIZE: &str =
    include_str!("../../../../packages/core/src/plugin/command/initialize.txt");
const REVIEW: &str = include_str!("../../../../packages/core/src/plugin/command/review.txt");
const PLUGIN: &str = include_str!("../../../../packages/core/src/plugin/command.ts");

#[test]
fn command_documents_replace_template_preserve_optional_fields_and_insertion_order() {
    let entries = vec![
        Entry::Document { path: Some(PathBuf::from("/repo/ycoding.json")), info: parse_json(r#"{"commands":{"review":{"template":"old","description":"retained","agent":"reviewer","model":{"providerID":"p","model":"m","profile":"Work"},"subtask":true},"empty":{"template":""}}}"#).unwrap() },
        Entry::Document { path: Some(PathBuf::from("/repo/.ycoding/ycoding.json")), info: parse_json(r#"{"commands":{"review":{"template":"new"},"nested/docs":{"template":"docs"}}}"#).unwrap() }
    ];
    let mut service = Service::from_documents(&entries).unwrap();
    assert_eq!(
        service
            .list()
            .iter()
            .map(|c| c.name.to_utf8().unwrap())
            .collect::<Vec<_>>(),
        ["review", "empty", "nested/docs"]
    );
    let review = service.get(&"review".into()).unwrap();
    assert_eq!(review.template, "new".into());
    assert_eq!(review.description, Some("retained".into()));
    assert_eq!(review.agent, Some("reviewer".into()));
    assert_eq!(review.subtask, Some(true));
    assert_eq!(review.locations.as_ref().unwrap().len(), 2);
    assert_eq!(review.model.as_ref().unwrap().id, "m".into());
    service.update("review".into(), |c| c.name = "wrong".into());
    assert!(service.get(&"wrong".into()).is_none());
    assert_eq!(service.get(&"review".into()).unwrap().name, "review".into());
    service.remove(&"review".into());
    assert_eq!(service.list()[0].name, "empty".into());
}

#[test]
fn bundled_commands_use_reference_templates_with_the_project_directory() {
    assert!(PLUGIN.contains(".replace(\"${path}\", location.project.directory)"));
    let service =
        Service::from_project_entries(&[], Path::new("/fixture/project"), &mut Vec::new()).unwrap();
    assert_eq!(names(&service), ["init", "review"]);
    let init = service.get(&"init".into()).unwrap();
    assert!(init.template.to_utf8().unwrap().contains(
        "If `AGENTS.md` already exists at `/fixture/project`, improve it in place rather than rewriting blindly."
    ));
    assert_eq!(
        init,
        &Info {
            name: "init".into(),
            template: INITIALIZE.replacen("${path}", "/fixture/project", 1).into(),
            description: Some(reference_description("init").into()),
            agent: None,
            model: None,
            subtask: None,
            locations: None,
        }
    );
    assert_eq!(
        service.get(&"review".into()).unwrap(),
        &Info {
            name: "review".into(),
            template: REVIEW.into(),
            description: Some(reference_description("review").into()),
            agent: None,
            model: None,
            subtask: None,
            locations: None,
        }
    );
}

#[test]
fn configured_and_markdown_commands_update_bundled_commands_in_place() {
    let root =
        std::env::temp_dir().join(format!("ycoding-bundled-commands-{}", std::process::id()));
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(root.join(".ycoding/commands")).unwrap();
    let root = fs::canonicalize(root).unwrap();
    let markdown = root.join(".ycoding/commands/review.md");
    fs::write(
        &markdown,
        "---\nagent: reviewer\n---\nReview $ARGUMENTS carefully\n",
    )
    .unwrap();
    let document = root.join("ycoding.json");
    let entries = vec![
        Entry::Document {
            path: Some(document.clone()),
            info: parse_json(r#"{"commands":{"init":{"template":"custom init"},"deploy":{"template":"ship","description":"Deploy"}}}"#).unwrap(),
        },
        Entry::Directory(root.join(".ycoding")),
    ];
    let mut diagnostics = Vec::new();
    let service = Service::from_project_entries(&entries, &root, &mut diagnostics).unwrap();
    assert!(diagnostics.is_empty());
    assert_eq!(names(&service), ["init", "review", "deploy"]);
    let location = |path: &Path| AbsolutePath::new(path.to_str().unwrap()).unwrap();
    assert_eq!(
        service.get(&"init".into()).unwrap(),
        &Info {
            name: "init".into(),
            template: "custom init".into(),
            description: Some(reference_description("init").into()),
            agent: None,
            model: None,
            subtask: None,
            locations: Some(vec![location(&document)]),
        }
    );
    assert_eq!(
        service.get(&"review".into()).unwrap(),
        &Info {
            name: "review".into(),
            template: "Review $ARGUMENTS carefully".into(),
            description: Some(reference_description("review").into()),
            agent: Some("reviewer".into()),
            model: None,
            subtask: None,
            locations: Some(vec![location(&markdown)]),
        }
    );
    fs::remove_dir_all(root).unwrap();
}

fn names(service: &Service) -> Vec<String> {
    service
        .list()
        .iter()
        .map(|command| command.name.to_utf8().unwrap())
        .collect()
}

fn reference_description(name: &str) -> &'static str {
    PLUGIN
        .split_once(&format!("draft.update(\"{name}\""))
        .unwrap()
        .1
        .split_once("command.description = \"")
        .unwrap()
        .1
        .split_once('"')
        .unwrap()
        .0
}
