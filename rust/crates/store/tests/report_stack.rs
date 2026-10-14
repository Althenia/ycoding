use std::process::Command;
use ycoding_store::{
    Metadata, Options, Store,
    analytics::{self, Engine, Query, REPORT_STACK_BYTES, reports},
    import::{self, DatabaseKind},
};

const ENGINE_CHILD: &str = "YCODING_REPORT_STACK_ENGINE_CHILD";
const NATIVE_CHILD: &str = "YCODING_REPORT_STACK_NATIVE_CHILD";

#[test]
fn engine_returns_typed_outcomes_at_the_selected_expression_depth() {
    run_child(
        "engine_returns_typed_outcomes_at_the_selected_expression_depth",
        ENGINE_CHILD,
        engine_boundaries,
    );
}

#[test]
fn report_stack_holds_the_full_native_recursion_at_the_selected_expression_depth() {
    run_child(
        "report_stack_holds_the_full_native_recursion_at_the_selected_expression_depth",
        NATIVE_CHILD,
        || native_completion(REPORT_STACK_BYTES),
    );
}

fn run_child(test: &str, variable: &str, run: impl FnOnce()) {
    if std::env::var_os(variable).is_some() {
        run();
        return;
    }
    let output = Command::new(std::env::current_exe().unwrap())
        .args(["--exact", test, "--nocapture"])
        .env(variable, "1")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "report child {}\nstdout:\n{}\nstderr:\n{}",
        output.status,
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    print!("{}", String::from_utf8_lossy(&output.stderr));
}

#[test]
#[ignore = "stack measurement runs in a separate process with YCODING_REPORT_STACK_PROBE"]
fn measure_report_stack() {
    let stack = std::env::var("YCODING_REPORT_STACK_PROBE")
        .unwrap()
        .parse()
        .unwrap();
    native_completion(stack);
}

fn native_completion(stack: usize) {
    let (store, engine, root) = start("sufficiency", 72);
    let settings = settings(&engine);
    engine.shutdown().unwrap();
    store.shutdown().unwrap();
    let limit = native_limit(settings.clone());
    eprintln!("native limit {limit}; deadline-free stack {stack} bytes");
    let value = std::thread::Builder::new()
        .name("report-stack-sufficiency".to_owned())
        .stack_size(stack)
        .spawn(move || {
            let native = connection(&settings);
            let mut statement = native.prepare(&wrapped(limit)).unwrap();
            let mut rows = statement.query([]).unwrap();
            let value = rows.next().unwrap().unwrap().get::<_, f64>(0).unwrap();
            assert!(rows.next().unwrap().is_none());
            value
        })
        .unwrap()
        .join()
        .unwrap();
    assert_eq!(value, 0.0);
    std::fs::remove_dir_all(root).unwrap();
}

fn engine_boundaries() {
    let (store, engine, root) = start("engine", 71);
    let limit = native_limit(settings(&engine));
    eprintln!("native limit {limit}; selected max_expression_depth 1000");
    for depth in [limit - 1, limit] {
        match query(&engine, depth) {
            Ok(rows) => {
                assert_eq!(rows.len(), 1);
                assert_eq!(rows[0].len(), 1);
                assert_eq!(rows[0][0].len(), 1);
                assert_eq!(reports::value_number(&rows[0][0][0]).unwrap(), 0.0);
                eprintln!("engine depth {depth} completed with value 0");
            }
            Err(analytics::Error::Deadline) => {
                eprintln!("engine depth {depth} returned typed Deadline");
            }
            result => panic!("depth {depth}: expected the value or Deadline, got {result:?}"),
        }
    }
    match query(&engine, limit + 1) {
        Err(analytics::Error::Duck(error)) => {
            assert!(error.to_string().contains("Max expression depth limit"));
            eprintln!("engine depth {} returned typed depth rejection", limit + 1);
        }
        result => panic!("expected Duck depth rejection, got {result:?}"),
    }
    let rows = engine
        .report(vec![Query {
            sql: "SELECT 7",
            parameters: Vec::new(),
            max_rows: 1,
        }])
        .unwrap();
    assert_eq!(reports::value_number(&rows[0][0][0]).unwrap(), 7.0);
    store
        .submit(|tx| {
            let state = tx.get::<analytics::DeliveryTable>(&[])?.unwrap();
            tx.put::<analytics::DeliveryTable>(&state)
        })
        .unwrap()
        .wait()
        .unwrap();
    assert!(
        store
            .snapshot()
            .unwrap()
            .get::<analytics::DeliveryTable>(&[])
            .unwrap()
            .is_some()
    );
    engine.shutdown().unwrap();
    store.shutdown().unwrap();
    std::fs::remove_dir_all(root).unwrap();
}

fn start(name: &str, identity: u8) -> (Store, Engine, std::path::PathBuf) {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../.lane-logs")
        .join(format!("report-stack-{name}-{}", std::process::id()));
    std::fs::create_dir_all(&root).unwrap();
    let store = Store::initialize(
        root.join("canonical.redb"),
        Options::core(),
        import::catalog(DatabaseKind::Core),
        Metadata::new([identity; 16], 1),
    )
    .unwrap();
    let engine = reports::start(store.client(), root.join("derived")).unwrap();
    (store, engine, root)
}

fn settings(engine: &Engine) -> Vec<(String, String)> {
    let rows = engine
        .report(vec![Query {
            sql: "SELECT name, value FROM duckdb_settings() WHERE name IN ('temp_directory', 'threads', 'external_threads', 'max_expression_depth', 'memory_limit', 'max_temp_directory_size', 'autoload_known_extensions', 'autoinstall_known_extensions', 'enable_external_access', 'lock_configuration') ORDER BY name = 'lock_configuration', name = 'enable_external_access', name",
            parameters: Vec::new(),
            max_rows: 10,
        }])
        .unwrap();
    let selected = rows[0]
        .iter()
        .map(|row| match (&row[0], &row[1]) {
            (analytics::Value::Text(name), analytics::Value::Text(value)) => {
                (name.clone(), value.clone())
            }
            row => panic!("expected setting name and value strings, got {row:?}"),
        })
        .collect::<Vec<_>>();
    assert_eq!(selected.len(), 10);
    assert!(selected.contains(&("max_expression_depth".into(), "1000".into())));
    assert!(selected.contains(&("threads".into(), "1".into())));
    assert!(selected.contains(&("external_threads".into(), "1".into())));
    selected
}

fn connection(settings: &[(String, String)]) -> duckdb::Connection {
    let native = duckdb::Connection::open_in_memory().unwrap();
    for (name, value) in settings {
        native
            .execute_batch(&format!("SET {name} = '{}'", value.replace('\'', "''")))
            .unwrap();
    }
    for (name, value) in settings {
        assert_eq!(
            native
                .query_row(
                    &format!("SELECT current_setting('{name}')::VARCHAR"),
                    [],
                    |row| { row.get::<_, String>(0) }
                )
                .unwrap(),
            *value
        );
    }
    native
}

fn nested(depth: usize) -> String {
    format!(
        "SELECT {} FROM range(1) t(i)",
        vec!["i"; depth + 1].join("+")
    )
}

fn wrapped(depth: usize) -> String {
    format!(
        "SELECT * FROM ({}) AS analytics_report LIMIT 2",
        nested(depth)
    )
}

fn query(engine: &Engine, depth: usize) -> Result<analytics::ReportRows, analytics::Error> {
    engine.report(vec![Query {
        sql: Box::leak(nested(depth).into_boxed_str()),
        parameters: Vec::new(),
        max_rows: 1,
    }])
}

fn native_limit(settings: Vec<(String, String)>) -> usize {
    std::thread::Builder::new()
        .name("report-native-depth-oracle".to_owned())
        .stack_size(64 * 1024 * 1024)
        .spawn(move || {
            let selected = settings
                .iter()
                .find(|(name, _)| name == "max_expression_depth")
                .unwrap()
                .1
                .parse::<usize>()
                .unwrap();
            let native = connection(&settings);
            let accepts = |depth| match native.prepare(&wrapped(depth)) {
                Ok(_) => true,
                Err(error) => {
                    assert!(error.to_string().contains("Max expression depth limit"));
                    false
                }
            };
            let mut low: usize = 1;
            let mut high = selected + 100;
            while low < high {
                let middle = (low + high).div_ceil(2);
                if accepts(middle) {
                    low = middle;
                } else {
                    high = middle - 1;
                }
            }
            assert!(low > 1 && low < selected + 100);
            assert!(accepts(low));
            let Err(error) = native.prepare(&wrapped(low + 1)) else {
                panic!("one past the native depth limit is rejected")
            };
            assert!(error.to_string().contains("Max expression depth limit"));
            low
        })
        .unwrap()
        .join()
        .unwrap()
}
