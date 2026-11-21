use super::support::*;
use crate::dots::carrier::executor_rpc::scope_services::{catalog_project, rename_change};
use ycoding_core::{session::lifecycle::Change, ycoding_schema::LosslessString};

#[test]
fn a_session_title_reaches_the_rename_change_as_the_original_units() {
    let title: LosslessString = units("Dots · ", &[0xd800], " title");
    assert_eq!(rename_change(&title), Change::Rename(title.clone()));
    assert_ne!(
        rename_change(&title),
        Change::Rename(LosslessString::from("Dots · \u{fffd} title"))
    );
    let plain = LosslessString::from("Dots · repo");
    assert_eq!(
        rename_change(&plain),
        Change::Rename(LosslessString::from("Dots · repo"))
    );
}

#[test]
fn a_catalog_project_name_is_the_owned_schema_value_not_a_display_string() {
    let name = units("proj-", &[0xdc00], "");
    let project = catalog_project(
        LosslessString::from("id"),
        "/work/tree".into(),
        Some(name.clone()),
    );
    assert_eq!(project.name, Some(name));
    assert_eq!(
        (project.id, project.worktree),
        (LosslessString::from("id"), "/work/tree".to_string())
    );
    assert_eq!(
        catalog_project(LosslessString::from("id"), "/w".into(), None).name,
        None
    );
}
