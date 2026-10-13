pub mod filesystem_fixture;
use filesystem_fixture::Fixture;
use std::time::Duration;
use ycoding_core::platform::filesystem::search::{Backend, GlobInput, GrepInput, Service};
use ycoding_schema::{
    filesystem::{EntryType, FindInput},
    schema::PositiveInt,
};

#[test]
fn fff_glob_grep_and_fuzzy_find_reuse_native_engine_with_relative_shapes() {
    let fixture = Fixture::new();
    fixture.repository();
    fixture.write("src/match.ts", "before\n日本 needle needle\n");
    fixture.write("src/skip.txt", "needle\n");
    let service = Service::new(&fixture.0, Backend::Fff).unwrap();
    assert!(service.wait_for_scan(Duration::from_secs(5)));
    let glob = service
        .glob(&GlobInput {
            pattern: "**/*.ts".into(),
            path: None,
            limit: None,
        })
        .unwrap();
    assert_eq!(glob.len(), 1);
    assert_eq!(
        glob[0].path.as_lossless().to_utf8().unwrap(),
        "src/match.ts"
    );
    let matches = service
        .grep(&GrepInput {
            pattern: "needle".into(),
            path: Some("src".into()),
            include: Some("*.ts".into()),
            limit: None,
        })
        .unwrap();
    assert_eq!(matches.len(), 1);
    assert_eq!(
        matches[0].entry.path.as_lossless().to_utf8().unwrap(),
        "src/match.ts"
    );
    assert_eq!(matches[0].line.get(), 2);
    assert_eq!(matches[0].offset.get(), 7);
    assert_eq!(matches[0].submatches[0].start.get(), 7);
    assert_eq!(matches[0].submatches[0].end.get(), 13);
    assert_eq!(matches[0].submatches[0].text.to_utf8().unwrap(), "needle");
    let files = service
        .find(&FindInput {
            query: "match".into(),
            r#type: Some(EntryType::File),
            limit: Some(PositiveInt::new(1).unwrap()),
        })
        .unwrap();
    assert_eq!(files.len(), 1);
    assert_eq!(
        files[0].path.as_lossless().to_utf8().unwrap(),
        "src/match.ts"
    );
    let trimmed = service
        .find(&FindInput {
            query: "\u{feff}match\u{feff}".into(),
            r#type: Some(EntryType::File),
            limit: Some(PositiveInt::new(1).unwrap()),
        })
        .unwrap();
    assert_eq!(trimmed, files);
    let dirs = service
        .find(&FindInput {
            query: "src".into(),
            r#type: Some(EntryType::Directory),
            limit: None,
        })
        .unwrap();
    assert_eq!(dirs[0].path.as_lossless().to_utf8().unwrap(), "src/");
}

#[test]
fn ripgrep_backend_uses_include_and_file_scope_and_rejects_invalid_regex() {
    let fixture = Fixture::new();
    fixture.write("src/match.ts", "needle\n");
    fixture.write("src/skip.txt", "needle\n");
    let service = Service::new(
        &fixture.0,
        Backend::Ripgrep {
            binary: "rg".into(),
        },
    )
    .unwrap();
    assert!(service.wait_for_scan(Duration::from_secs(5)));
    let glob = service
        .glob(&GlobInput {
            pattern: "**/*.ts".into(),
            path: None,
            limit: None,
        })
        .unwrap();
    assert_eq!(
        glob[0].path.as_lossless().to_utf8().unwrap(),
        "src/match.ts"
    );
    let matches = service
        .grep(&GrepInput {
            pattern: "needle".into(),
            path: None,
            include: Some("*.ts".into()),
            limit: None,
        })
        .unwrap();
    assert_eq!(matches.len(), 1);
    assert_eq!(matches[0].submatches[0].text.to_utf8().unwrap(), "needle");
    let file = service
        .grep(&GrepInput {
            pattern: "needle".into(),
            path: Some("src/skip.txt".into()),
            include: None,
            limit: None,
        })
        .unwrap();
    assert_eq!(
        file[0].entry.path.as_lossless().to_utf8().unwrap(),
        "src/skip.txt"
    );
    assert!(
        service
            .grep(&GrepInput {
                pattern: "[".into(),
                path: None,
                include: None,
                limit: None
            })
            .is_err()
    );
    assert_eq!(
        service
            .find(&FindInput {
                query: "src".into(),
                r#type: Some(EntryType::Directory),
                limit: None
            })
            .unwrap()[0]
            .path
            .as_lossless()
            .to_utf8()
            .unwrap(),
        "src/"
    );
}

#[test]
fn searches_reject_lexical_location_escapes_without_scanning_outside() {
    let fixture = Fixture::new();
    let service = Service::new(
        &fixture.0,
        Backend::Ripgrep {
            binary: "rg".into(),
        },
    )
    .unwrap();
    assert!(
        service
            .glob(&GlobInput {
                pattern: "*".into(),
                path: Some("..".into()),
                limit: None
            })
            .is_err()
    );
    assert!(
        service
            .grep(&GrepInput {
                pattern: "needle".into(),
                path: Some("..".into()),
                include: None,
                limit: None
            })
            .is_err()
    );
}

#[test]
fn native_initialization_failure_keeps_an_empty_search_service() {
    let service = Service::new(std::path::Path::new("/"), Backend::Fff).unwrap();
    assert!(service.wait_for_scan(Duration::from_secs(1)));
    assert!(
        service
            .find(&FindInput {
                query: "any".into(),
                r#type: None,
                limit: None,
            })
            .unwrap()
            .is_empty()
    );
    assert!(
        service
            .glob(&GlobInput {
                pattern: "**/*".into(),
                path: None,
                limit: None,
            })
            .unwrap()
            .is_empty()
    );
    assert!(
        service
            .grep(&GrepInput {
                pattern: "any".into(),
                path: None,
                include: None,
                limit: None,
            })
            .unwrap()
            .is_empty()
    );
}
