use std::time::{Duration, Instant};
use ycoding_core::platform::shell::queue;

fn vm_stat(free: u64, inactive: u64, speculative: u64) -> String {
    format!(
        "Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free:                                     {free}.\nPages active:                                 398519.\nPages inactive:                               {inactive}.\nPages speculative:                              {speculative}.\nPages throttled:                                   0.\nPages wired down:                             301818.\nPages purgeable:                                1781.\n"
    )
}

#[test]
fn macos_availability_counts_free_inactive_and_speculative_pages_without_purgeable_pages() {
    assert_eq!(
        queue::vm_stat_available_mb(&vm_stat(5_250, 393_968, 2_792)),
        Some(((5_250_u64 + 393_968 + 2_792) * 16_384) as f64 / 1024.0 / 1024.0)
    );
    assert_eq!(queue::vm_stat_available_mb("Pages free: 1."), None);
}

#[test]
fn linux_availability_reads_memavailable_and_rejects_a_missing_or_malformed_line() {
    let meminfo = "MemTotal:       16384000 kB\nMemFree:          512000 kB\nMemAvailable:    2048000 kB\nBuffers:           1024 kB\n";
    assert_eq!(queue::meminfo_available_mb(meminfo), Some(2_000.0));
    assert_eq!(queue::meminfo_available_mb("MemFree: 512000 kB\n"), None);
    assert_eq!(queue::meminfo_available_mb("MemAvailable: lots kB\n"), None);
    assert_eq!(queue::meminfo_available_mb("MemAvailable: 2048000\n"), None);
    assert_eq!(queue::meminfo_available_mb("MemAvailable: -1 kB\n"), None);
}

#[test]
fn a_failed_primary_source_falls_back_to_free_memory_and_never_invents_headroom() {
    assert_eq!(
        queue::available_with_fallback(None, || Some(512.0)),
        Some(512.0)
    );
    assert_eq!(
        queue::available_with_fallback(Some(100.0), || panic!("unused")),
        Some(100.0)
    );
    assert_eq!(queue::available_with_fallback(None, || None), None);
}

#[test]
fn the_host_sample_reports_positive_memory_and_a_finite_normalized_load() {
    let sample = queue::host_sample().expect("the host reports memory and load");
    assert!(sample.available_mb > 0.0 && sample.available_mb.is_finite());
    assert!(sample.load.is_finite() && sample.load >= 0.0);
}

#[cfg(unix)]
#[test]
fn a_sampler_command_returns_its_output_and_one_that_outlives_its_deadline_is_killed_and_reaped() {
    let output = queue::output_within("echo", &["sampled"], Duration::from_secs(5)).unwrap();
    assert_eq!(output.as_deref(), Some("sampled\n"));
    assert_eq!(
        queue::output_within("false", &[], Duration::from_secs(5)).unwrap(),
        None
    );

    let directory =
        std::env::temp_dir().join(format!("ycoding-host-sample-{}", std::process::id()));
    std::fs::create_dir_all(&directory).unwrap();
    let pid_file = directory.join("pid");
    let script = format!("echo $$ > '{}'; exec sleep 30", pid_file.display());
    let started = Instant::now();
    let error =
        queue::output_within("sh", &["-c", &script], Duration::from_millis(300)).unwrap_err();
    assert_eq!(error.kind(), std::io::ErrorKind::TimedOut);
    assert!(started.elapsed() < Duration::from_secs(5));
    let pid: i32 = std::fs::read_to_string(&pid_file)
        .unwrap()
        .trim()
        .parse()
        .unwrap();
    assert_eq!(
        unsafe { libc::kill(pid, 0) },
        -1,
        "the sampler command is still running"
    );
    assert_eq!(
        std::io::Error::last_os_error().raw_os_error(),
        Some(libc::ESRCH)
    );
    std::fs::remove_dir_all(&directory).unwrap();
}
