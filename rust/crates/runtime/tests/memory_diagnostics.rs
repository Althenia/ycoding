fn bootstrap() -> &'static str {
    include_str!("../src/launch.rs")
        .split_once("fn run_bootstrap(")
        .unwrap()
        .1
        .split_once("async fn run_hosted(")
        .unwrap()
        .0
}

#[test]
fn memory_sampling_belongs_to_post_install_server_bootstrap_not_request_or_location_scopes() {
    let source = bootstrap();
    let installed = source.find("observability::install(").unwrap();
    let sampled = source
        .find("observability::memory::start(diagnostics.debug_enabled())")
        .unwrap();
    let prepared = source.find("prepare_store(config)").unwrap();
    let owner = source.find("ProductionOwner::scope_with_parent").unwrap();
    let closed = source.rfind("memory.close()").unwrap();
    let logger = source.rfind("diagnostics.close()").unwrap();
    let store = source.find("store.shutdown()").unwrap();
    assert!(installed < sampled && sampled < prepared && prepared < owner);
    assert!(owner < closed && closed < logger && logger < store);
    assert_eq!(source.matches("observability::memory::start(").count(), 1);
    let logging = include_str!("../../core/src/observability/mod.rs");
    assert!(logging.contains("self.shared.minimum == Level::DEBUG"));
}

#[test]
fn every_post_start_early_failure_joins_sampling_before_closing_the_private_logger() {
    let source = bootstrap();
    let startup = source
        .split_once("let mut memory = match")
        .unwrap()
        .1
        .split_once("if let Err(error) = prepare_store(config)")
        .unwrap()
        .0;
    assert!(startup.contains("diagnostics.close().map_err(message)"));
    assert!(!startup.contains("memory.close()"));
    for (start, end) in [
        (
            "if let Err(error) = prepare_store(config)",
            "let store = match",
        ),
        ("let store = match open_store(config)", "let attached ="),
    ] {
        let branch = source
            .split_once(start)
            .unwrap()
            .1
            .split_once(end)
            .unwrap()
            .0;
        let worker = branch.find("memory.close()").unwrap();
        let logger = branch.find("diagnostics.close()").unwrap();
        assert!(worker < logger);
    }
    assert_eq!(source.matches("memory.close()").count(), 3);
    let (_, results) = source.rsplit_once("launch_results([").unwrap();
    let (results, _) = results.split_once("])").unwrap();
    assert_eq!(
        results
            .trim()
            .split_terminator(',')
            .map(str::trim)
            .collect::<Vec<_>>(),
        [
            "body",
            "cleanup",
            "memory_result",
            "diagnostics_result",
            "store_result"
        ]
    );
}
