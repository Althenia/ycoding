use ycoding_protocol::{OPERATIONS, v5};
use ycoding_runtime::{connector::mcp, standard};

const RETIRED: [(&str, i32); 8] = [
    ("artifact.demo.preview", 5045),
    ("artifact.demo.export", 5046),
    ("local.app.register", 5047),
    ("local.app.list", 5048),
    ("local.app.revoke", 5049),
    ("local.app.open", 5050),
    ("local.app.status", 5051),
    ("local.app.http", 5052),
];

#[test]
fn retired_local_app_and_artifact_demo_operations_are_absent_from_the_native_inventory() {
    for (name, id) in RETIRED {
        assert!(
            OPERATIONS
                .iter()
                .all(|descriptor| descriptor.diagnostic_name != name
                    && descriptor.operation_id != id as u32),
            "{name}"
        );
    }
    for role in [v5::PeerRole::RemoteClient, v5::PeerRole::Relay] {
        assert!(
            OPERATIONS
                .iter()
                .filter(|descriptor| descriptor.roles.contains(&(role as i32)))
                .all(
                    |descriptor| !descriptor.diagnostic_name.starts_with("local.app.")
                        && !descriptor.diagnostic_name.starts_with("artifact.demo.")
                ),
            "{role:?}"
        );
    }
}

#[test]
fn retired_operations_have_no_handler_and_no_mcp_tool() {
    let dispatcher = standard().unwrap();
    let wired = dispatcher.wired();
    for (name, _) in RETIRED {
        assert!(!wired.contains(&name), "{name}");
    }
    assert!(mcp::tools().iter().all(|tool| {
        !tool.name.starts_with("local_app_")
            && !tool.name.starts_with("artifact_demo_")
            && tool.operation.is_none_or(|operation| {
                !operation.starts_with("local.app.") && !operation.starts_with("artifact.demo.")
            })
    }));
}
