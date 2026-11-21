use ycoding_core::resources::domain_state::DomainState;

#[test]
fn published_domain_snapshots_update_clones_without_changing_held_readers() {
    let source = DomainState::new(vec!["first"]);
    let consumer = source.clone();
    let held = source.snapshot();
    source.publish(vec!["second"]);
    assert_eq!(*held, ["first"]);
    assert_eq!(*source.snapshot(), ["second"]);
    assert_eq!(*consumer.snapshot(), ["second"]);
}

#[test]
fn separate_domain_sources_publish_independently() {
    let agents = DomainState::new(vec!["agent-v1"]);
    let commands = DomainState::new(vec!["command-v1"]);
    agents.publish(vec!["agent-v2"]);
    assert_eq!(*agents.snapshot(), ["agent-v2"]);
    assert_eq!(*commands.snapshot(), ["command-v1"]);
}
