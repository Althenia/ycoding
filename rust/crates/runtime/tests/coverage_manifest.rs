use std::{
    collections::{BTreeMap, BTreeSet, HashSet},
    fs,
    path::PathBuf,
};
use ycoding_protocol::{OPERATION_IDS_BY_ROLE, OPERATIONS, PUBLIC_EVENTS, v5};

fn root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..")
}

fn expand(cell: &str) -> Vec<String> {
    let mut output = Vec::new();
    for token in cell.split('`').skip(1).step_by(2) {
        if let (Some(open), Some(close)) = (token.find(".{"), token.rfind('}')) {
            output.extend(
                token[open + 2..close]
                    .split(',')
                    .map(|suffix| format!("{}.{}", &token[..open], suffix)),
            );
            continue;
        }
        if token
            .chars()
            .next()
            .is_some_and(|letter| letter.is_ascii_alphabetic())
            && token.contains('.')
            && token
                .chars()
                .all(|letter| letter.is_ascii_alphanumeric() || matches!(letter, '.' | '-'))
        {
            output.push(token.to_owned());
        }
    }
    output
}

fn allocations() -> Vec<(String, String)> {
    let spec = fs::read_to_string(root().join("specs/wire-connector.md")).unwrap();
    spec.split("## Remote admission obligations")
        .next()
        .unwrap()
        .lines()
        .filter(|line| line.starts_with("| "))
        .map(|line| {
            line.split('|')
                .skip(1)
                .map(|cell| cell.trim().to_owned())
                .collect::<Vec<_>>()
        })
        .filter(|cells| {
            cells
                .get(2)
                .is_some_and(|id| id.chars().all(|letter| letter.is_ascii_digit()))
        })
        .map(|cells| (cells[0].clone(), cells[1].clone()))
        .collect()
}

#[test]
fn test_057_every_descriptor_member_has_exactly_one_coverage_class() {
    assert_eq!(OPERATIONS.len(), 231);
    let mut ids = HashSet::new();
    let mut names = HashSet::new();
    let mut classes: BTreeMap<&str, Vec<&str>> = BTreeMap::new();
    for operation in OPERATIONS.iter() {
        assert!(ids.insert(operation.operation_id));
        assert!(names.insert(operation.diagnostic_name.as_str()));
        let class = if operation.diagnostic_name.starts_with("notice.") {
            assert_eq!(
                operation.roles,
                [v5::PeerRole::RemoteClient as i32],
                "{}",
                operation.diagnostic_name
            );
            "notice"
        } else if operation.roles.contains(&(v5::PeerRole::Relay as i32)) {
            assert!(
                operation
                    .roles
                    .contains(&(v5::PeerRole::RemoteClient as i32)),
                "{} is relay-forwardable without a remote originator",
                operation.diagnostic_name
            );
            "connector"
        } else {
            assert_eq!(
                operation.roles,
                [v5::PeerRole::LocalClient as i32],
                "{}",
                operation.diagnostic_name
            );
            "local"
        };
        classes
            .entry(class)
            .or_default()
            .push(&operation.diagnostic_name);
    }
    assert_eq!(classes["local"].len(), 152);
    assert_eq!(classes["connector"].len(), 75);
    let mut notices = classes["notice"].clone();
    notices.sort();
    assert_eq!(
        notices,
        [
            "notice.list",
            "notice.read",
            "notice.readAll",
            "notice.subscribe"
        ]
    );
    for (role, role_ids) in OPERATION_IDS_BY_ROLE {
        let expected: Vec<u32> = OPERATIONS
            .iter()
            .filter(|operation| operation.roles.contains(role))
            .map(|operation| operation.operation_id)
            .collect();
        assert_eq!(*role_ids, expected, "role {role}");
    }
}

#[test]
fn test_057_wire_connector_allocations_cover_the_remote_descriptor_set() {
    let allocations = allocations();
    assert_eq!(allocations.len(), 83);
    let sources: BTreeSet<&str> = allocations
        .iter()
        .map(|(source, _)| source.as_str())
        .collect();
    assert_eq!(sources.len(), 83, "every source name is allocated once");
    let diagnostics: BTreeSet<&str> = allocations.iter().map(|(_, name)| name.as_str()).collect();
    let remote: BTreeSet<&str> = OPERATIONS
        .iter()
        .filter(|operation| {
            operation
                .roles
                .contains(&(v5::PeerRole::RemoteClient as i32))
        })
        .map(|operation| operation.diagnostic_name.as_str())
        .collect();
    assert_eq!(
        diagnostics, remote,
        "source allocations must map onto the live remote descriptors"
    );
    for (_, name) in &allocations {
        assert_eq!(
            OPERATIONS
                .iter()
                .filter(|operation| &operation.diagnostic_name == name)
                .count(),
            1,
            "{name} must resolve to exactly one descriptor"
        );
    }
    let inventory = fs::read_to_string(root().join("specs/wire-operation-inventory.md")).unwrap();
    let remote_section = inventory
        .split("## Complete Remote Operation Inventory")
        .nth(1)
        .unwrap()
        .split("### Relay-owned notice operations")
        .next()
        .unwrap();
    let mut inventory_sources: Vec<String> = remote_section
        .lines()
        .filter(|line| line.starts_with("| `"))
        .flat_map(|line| expand(line.split('|').nth(1).unwrap()))
        .collect();
    let notice_section = inventory
        .split("### Relay-owned notice operations")
        .nth(1)
        .unwrap()
        .split("## Complete Application Event Inventory")
        .next()
        .unwrap();
    inventory_sources.extend(expand(notice_section));
    assert_eq!(
        inventory_sources
            .iter()
            .map(String::as_str)
            .collect::<BTreeSet<_>>(),
        sources,
        "no baseline source operation may be dropped from the allocation table"
    );
    assert_eq!(inventory_sources.len(), 83);
}

#[test]
fn test_057_public_events_are_unique_and_referenced_events_are_declared() {
    let mut events = HashSet::new();
    for (name, _, tag, _) in PUBLIC_EVENTS {
        assert!(
            events.insert((*name, *tag)),
            "duplicate public event {name}:{tag}"
        );
    }
    assert!(!events.is_empty());
    let declared: HashSet<&str> = PUBLIC_EVENTS.iter().map(|(_, _, _, ty)| *ty).collect();
    for operation in OPERATIONS.iter() {
        for event in &operation.event_types {
            assert!(
                declared.contains(event.as_str())
                    || event == "ycoding.v5.PublicEvent"
                    || event == "ycoding.v5.SessionLogItem",
                "{} references undeclared event {event}",
                operation.diagnostic_name
            );
        }
    }
}
