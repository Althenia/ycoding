use std::ops::Bound;
use ycoding_core::session::{project::InventoryQuery, store::Service};
use ycoding_schema::LosslessString;
use ycoding_store::{
    Metadata, Options, Store,
    project::{Directory, DirectoryTable, Project, ProjectTable},
    session::SessionTable,
};

#[path = "autonomy_support/mod.rs"]
mod support;

fn setup() -> (Store, Service) {
    let store = Store::disposable(
        Options::core(),
        ycoding_store::import::catalog(ycoding_store::import::DatabaseKind::Core),
        Metadata::new([19; 16], 1),
    )
    .unwrap();
    let service = Service::new(store.client());
    (store, service)
}

fn project(id: &str, worktree: &str) -> Project {
    Project {
        id: id.into(),
        worktree: worktree.into(),
        vcs: None,
        name: Some(id.into()),
        icon_url: None,
        icon_url_override: None,
        icon_color: None,
        time_created: 1,
        time_updated: 1,
        time_initialized: None,
        sandboxes: Vec::new(),
        commands: None,
    }
}

fn directory(id: &str, path: &str, time: i64) -> Directory {
    Directory {
        project_id: id.into(),
        directory: path.into(),
        type_: None,
        strategy: None,
        time_created: time,
    }
}

fn query(limit: usize) -> InventoryQuery {
    InventoryQuery {
        limit,
        search: None,
        after: None,
    }
}

#[test]
fn directories_decode_scope_strategies_timestamp_precedence_and_non_bmp_order() {
    let (store, service) = setup();
    store
        .submit(|tx| {
            ProjectTable::insert(tx, &project("prj_\u{10000}", "/other"))?;
            ProjectTable::insert(tx, &project("prj_\u{e000}", "/project"))?;
            DirectoryTable::insert(tx, &directory("prj_\u{e000}", "/\u{10000}", 1))?;
            DirectoryTable::insert(tx, &directory("prj_\u{e000}", "/\u{e000}", 1))?;
            let mut row = directory("prj_\u{e000}", "/newer", 2);
            row.strategy = Some("new/strategy".into());
            DirectoryTable::insert(tx, &row)?;
            DirectoryTable::insert(tx, &directory("prj_\u{10000}", "/unrelated", 9))
        })
        .unwrap()
        .wait()
        .unwrap();
    assert_eq!(
        service
            .project_list()
            .unwrap()
            .iter()
            .map(|row| row.id.as_lossless().to_utf8().unwrap())
            .collect::<Vec<_>>(),
        ["prj_\u{e000}", "prj_\u{10000}"]
    );
    let rows = service.project_directories(&"prj_\u{e000}".into()).unwrap();
    assert_eq!(
        rows.iter()
            .map(|row| row.directory.as_lossless().to_utf8().unwrap())
            .collect::<Vec<_>>(),
        ["/newer", "/\u{e000}", "/\u{10000}"]
    );
    assert_eq!(
        rows[0].strategy.as_ref().unwrap().as_str(),
        Some("new/strategy")
    );
    assert!(
        service
            .project_directories(&"missing-project".into())
            .unwrap()
            .is_empty()
    );
}

#[test]
fn inventory_keysets_cross_non_bmp_boundaries_in_all_three_tuple_positions() {
    let (store, service) = setup();
    store
        .submit(|tx| {
            for (id, root, paths) in [
                ("prj_a", "/\u{e000}", vec!["/\u{e000}", "/\u{10000}"]),
                ("prj_\u{10000}", "/\u{10000}", vec!["/same"]),
                ("prj_\u{e000}", "/\u{10000}", vec!["/same"]),
            ] {
                ProjectTable::insert(tx, &project(id, root))?;
                for path in paths {
                    DirectoryTable::insert(tx, &directory(id, path, 1))?;
                }
            }
            Ok(())
        })
        .unwrap()
        .wait()
        .unwrap();
    let expected = [
        ("prj_a", "/\u{e000}"),
        ("prj_a", "/\u{10000}"),
        ("prj_\u{e000}", "/same"),
        ("prj_\u{10000}", "/same"),
    ];
    let mut input = query(1);
    for (index, (id, path)) in expected.iter().enumerate() {
        let page = service.project_inventory(&input).unwrap();
        assert_eq!(page.data.len(), 1);
        assert_eq!(page.data[0].project_id.as_lossless().as_str(), Some(*id));
        assert_eq!(page.data[0].directory.as_lossless().as_str(), Some(*path));
        assert_eq!(page.next.is_some(), index + 1 < expected.len());
        input.after = page.next;
    }
    let all = service.project_inventory(&query(50)).unwrap();
    assert_eq!(all.data.len(), 4);
    assert!(all.next.is_none());
}

#[test]
fn lone_surrogates_compare_as_replacement_scalars_with_lossless_tiebreaks() {
    let (store, service) = setup();
    let paths = [
        LosslessString::from_utf16(vec![47, 0xd800]),
        LosslessString::from_utf16(vec![47, 0xdc00]),
        LosslessString::from("/\u{fffd}"),
        LosslessString::from("/\u{10000}"),
    ];
    let insert = paths.clone();
    store
        .submit(move |tx| {
            ProjectTable::insert(tx, &project("prj_lossless", "/lossless"))?;
            for path in insert.into_iter().rev() {
                DirectoryTable::insert(
                    tx,
                    &Directory {
                        directory: path,
                        ..directory("prj_lossless", "/", 1)
                    },
                )?;
            }
            Ok(())
        })
        .unwrap()
        .wait()
        .unwrap();
    let rows = service.project_directories(&"prj_lossless".into()).unwrap();
    assert_eq!(
        rows.iter()
            .map(|row| row.directory.as_lossless().clone())
            .collect::<Vec<_>>(),
        paths
    );
    let mut input = query(1);
    for path in &paths {
        let page = service.project_inventory(&input).unwrap();
        assert_eq!(page.data[0].directory.as_lossless(), path);
        input.after = page.next;
    }
    assert_eq!(
        store
            .snapshot()
            .unwrap()
            .scan::<DirectoryTable>(Bound::Unbounded, Bound::Unbounded, 10)
            .unwrap()
            .len(),
        4
    );
}

#[tokio::test]
async fn inventory_ports_recorded_session_counts_availability_search_and_forget_family() {
    let (store, service) = setup();
    let root =
        std::env::temp_dir().join(format!("ycoding-project-inventory-{}", std::process::id()));
    std::fs::create_dir_all(root.join("packages/tui")).unwrap();
    let worktree = root.to_str().unwrap().to_string();
    let copy = format!("{worktree}/.worktrees/gone");
    let package = format!("{worktree}/packages/tui");
    let seed_root = worktree.clone();
    let seed_copy = copy.clone();
    let seed_package = package.clone();
    store
        .submit(move |tx| {
            ProjectTable::insert(tx, &project("prj_alpha", &seed_root))?;
            ProjectTable::insert(tx, &project("prj_beta", "/zz-unavailable-beta"))?;
            let mut row = directory("prj_alpha", &seed_copy, 5);
            row.strategy = Some("git_worktree".into());
            DirectoryTable::insert(tx, &row)?;
            DirectoryTable::insert(tx, &directory("prj_alpha", &seed_root, 1))?;
            for (id, project, path, parent, time) in [
                ("ses_inventory_a", "prj_alpha", seed_root.as_str(), None, 2),
                (
                    "ses_inventory_child",
                    "prj_alpha",
                    seed_root.as_str(),
                    Some("ses_inventory_a"),
                    3,
                ),
                (
                    "ses_inventory_package",
                    "prj_alpha",
                    seed_package.as_str(),
                    None,
                    4,
                ),
                (
                    "ses_inventory_b",
                    "prj_beta",
                    "/zz-unavailable-beta",
                    None,
                    6,
                ),
            ] {
                let mut row = support::record(id);
                row.project_id = project.into();
                row.directory = path.into();
                row.parent_id = parent.map(Into::into);
                row.time_updated = time;
                SessionTable::insert(tx, &row)?;
            }
            Ok(())
        })
        .unwrap()
        .await
        .unwrap();
    let page = service.project_inventory(&query(50)).unwrap();
    assert_eq!(page.data.len(), 4);
    assert_eq!(page.data[0].sessions.get(), 2);
    assert_eq!(page.data[0].time_active.get(), 3);
    assert!(page.data[0].available);
    assert_eq!(
        page.data[1].directory.as_lossless().as_str(),
        Some(copy.as_str())
    );
    assert_eq!(
        page.data[1].strategy.as_ref().unwrap().as_str(),
        Some("git_worktree")
    );
    assert!(!page.data[1].available);
    let mut search = query(50);
    search.search = Some("PACKAGES/T".into());
    assert_eq!(
        service.project_inventory(&search).unwrap().data[0]
            .directory
            .as_lossless()
            .as_str(),
        Some(package.as_str())
    );
    search.search = Some("%".into());
    assert!(service.project_inventory(&search).unwrap().data.is_empty());
    assert!(
        service
            .project_forget(&"prj_alpha".into(), &worktree.into())
            .await
            .unwrap()
    );
    for id in ["ses_inventory_a", "ses_inventory_child"] {
        assert!(
            service
                .get(&ycoding_schema::session::Id::new(id).unwrap())
                .unwrap()
                .is_none()
        );
    }
    assert!(
        service
            .get(&ycoding_schema::session::Id::new("ses_inventory_b").unwrap())
            .unwrap()
            .is_some()
    );
    assert_eq!(service.project_inventory(&query(50)).unwrap().data.len(), 3);
    std::fs::remove_dir_all(root).unwrap();
}
