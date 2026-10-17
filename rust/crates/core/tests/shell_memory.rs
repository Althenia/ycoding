#![cfg(unix)]
mod shell_temp;

use serde_json::Value;
use shell_temp::Temp;
use std::{
    fs,
    path::Path,
    process::{Command, Stdio},
    time::{Duration, Instant},
};
use ycoding_core::platform::shell::memory::{History, Peak, Requirement};

fn peak(
    command: &str,
    cwd: &Path,
    memory_limit_mb: Option<u64>,
    peak_mb: f64,
    can_lower: bool,
) -> Peak {
    Peak {
        command: command.into(),
        cwd: cwd.into(),
        memory_limit_mb,
        reserve_mb: 2_048,
        peak_mb,
        can_lower,
    }
}

fn requirement(command: &str, cwd: &Path, memory_limit_mb: Option<u64>) -> Requirement {
    Requirement {
        command: command.into(),
        cwd: cwd.into(),
        memory_limit_mb,
        reserve_mb: 2_048,
    }
}

fn stored(directory: &Path) -> Vec<(String, Vec<f64>)> {
    let Value::Array(entries) =
        serde_json::from_str(&fs::read_to_string(directory.join("memory.json")).unwrap()).unwrap()
    else {
        panic!("memory.json is not an array");
    };
    entries
        .into_iter()
        .map(|entry| {
            let keys: Vec<_> = entry.as_object().unwrap().keys().cloned().collect();
            assert!(
                keys.iter().all(|key| key == "key" || key == "peaks"),
                "{keys:?}"
            );
            (
                entry["key"].as_str().unwrap().to_owned(),
                entry["peaks"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|peak| peak.as_f64().unwrap())
                    .collect(),
            )
        })
        .collect()
}

fn names(directory: &Path) -> Vec<String> {
    let mut names: Vec<_> = fs::read_dir(directory)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    names
}

#[test]
fn a_failed_write_leaves_no_lock_or_temporary_file_behind() {
    let dir = Temp::new("memory-failed");
    let history = History::new(dir.path());
    history
        .record(&peak("check", dir.path(), None, 100.0, true))
        .unwrap();
    assert_eq!(
        history.requirement(&requirement("check", dir.path(), None)),
        100.0
    );
    assert_eq!(names(dir.path()), ["memory.json", "memory.lock"]);
    let failed = dir.path().join("failed");
    fs::create_dir_all(failed.join("memory.json")).unwrap();
    assert!(
        History::new(&failed)
            .record(&peak("check", dir.path(), None, 100.0, true))
            .is_err()
    );
    let lock = fs::File::create(failed.join("memory.lock")).unwrap();
    lock.try_lock().expect("the failed write released its lock");
    assert_eq!(names(&failed), ["memory.json", "memory.lock"]);
}

#[test]
fn incomplete_low_peaks_cannot_lower_history_but_increases_and_sampled_exits_can() {
    let dir = Temp::new("memory-lower");
    let history = History::new(dir.path());
    let limited = |peak_mb, can_lower| peak("check", dir.path(), Some(6_144), peak_mb, can_lower);
    let input = requirement("check", dir.path(), Some(6_144));
    history.record(&limited(3_000.0, true)).unwrap();
    for _ in 0..5 {
        history.record(&limited(2.0, false)).unwrap();
    }
    assert_eq!(history.requirement(&input), 3_000.0);
    assert_eq!(stored(dir.path())[0].1, [3_000.0]);
    history.record(&limited(4_000.0, false)).unwrap();
    assert_eq!(history.requirement(&input), 4_000.0);
    let cold = requirement("cold", dir.path(), None);
    history
        .record(&peak("cold", dir.path(), None, 2.0, false))
        .unwrap();
    assert_eq!(history.requirement(&cold), 2_048.0);
    history
        .record(&peak("cold", dir.path(), None, 3_000.0, false))
        .unwrap();
    assert_eq!(history.requirement(&cold), 3_000.0);
    history.record(&limited(1_000.0, true)).unwrap();
    let peaks = stored(dir.path())
        .into_iter()
        .find(|entry| entry.1.contains(&4_000.0))
        .unwrap()
        .1;
    assert_eq!(peaks, [3_000.0, 4_000.0, 1_000.0]);
}

#[test]
fn contention_is_bounded_and_keeps_the_last_readable_history() {
    let dir = Temp::new("memory-contention");
    let history = History::new(dir.path());
    history
        .record(&peak("check", dir.path(), None, 100.0, true))
        .unwrap();
    let lock = fs::File::create(dir.path().join("memory.lock")).unwrap();
    lock.lock().unwrap();
    let started = Instant::now();
    assert!(
        history
            .record(&peak("check", dir.path(), None, 200.0, true))
            .is_err()
    );
    assert!(started.elapsed() >= Duration::from_millis(500));
    assert!(started.elapsed() < Duration::from_secs(4));
    assert_eq!(
        history.requirement(&requirement("check", dir.path(), None)),
        100.0
    );
}

#[test]
fn it_retains_256_recent_keys_and_stores_only_hashes_and_measured_peaks() {
    let dir = Temp::new("memory-keys");
    let history = History::new(dir.path());
    for index in 0..257 {
        history
            .record(&peak(
                &format!("command {index}"),
                dir.path(),
                None,
                f64::from(index + 1),
                true,
            ))
            .unwrap();
    }
    let raw = fs::read_to_string(dir.path().join("memory.json")).unwrap();
    let entries = stored(dir.path());
    assert_eq!(entries.len(), 256);
    assert!(
        entries
            .iter()
            .all(|(key, _)| key.len() == 64 && key.chars().all(|c| c.is_ascii_hexdigit()))
    );
    assert!(!raw.contains("command"));
    assert!(!raw.contains(dir.path().to_str().unwrap()));
    assert_eq!(
        history.requirement(&requirement("command 0", dir.path(), Some(6_144))),
        6_144.0
    );
    assert_eq!(
        history.requirement(&requirement("command 1", dir.path(), Some(6_144))),
        2.0
    );
    assert_eq!(names(dir.path()), ["memory.json", "memory.lock"]);
}

#[test]
fn separate_processes_share_atomic_updates_without_losing_keys_and_keep_five_runs_per_key() {
    let dir = Temp::new("memory-processes");
    let mut children: Vec<_> = (0..3)
        .map(|index| {
            Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "memory_worker",
                    "--ignored",
                    "--nocapture",
                    "--test-threads=1",
                ])
                .env(
                    "YCODING_MEMORY_WORKER",
                    format!("{}|{index}", dir.path().display()),
                )
                .stdout(Stdio::null())
                .stderr(Stdio::inherit())
                .spawn()
                .unwrap()
        })
        .collect();
    for child in &mut children {
        assert!(child.wait().unwrap().success());
    }
    let entries = stored(dir.path());
    assert_eq!(entries.len(), 4);
    let mut lengths: Vec<_> = entries.iter().map(|entry| entry.1.len()).collect();
    lengths.sort();
    assert_eq!(lengths, [4, 4, 4, 5]);
    let history = History::new(dir.path());
    for index in 0..3 {
        assert_eq!(
            history.requirement(&requirement(&format!("check {index}"), dir.path(), None)),
            400.0 + f64::from(index)
        );
    }
}

#[test]
#[ignore = "child process of the multi-process memory test"]
fn memory_worker() {
    let Ok(spec) = std::env::var("YCODING_MEMORY_WORKER") else {
        return;
    };
    let (directory, index) = spec.split_once('|').unwrap();
    let index: f64 = index.parse().unwrap();
    let directory = Path::new(directory);
    let history = History::new(directory);
    for base in [100.0, 200.0, 300.0, 400.0] {
        for command in [format!("check {index}"), "shared".to_owned()] {
            history
                .record(&peak(&command, directory, None, base + index, true))
                .unwrap();
        }
    }
}

#[test]
fn unusable_samples_and_damaged_history_keep_cold_requirements() {
    let dir = Temp::new("memory-cold");
    let history = History::new(dir.path());
    for peak_mb in [0.0, -1.0, f64::INFINITY, f64::NAN] {
        history
            .record(&peak("check", dir.path(), None, peak_mb, true))
            .unwrap();
    }
    assert_eq!(
        history.requirement(&requirement("check", dir.path(), None)),
        2_048.0
    );
    fs::write(dir.path().join("memory.json"), "invalid").unwrap();
    assert_eq!(
        history.requirement(&requirement("check", dir.path(), Some(6_144))),
        6_144.0
    );
    fs::write(
        dir.path()
            .join("memory.json.11111111-1111-4111-8111-111111111111.tmp"),
        "interrupted",
    )
    .unwrap();
    history
        .record(&peak("check", dir.path(), None, 100.0, true))
        .unwrap();
    assert_eq!(names(dir.path()), ["memory.json", "memory.lock"]);
}
