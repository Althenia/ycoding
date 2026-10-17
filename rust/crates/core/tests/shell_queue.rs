#![cfg(unix)]
mod shell_queue_support;

use serde_json::json;
use shell_queue_support::*;
use std::{
    io::Write,
    path::Path,
    process::{Child, Command, Stdio},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    time::{Duration, Instant},
};
use ycoding_core::platform::shell::{
    memory::Peak,
    queue::{Limits, Queue, Sample},
};

fn peak(command: &str, cwd: &str, peak_mb: f64) -> Peak {
    Peak {
        command: command.into(),
        cwd: cwd.into(),
        memory_limit_mb: None,
        reserve_mb: 2_048,
        peak_mb,
        can_lower: true,
    }
}

fn reserve(queue: &Queue, id: &str) -> f64 {
    queue
        .entries()
        .unwrap()
        .into_iter()
        .find(|entry| entry.id == id)
        .unwrap_or_else(|| panic!("{id} has no queue entry"))
        .reserve_mb
}

fn ids(queue: &Queue) -> Vec<String> {
    let mut ids: Vec<_> = queue
        .entries()
        .unwrap()
        .into_iter()
        .map(|entry| entry.id)
        .collect();
    ids.sort();
    ids
}

#[tokio::test(flavor = "multi_thread")]
async fn a_full_family_keeps_its_head_waiting_without_holding_a_slot_and_a_reopened_family_wakes_it()
 {
    let dir = Temp::new("queue-family");
    let host = Host::new(1_000_000.0, 0.0);
    let mut options = host.options(dir.path());
    options.backstop = Duration::from_secs(60);
    let queue = open(options).await;
    let family = Family::new("ses_root", false);
    let mut head = enqueue(
        &queue,
        "sh_family_full",
        "ses_family",
        Spec::running(1).admission(family.clone()),
    )
    .await;
    let mut other = enqueue(&queue, "sh_other", "ses_other", Spec::running(1)).await;
    other.admitted().await;
    settle().await;
    assert!(!head.is_admitted());
    assert_eq!(family.acquired.load(Ordering::SeqCst), 0);
    assert_eq!(family.subscribers(), 1);
    other.release().await;
    family.open();
    head.admitted().await;
    assert_eq!(family.acquired.load(Ordering::SeqCst), 1);
    assert_eq!(family.committed.load(Ordering::SeqCst), 1);
    assert_eq!(family.released.load(Ordering::SeqCst), 0);
    head.release().await;
    assert_eq!(family.released.load(Ordering::SeqCst), 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn family_capacity_is_taken_only_when_a_slot_is_free() {
    let dir = Temp::new("queue-family-late");
    let host = Host::new(1_000_000.0, 0.0);
    let queue = open(host.options(dir.path())).await;
    let family = Family::new("ses_root", true);
    let mut holder = enqueue(&queue, "sh_holder", "ses_holder", Spec::running(1)).await;
    holder.admitted().await;
    let mut waiting = enqueue(
        &queue,
        "sh_waiting",
        "ses_waiting",
        Spec::running(1).admission(family.clone()),
    )
    .await;
    settle().await;
    assert!(!waiting.is_admitted());
    assert_eq!(family.acquired.load(Ordering::SeqCst), 0);
    holder.release().await;
    waiting.admitted().await;
    assert_eq!(family.acquired.load(Ordering::SeqCst), 1);
    assert_eq!(family.committed.load(Ordering::SeqCst), 1);
    assert_eq!(family.released.load(Ordering::SeqCst), 0);
    waiting.release().await;
    assert_eq!(family.released.load(Ordering::SeqCst), 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn retained_peaks_clamp_to_the_limit_and_cold_commands_reserve_their_full_limit() {
    let dir = Temp::new("queue-learned");
    let host = Host::new(6_000.0, 0.0);
    let queue = open(host.options(dir.path())).await;
    for peak_mb in [9_000.0, 1_000.0, 1_500.0, 2_000.0, 2_500.0, 3_000.0] {
        queue
            .record_peak(peak("check", "/workspace", peak_mb))
            .unwrap();
    }
    let learned = || Spec::running(4).memory(6_144).command("check");
    let first = enqueue(&queue, "sh_learned_1", "ses_a", learned()).await;
    first.admitted().await;
    let second = enqueue(&queue, "sh_learned_2", "ses_b", learned()).await;
    second.admitted().await;
    let cold = enqueue(&queue, "sh_cold", "ses_c", learned().command("check ")).await;
    let elsewhere = enqueue(&queue, "sh_elsewhere", "ses_d", learned().cwd("/other")).await;
    settle().await;
    assert!(!cold.is_admitted() && !elsewhere.is_admitted());
    assert_eq!(reserve(&queue, "sh_learned_1"), 3_000.0);
    assert_eq!(reserve(&queue, "sh_learned_2"), 3_000.0);
    assert_eq!(reserve(&queue, "sh_cold"), 6_144.0);
    drop((first, second, cold, elsewhere));
    until(
        || queue.entries().unwrap().is_empty(),
        "entries were not released",
    )
    .await;
    let limited = enqueue(&queue, "sh_limited", "ses_e", learned().memory(2_048)).await;
    limited.admitted().await;
    assert_eq!(reserve(&queue, "sh_limited"), 2_048.0);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_finished_run_that_teaches_a_smaller_requirement_reconsiders_waiting_commands() {
    let dir = Temp::new("queue-teach");
    let host = Host::new(5_700.0, 0.0);
    let queue = open(host.options(dir.path())).await;
    let holder = enqueue(
        &queue,
        "sh_holder",
        "ses_a",
        Spec::running(10)
            .memory(6_144)
            .resident(Arc::new(|| 6_000.0)),
    )
    .await;
    holder.admitted().await;
    let waiting = enqueue(
        &queue,
        "sh_waiting",
        "ses_b",
        Spec::default().command("check").memory(6_144),
    )
    .await;
    settle().await;
    assert!(!waiting.is_admitted());
    queue
        .record_peak(peak("check", "/workspace", 2_000.0))
        .unwrap();
    waiting.admitted().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn an_idle_machine_fills_the_configured_cap_and_holds_the_rest() {
    let dir = Temp::new("queue-fill");
    let host = Host::new(100_000.0, 0.0);
    let queue = open(host.options(dir.path())).await;
    let mut entries = Vec::new();
    for index in 0..11 {
        entries.push(
            enqueue(
                &queue,
                &format!("sh_idle_{index:02}"),
                &format!("ses_idle_{index}"),
                Spec::default(),
            )
            .await,
        );
    }
    until(
        || entries.iter().filter(|entry| entry.is_admitted()).count() == 10,
        "ten entries were not admitted",
    )
    .await;
    settle().await;
    assert_eq!(
        entries.iter().map(Waiter::is_admitted).collect::<Vec<_>>(),
        [vec![true; 10], vec![false]].concat()
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn unmaterialized_memory_is_reserved_and_growing_resident_memory_is_credited_without_going_negative()
 {
    let dir = Temp::new("queue-resident");
    let host = Host::new(100.0, 0.0);
    let queue = open(host.options(dir.path())).await;
    let resident = Arc::new([Mutex::new(0.0_f64), Mutex::new(0.0_f64)]);
    let probe = |index: usize| {
        let resident = resident.clone();
        Arc::new(move || *resident[index].lock().unwrap()) as Arc<dyn Fn() -> f64 + Send + Sync>
    };
    let first = enqueue(
        &queue,
        "sh_memory_first",
        "ses_first",
        Spec::default().memory(40).resident(probe(0)),
    )
    .await;
    let second = enqueue(
        &queue,
        "sh_memory_second",
        "ses_second",
        Spec::default()
            .limits(|limits| limits.memory_reserve_mb = 40)
            .resident(probe(1)),
    )
    .await;
    let third = enqueue(
        &queue,
        "sh_memory_third",
        "ses_third",
        Spec::default().memory(40),
    )
    .await;
    until(
        || first.is_admitted() && second.is_admitted(),
        "the first two were not admitted",
    )
    .await;
    settle().await;
    assert!(!third.is_admitted());
    *resident[0].lock().unwrap() = 10.0;
    *resident[1].lock().unwrap() = 10.0;
    third.admitted().await;
    *resident[0].lock().unwrap() = 400.0;
    *resident[1].lock().unwrap() = 400.0;
    host.set(60.0, 0.0);
    let fourth = enqueue(
        &queue,
        "sh_memory_fourth",
        "ses_fourth",
        Spec::default().memory(40),
    )
    .await;
    settle().await;
    assert!(!fourth.is_admitted());
    host.set(80.0, 0.0);
    fourth.admitted().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn recent_starts_count_as_load_until_their_exponential_contribution_decays() {
    let dir = Temp::new("queue-decay");
    let host = Host::new(100_000.0, 0.0);
    let mut options = host.options(dir.path());
    options.parallelism = 2;
    let queue = open(options).await;
    let mut entries = Vec::new();
    for index in 0..5 {
        entries.push(
            enqueue(
                &queue,
                &format!("sh_cpu_{index}"),
                &format!("ses_cpu_{index}"),
                Spec::default(),
            )
            .await,
        );
    }
    until(
        || entries[0].is_admitted() && entries[1].is_admitted(),
        "two were not admitted",
    )
    .await;
    settle().await;
    assert_eq!(
        entries.iter().map(Waiter::is_admitted).collect::<Vec<_>>(),
        [true, true, false, false, false]
    );
    host.clock.store(60_000, Ordering::SeqCst);
    until(
        || entries[2].is_admitted() && entries[3].is_admitted(),
        "decay did not admit two more",
    )
    .await;
    settle().await;
    assert!(!entries[4].is_admitted());
}

#[tokio::test(flavor = "multi_thread")]
async fn a_loaded_machine_stays_below_its_measured_plus_reserved_cpu_threshold() {
    let dir = Temp::new("queue-loaded");
    let host = Host::new(100_000.0, 0.75);
    let mut options = host.options(dir.path());
    options.parallelism = 4;
    let queue = open(options).await;
    let mut first = enqueue(&queue, "sh_loaded_first", "ses_first", Spec::default()).await;
    let same = enqueue(&queue, "sh_loaded_same", "ses_first", Spec::default()).await;
    let other = enqueue(&queue, "sh_loaded_other", "ses_other", Spec::default()).await;
    first.admitted().await;
    settle().await;
    assert_eq!(flags(&[&first, &same, &other]), [true, false, false]);
    host.clock.store(60_000, Ordering::SeqCst);
    other.admitted().await;
    assert!(!same.is_admitted());
    first.release().await;
    settle().await;
    assert!(!same.is_admitted());
    host.clock.store(120_000, Ordering::SeqCst);
    same.admitted().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn the_idle_head_starts_despite_insufficient_headroom_and_later_admissions_stay_gated() {
    for gate in ["memory", "cpu"] {
        let dir = Temp::new("queue-idle-head");
        let host = if gate == "memory" {
            Host::new(5_700.0, 0.0)
        } else {
            Host::new(100_000.0, 2.0)
        };
        let queue = open(host.options(dir.path())).await;
        let spec = || {
            Spec::running(2).limits(|limits| {
                limits.max_running_per_session = 1;
                limits.memory_reserve_mb = 2_048;
                limits.max_load = 1.0;
            })
        };
        let mut idle = enqueue(&queue, "sh_idle", "ses_a", spec().memory(8_192)).await;
        idle.admitted().await;
        let same = enqueue(&queue, "sh_same", "ses_a", spec()).await;
        host.set(6_143.0, 0.2);
        let mut memory = enqueue(&queue, "sh_memory", "ses_b", spec().memory(4_096)).await;
        settle().await;
        assert!(!memory.is_admitted(), "{gate}");
        assert!(!same.is_admitted(), "{gate}");
        host.set(12_288.0, 1.0);
        settle().await;
        assert!(!memory.is_admitted(), "{gate}");
        host.set(12_288.0, 0.5);
        memory.admitted().await;
        assert!(!same.is_admitted(), "{gate}");
        memory.release().await;
        host.set(0.0, 99.0);
        idle.release().await;
        same.admitted().await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn an_unmet_resource_gate_stops_later_entries_in_order() {
    let dir = Temp::new("queue-gate");
    let host = Host::new(1_000_000.0, 0.0);
    let queue = open(host.options(dir.path())).await;
    let holder = enqueue(
        &queue,
        "sh_holder",
        "ses_holder",
        Spec::running(4).memory(1),
    )
    .await;
    holder.admitted().await;
    host.set(2_048.0, 0.0);
    host.tick();
    let head = enqueue(
        &queue,
        "sh_head",
        "ses_head",
        Spec::running(4).memory(4_096),
    )
    .await;
    host.tick();
    let follower = enqueue(
        &queue,
        "sh_follower",
        "ses_follower",
        Spec::running(4).memory(1_024),
    )
    .await;
    settle().await;
    assert!(!head.is_admitted() && !follower.is_admitted());
    host.set(8_192.0, 0.0);
    head.admitted().await;
    follower.admitted().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn missing_or_slow_samples_never_admit_a_non_idle_head_but_do_not_block_the_idle_one() {
    let dir = Temp::new("queue-sample");
    let host = Host::new(1_000_000.0, 0.0);
    host.unavailable();
    let queue = open(host.options(dir.path())).await;
    let head = enqueue(&queue, "sh_head", "ses_a", Spec::running(4)).await;
    head.admitted().await;
    let later = enqueue(&queue, "sh_later", "ses_b", Spec::running(4)).await;
    settle().await;
    assert!(!later.is_admitted());
    host.set(1_000_000.0, 0.0);
    later.admitted().await;

    let slow_dir = Temp::new("queue-slow");
    let mut options = Host::new(1.0, 0.0).options(slow_dir.path());
    options.sample = Arc::new(|| {
        std::thread::sleep(Duration::from_secs(5));
        None
    });
    let slow = open(options).await;
    let started = Instant::now();
    let idle = enqueue(&slow, "sh_idle", "ses_a", Spec::default()).await;
    idle.admitted().await;
    assert!(started.elapsed() < Duration::from_secs(4));
}

#[tokio::test(flavor = "multi_thread")]
async fn session_lanes_are_served_round_robin_so_one_backlog_cannot_starve_another() {
    let dir = Temp::new("queue-lanes");
    let host = Host::new(1_000_000.0, 0.0);
    let queue = open(host.options(dir.path())).await;
    host.tick();
    let mut blocker = enqueue(&queue, "sh_0_blocker", "ses_z", Spec::running(1)).await;
    blocker.admitted().await;
    let mut entries = Vec::new();
    for (id, session) in [
        ("sh_1_a1", "ses_a"),
        ("sh_2_a2", "ses_a"),
        ("sh_3_a3", "ses_a"),
        ("sh_4_b1", "ses_b"),
        ("sh_5_b2", "ses_b"),
    ] {
        host.tick();
        entries.push(enqueue(&queue, id, session, Spec::running(1)).await);
    }
    assert_eq!(
        entries
            .iter()
            .map(|entry| entry.position)
            .collect::<Vec<_>>(),
        [1, 2, 3, 2, 4]
    );
    host.tick();
    blocker.release().await;
    let names = ["a1", "a2", "a3", "b1", "b2"];
    let mut released = Vec::new();
    let mut order = Vec::new();
    for _ in 0..entries.len() {
        until(
            || {
                entries
                    .iter()
                    .enumerate()
                    .any(|(index, entry)| entry.is_admitted() && !released.contains(&index))
            },
            "the next entry was not admitted",
        )
        .await;
        let next = entries
            .iter()
            .position(|entry| {
                entry.is_admitted()
                    && !released.contains(
                        &entries
                            .iter()
                            .position(|other| other.id == entry.id)
                            .unwrap(),
                    )
            })
            .unwrap();
        settle().await;
        assert_eq!(
            entries
                .iter()
                .enumerate()
                .filter(|(index, entry)| entry.is_admitted() && !released.contains(index))
                .count(),
            1
        );
        order.push(names[next]);
        released.push(next);
        host.tick();
        entries[next].release().await;
    }
    assert_eq!(order, ["a1", "b1", "a2", "b2", "a3"]);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_session_keeps_its_second_command_waiting_while_another_session_uses_a_free_slot() {
    let dir = Temp::new("queue-session-cap");
    let host = Host::new(1_000_000.0, 0.0);
    let queue = open(host.options(dir.path())).await;
    let spec = || Spec::running(2).limits(|limits| limits.max_running_per_session = 1);
    let mut a1 = enqueue(&queue, "sh_a1", "ses_a", spec()).await;
    let a2 = enqueue(&queue, "sh_a2", "ses_a", spec()).await;
    a1.admitted().await;
    settle().await;
    assert!(!a2.is_admitted());
    let b1 = enqueue(&queue, "sh_b1", "ses_b", spec()).await;
    b1.admitted().await;
    assert!(!a2.is_admitted());
    a1.release().await;
    a2.admitted().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn mixed_running_caps_are_honoured_per_request() {
    let dir = Temp::new("queue-mixed");
    let host = Host::new(1_000_000.0, 0.0);
    let queue = open(host.options(dir.path())).await;
    let a = enqueue(&queue, "sh_a", "ses_a", Spec::running(2)).await;
    let b = enqueue(&queue, "sh_b", "ses_b", Spec::running(2)).await;
    until(
        || a.is_admitted() && b.is_admitted(),
        "the first two were not admitted",
    )
    .await;
    let mut narrow = enqueue(&queue, "sh_narrow", "ses_c", Spec::running(1)).await;
    let mut same_cap = enqueue(&queue, "sh_same_cap", "ses_d", Spec::running(2)).await;
    let wide = enqueue(&queue, "sh_wide", "ses_e", Spec::running(3)).await;
    wide.admitted().await;
    settle().await;
    assert!(!narrow.is_admitted() && !same_cap.is_admitted());
    narrow.release().await;
    same_cap.release().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn the_idle_head_is_admitted_at_once_and_later_entries_wait_behind_the_global_cap() {
    let dir = Temp::new("queue-head");
    let host = Host::new(1_000_000.0, 0.0);
    let queue = open(host.options(dir.path())).await;
    let mut first = enqueue(&queue, "sh_first", "ses_a", Spec::running(1)).await;
    first.admitted().await;
    let mut second = enqueue(&queue, "sh_second", "ses_b", Spec::running(1)).await;
    assert_eq!((first.position, second.position), (1, 1));
    settle().await;
    assert!(!second.is_admitted());
    first.release().await;
    second.admitted().await;
    assert!(second.positions().is_empty());
    second.release().await;
    assert!(queue.entries().unwrap().is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn a_session_beyond_its_waiting_limit_is_rejected_without_counting_its_running_command() {
    let dir = Temp::new("queue-waiting");
    let host = Host::new(1_000_000.0, 0.0);
    let queue = open(host.options(dir.path())).await;
    let spec = || Spec::running(1).limits(|limits| limits.max_queued_per_session = 2);
    let running = enqueue(&queue, "sh_running", "ses_a", spec()).await;
    running.admitted().await;
    let _wait_1 = enqueue(&queue, "sh_wait_1", "ses_a", spec()).await;
    let _wait_2 = enqueue(&queue, "sh_wait_2", "ses_a", spec()).await;
    let error = try_enqueue(&queue, "sh_rejected", "ses_a", spec())
        .await
        .err()
        .unwrap();
    assert_eq!(error.limit, 2);
    assert!(error.to_string().contains("2 waiting commands"));
    let _other = enqueue(&queue, "sh_other_session", "ses_b", spec()).await;
    assert_eq!(
        ids(&queue),
        ["sh_other_session", "sh_running", "sh_wait_1", "sh_wait_2"]
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn concurrent_enqueues_are_acknowledged_before_a_blocked_admission_sample_settles() {
    let dir = Temp::new("queue-ack");
    let host = Host::new(1_000_000.0, 0.0);
    let hold = Arc::new(AtomicBool::new(false));
    let (release, gate) = std::sync::mpsc::channel::<()>();
    let gate = Arc::new(Mutex::new(gate));
    let started = Arc::new(AtomicUsize::new(0));
    let mut options = host.options(dir.path());
    options.sample = {
        let (hold, started) = (hold.clone(), started.clone());
        Arc::new(move || {
            if hold.load(Ordering::SeqCst) {
                started.fetch_add(1, Ordering::SeqCst);
                let _ = gate.lock().unwrap().recv_timeout(Duration::from_secs(5));
            }
            Some(Sample {
                available_mb: 1_000_000.0,
                load: 0.0,
            })
        })
    };
    let queue = open(options).await;
    let holder = enqueue(&queue, "sh_holder", "ses_holder", Spec::running(2)).await;
    holder.admitted().await;
    hold.store(true, Ordering::SeqCst);
    let first = enqueue(&queue, "sh_0", "ses_0", Spec::running(2)).await;
    until(
        || started.load(Ordering::SeqCst) > 0,
        "the sample did not start",
    )
    .await;
    let acknowledged = tokio::time::timeout(Duration::from_millis(600), enqueue_three(&queue))
        .await
        .expect("enqueues waited for the blocked sample");
    assert_eq!(acknowledged.len(), 3);
    assert!(acknowledged.iter().all(|entry| !entry.is_admitted()) && !first.is_admitted());
    hold.store(false, Ordering::SeqCst);
    let _ = release.send(());
    first.admitted().await;
}

async fn enqueue_three(queue: &Queue) -> Vec<Waiter> {
    let mut entries = Vec::new();
    for index in 1..=3 {
        entries.push(
            enqueue(
                queue,
                &format!("sh_{index}"),
                &format!("ses_{index}"),
                Spec::running(2),
            )
            .await,
        );
    }
    entries
}

#[tokio::test(flavor = "multi_thread")]
async fn waiters_behind_an_exhausted_range_cost_one_sample_per_pass_not_one_per_waiter() {
    let dir = Temp::new("queue-exhausted");
    let host = Host::new(1_000_000.0, 0.0);
    let queue = open(host.options(dir.path())).await;
    let mut holders = Vec::new();
    for index in 0..2 {
        holders.push(
            enqueue(
                &queue,
                &format!("sh_holder_{index}"),
                &format!("ses_holder_{index}"),
                Spec::running(2),
            )
            .await,
        );
    }
    until(
        || holders.iter().all(Waiter::is_admitted),
        "holders were not admitted",
    )
    .await;
    let mut waiting = Vec::new();
    for index in 0..80 {
        waiting.push(
            enqueue(
                &queue,
                &format!("sh_{index:03}"),
                &format!("ses_{index}"),
                Spec::running(if index % 2 == 0 { 2 } else { 1 }),
            )
            .await,
        );
    }
    settle().await;
    let before = host.samples.load(Ordering::SeqCst);
    settle().await;
    let during = host.samples.load(Ordering::SeqCst) - before;
    assert!(
        during <= 20,
        "{during} samples for eighty waiters in 400 ms"
    );
    assert!(waiting.iter().all(|entry| !entry.is_admitted()));
}

#[tokio::test(flavor = "multi_thread")]
async fn releasing_a_ticket_straight_after_admission_leaves_no_entry_behind() {
    let dir = Temp::new("queue-resurrect");
    let host = Host::new(1_000_000.0, 0.0);
    let queue = open(host.options(dir.path())).await;
    let cancelled = enqueue(&queue, "sh_cancelled", "ses_cancelled", Spec::running(1)).await;
    drop(cancelled);
    let next = enqueue(&queue, "sh_next", "ses_other", Spec::running(1)).await;
    next.admitted().await;
    assert_eq!(ids(&queue), ["sh_next"]);
}

#[tokio::test(flavor = "multi_thread")]
async fn two_queues_on_one_directory_share_the_running_waiting_and_session_caps() {
    let dir = Temp::new("queue-shared");
    let host = Host::new(1_000_000.0, 0.0);
    let left = open(host.options(dir.path())).await;
    let right = open(host.options(dir.path())).await;
    let running = Arc::new(AtomicUsize::new(0));
    let peak = Arc::new(AtomicUsize::new(0));
    let sessions: Arc<Vec<AtomicUsize>> = Arc::new((0..4).map(|_| AtomicUsize::new(0)).collect());
    let session_peak = Arc::new(AtomicUsize::new(0));
    let mut tasks = Vec::new();
    for (queue, label) in [(left.clone(), "l"), (right.clone(), "r")] {
        for index in 0..8 {
            let (running, peak, sessions, session_peak) = (
                running.clone(),
                peak.clone(),
                sessions.clone(),
                session_peak.clone(),
            );
            let queue = queue.clone();
            tasks.push(tokio::spawn(async move {
                let session = index % 4;
                let mut ticket = queue
                    .enqueue(request(
                        &format!("sh_{label}_{index}"),
                        &format!("ses_{session}"),
                        Spec::running(2),
                    ))
                    .await
                    .unwrap();
                ticket.admitted(|_| {}).await.unwrap();
                let now = running.fetch_add(1, Ordering::SeqCst) + 1;
                peak.fetch_max(now, Ordering::SeqCst);
                let in_session = sessions[session].fetch_add(1, Ordering::SeqCst) + 1;
                session_peak.fetch_max(in_session, Ordering::SeqCst);
                tokio::time::sleep(Duration::from_millis(20)).await;
                sessions[session].fetch_sub(1, Ordering::SeqCst);
                running.fetch_sub(1, Ordering::SeqCst);
            }));
        }
    }
    for task in tasks {
        tokio::time::timeout(Duration::from_secs(60), task)
            .await
            .unwrap()
            .unwrap();
    }
    assert!(peak.load(Ordering::SeqCst) <= 2);
    assert!(session_peak.load(Ordering::SeqCst) <= 1);
    assert!(left.entries().unwrap().is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn racing_queues_never_exceed_one_sessions_waiting_cap() {
    let dir = Temp::new("queue-race");
    let host = Host::new(1_000_000.0, 0.0);
    let mut queues = Vec::new();
    for _ in 0..4 {
        queues.push(open(host.options(dir.path())).await);
    }
    let spec = || Spec::running(1).limits(|limits| limits.max_queued_per_session = 3);
    let holder = enqueue(&queues[0], "sh_holder", "ses_shared", spec()).await;
    holder.admitted().await;
    let mut tasks = Vec::new();
    for (queue_index, queue) in queues.iter().enumerate() {
        for index in 0..8 {
            let queue = queue.clone();
            tasks.push(tokio::spawn(async move {
                try_enqueue(
                    &queue,
                    &format!("sh_{queue_index}_{index}"),
                    "ses_shared",
                    spec(),
                )
                .await
            }));
        }
    }
    let mut accepted = Vec::new();
    let mut rejected = 0;
    for task in tasks {
        match task.await.unwrap() {
            Ok(waiter) => accepted.push(waiter),
            Err(_) => rejected += 1,
        }
    }
    assert_eq!((accepted.len(), rejected), (3, 29));
}

#[tokio::test(flavor = "multi_thread")]
async fn memory_and_cpu_headroom_are_shared_across_queues_on_one_directory_and_counted_once() {
    for resource in ["memory", "cpu"] {
        let dir = Temp::new("queue-headroom");
        let owner_host = Host::new(1_000_000.0, 0.0);
        let owner = open(owner_host.options(dir.path())).await;
        let resident = Arc::new(Mutex::new(0.0_f64));
        let probe = {
            let resident = resident.clone();
            Arc::new(move || *resident.lock().unwrap()) as Arc<dyn Fn() -> f64 + Send + Sync>
        };
        let first = enqueue(
            &owner,
            "sh_owner",
            "ses_owner",
            Spec::running(3)
                .memory(if resource == "memory" { 100 } else { 1 })
                .resident(probe),
        )
        .await;
        first.admitted().await;
        let other_host = Host::new(
            if resource == "memory" {
                100.0
            } else {
                1_000_000.0
            },
            0.0,
        );
        let mut options = other_host.options(dir.path());
        options.parallelism = if resource == "memory" { 64 } else { 1 };
        let other = open(options).await;
        let waiting = enqueue(
            &other,
            "sh_other",
            "ses_other",
            Spec::running(3).limits(|limits| {
                limits.memory_reserve_mb = if resource == "memory" { 50 } else { 1 };
            }),
        )
        .await;
        settle().await;
        assert!(
            !waiting.is_admitted(),
            "{resource}: the other queue ignored the running entry"
        );
        if resource == "memory" {
            *resident.lock().unwrap() = 100.0;
        } else {
            other_host.clock.store(60_000, Ordering::SeqCst);
        }
        waiting.admitted().await;
        let admitted = other
            .entries()
            .unwrap()
            .into_iter()
            .filter(|entry| entry.admitted)
            .count();
        assert_eq!(admitted, 2, "{resource}");
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_blocked_sample_does_not_make_a_live_owner_look_dead() {
    let dir = Temp::new("queue-heartbeat");
    let host = Host::new(1_000_000.0, 0.0);
    let block = Arc::new(AtomicBool::new(false));
    let mut options = host.options(dir.path());
    options.sample = {
        let block = block.clone();
        Arc::new(move || {
            if block.load(Ordering::SeqCst) {
                std::thread::sleep(Duration::from_millis(900));
            }
            Some(Sample {
                available_mb: 1_000_000.0,
                load: 0.0,
            })
        })
    };
    let left = open(options).await;
    let right = open(host.options(dir.path())).await;
    let holder = enqueue(&left, "sh_holder", "ses_holder", Spec::running(2)).await;
    holder.admitted().await;
    block.store(true, Ordering::SeqCst);
    let _waiting = enqueue(&left, "sh_waiting", "ses_waiting", Spec::running(2)).await;
    tokio::time::sleep(Duration::from_millis(700)).await;
    assert!(ids(&right).contains(&"sh_holder".to_string()));
    let behind = enqueue(&right, "sh_behind", "ses_behind", Spec::running(1)).await;
    settle().await;
    assert!(!behind.is_admitted());
    assert!(ids(&right).contains(&"sh_holder".to_string()));
}

#[tokio::test(flavor = "multi_thread")]
async fn removed_queue_files_are_restored_for_running_and_waiting_entries() {
    let root = Temp::new("queue-restore");
    let queue_dir = root.path().join("queue");
    let host = Host::new(1_000_000.0, 0.0);
    let owner = open(host.options(&queue_dir)).await;
    host.tick();
    let mut holder = enqueue(&owner, "sh_holder", "ses_holder", Spec::running(1)).await;
    holder.admitted().await;
    host.tick();
    let mut waiting = enqueue(&owner, "sh_waiting", "ses_waiting", Spec::running(1)).await;
    std::fs::rename(&queue_dir, root.path().join("lost")).unwrap();
    until(
        || ids(&owner) == ["sh_holder", "sh_waiting"],
        "the queue files were not restored",
    )
    .await;
    let foreign = open(host.options(&queue_dir)).await;
    host.tick();
    let mut behind = enqueue(&foreign, "sh_foreign", "ses_foreign", Spec::running(1)).await;
    settle().await;
    assert_eq!(behind.position, 2);
    assert!(!waiting.is_admitted() && !behind.is_admitted());
    assert_eq!(ids(&foreign), ["sh_foreign", "sh_holder", "sh_waiting"]);
    behind.release().await;
    waiting.release().await;
    holder.release().await;
    owner.shutdown().await;
    foreign.shutdown().await;
}

#[test]
fn queue_defaults_match_the_released_configuration() {
    assert_eq!(
        Limits::default(),
        Limits {
            max_running: 10,
            max_running_per_session: 1,
            max_queued_per_session: 16,
            memory_reserve_mb: 2_048,
            max_load: 1.0,
        }
    );
}

struct WorkerEntry {
    id: String,
    session: String,
    hold_ms: i64,
}

fn spawn_worker(
    dir: &Path,
    log: &Path,
    max_running: usize,
    entries: &[(&str, &str, i64)],
) -> Child {
    let spec = json!({
        "dir": dir,
        "log": log,
        "max_running": max_running,
        "entries": entries.iter().map(|(id, session, hold_ms)| json!({"id": id, "session": session, "hold_ms": hold_ms})).collect::<Vec<_>>(),
    });
    Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "queue_worker",
            "--ignored",
            "--nocapture",
            "--test-threads=1",
        ])
        .env("YCODING_QUEUE_WORKER", spec.to_string())
        .stdout(Stdio::null())
        .stderr(Stdio::inherit())
        .spawn()
        .unwrap()
}

#[test]
#[ignore = "child process of the multi-process queue tests"]
fn queue_worker() {
    let Ok(spec) = std::env::var("YCODING_QUEUE_WORKER") else {
        return;
    };
    let spec: serde_json::Value = serde_json::from_str(&spec).unwrap();
    let dir = spec["dir"].as_str().unwrap().to_owned();
    let log = spec["log"].as_str().unwrap().to_owned();
    let max_running = spec["max_running"].as_u64().unwrap() as usize;
    let entries: Vec<WorkerEntry> = spec["entries"]
        .as_array()
        .unwrap()
        .iter()
        .map(|entry| WorkerEntry {
            id: entry["id"].as_str().unwrap().to_owned(),
            session: entry["session"].as_str().unwrap().to_owned(),
            hold_ms: entry["hold_ms"].as_i64().unwrap(),
        })
        .collect();
    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(async move {
            let host = Host::new(1_000_000.0, 0.0);
            let mut options = host.options(Path::new(&dir));
            options.now = Arc::new(|| {
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_millis() as i64
            });
            let queue = open(options).await;
            let mut tasks = Vec::new();
            for entry in entries {
                let (queue, log) = (queue.clone(), log.clone());
                tasks.push(tokio::spawn(async move {
                    let mut ticket = queue
                        .enqueue(request(
                            &entry.id,
                            &entry.session,
                            Spec::running(max_running),
                        ))
                        .await
                        .unwrap();
                    std::fs::write(
                        format!("{log}.{}.queued", entry.id),
                        ticket.position().to_string(),
                    )
                    .unwrap();
                    ticket.admitted(|_| {}).await.unwrap();
                    let stamp = std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap()
                        .as_millis();
                    let mut file = std::fs::OpenOptions::new()
                        .create(true)
                        .append(true)
                        .open(&log)
                        .unwrap();
                    writeln!(file, "start {} {stamp} {}", entry.id, entry.session).unwrap();
                    if entry.hold_ms < 0 {
                        std::future::pending::<()>().await;
                    }
                    tokio::time::sleep(Duration::from_millis(entry.hold_ms as u64)).await;
                    writeln!(file, "end {} {stamp} {}", entry.id, entry.session).unwrap();
                }));
            }
            for task in tasks {
                task.await.unwrap();
            }
        });
}

fn log_has(log: &Path, needle: &str) -> bool {
    std::fs::read_to_string(log).is_ok_and(|text| text.contains(needle))
}

struct Reaper(Vec<Child>);
impl Drop for Reaper {
    fn drop(&mut self) {
        for child in &mut self.0 {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn separate_processes_sharing_one_directory_never_run_two_commands_at_once() {
    let dir = Temp::new("queue-processes");
    let log = dir.path().join("log");
    let mut children = Reaper(Vec::new());
    for (id, session) in [
        ("sh_proc_a", "ses_0"),
        ("sh_proc_b", "ses_1"),
        ("sh_proc_c", "ses_2"),
    ] {
        children
            .0
            .push(spawn_worker(dir.path(), &log, 1, &[(id, session, 300)]));
    }
    for child in &mut children.0 {
        assert!(child.wait().unwrap().success());
    }
    let events: Vec<String> = std::fs::read_to_string(&log)
        .unwrap()
        .lines()
        .map(|line| line.split(' ').next().unwrap().to_owned())
        .collect();
    assert_eq!(events.len(), 6);
    let mut running = 0;
    for kind in events {
        running += if kind == "start" { 1 } else { -1 };
        assert!(running <= 1);
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_process_that_dies_releases_its_slot_and_its_waiting_entry() {
    let dir = Temp::new("queue-dies");
    let log = dir.path().join("log");
    let mut holder = Reaper(vec![spawn_worker(
        dir.path(),
        &log,
        1,
        &[("sh_holder", "ses_holder", -1)],
    )]);
    until(
        || log_has(&log, "start sh_holder"),
        "the holder did not start",
    )
    .await;
    let mut waiter = Reaper(vec![spawn_worker(
        dir.path(),
        &log,
        1,
        &[("sh_waiter", "ses_waiter", -1)],
    )]);
    until(
        || dir.path().join("log.sh_waiter.queued").exists(),
        "the waiter did not queue",
    )
    .await;
    let host = Host::new(1_000_000.0, 0.0);
    let queue = open(host.wall_options(dir.path())).await;
    let local = enqueue(&queue, "sh_x_local", "ses_local", Spec::running(1)).await;
    assert_eq!(local.position, 2);
    waiter.0[0].kill().unwrap();
    waiter.0[0].wait().unwrap();
    until(
        || local.positions().contains(&1),
        "the dead waiter's place was not reclaimed",
    )
    .await;
    settle().await;
    assert!(!local.is_admitted());
    holder.0[0].kill().unwrap();
    holder.0[0].wait().unwrap();
    local.admitted().await;
    until(
        || !ids(&queue).contains(&"sh_holder".to_string()),
        "the dead holder's entry stayed",
    )
    .await;
    assert_eq!(ids(&queue), ["sh_x_local"]);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_stalled_live_owner_at_the_head_keeps_its_place_but_does_not_block_the_next_entry() {
    let dir = Temp::new("queue-stalled");
    let log = dir.path().join("log");
    let host = Host::new(1_000_000.0, 0.0);
    let queue = open(host.wall_options(dir.path())).await;
    let mut holder = enqueue(&queue, "sh_holder", "ses_holder", Spec::running(1)).await;
    holder.admitted().await;
    let stalled = Reaper(vec![spawn_worker(
        dir.path(),
        &log,
        1,
        &[("sh_stalled", "ses_stalled", -1)],
    )]);
    until(
        || dir.path().join("log.sh_stalled.queued").exists(),
        "the stalled worker did not queue",
    )
    .await;
    let mut local = enqueue(&queue, "sh_t_local", "ses_local", Spec::running(1)).await;
    assert_eq!(local.position, 2);
    let pid = stalled.0[0].id() as i32;
    assert_eq!(unsafe { libc::kill(pid, libc::SIGSTOP) }, 0);
    holder.release().await;
    local.admitted().await;
    assert!(!log_has(&log, "start sh_stalled"));
    assert_eq!(unsafe { libc::kill(pid, libc::SIGCONT) }, 0);
    settle().await;
    assert!(!log_has(&log, "start sh_stalled"));
    local.release().await;
    until(
        || log_has(&log, "start sh_stalled"),
        "the stalled entry never kept its place",
    )
    .await;
}
