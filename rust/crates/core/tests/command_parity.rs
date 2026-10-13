use std::path::PathBuf;
use ycoding_core::resources::{command::Service, config::Entry};
use ycoding_schema::parse_json;

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
