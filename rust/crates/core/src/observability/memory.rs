use serde_json::{Value, json};
use std::{
    io,
    sync::mpsc::{self, Receiver, Sender},
    thread::{self, JoinHandle},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

const INTERVAL: Duration = Duration::from_secs(30);
const LIMIT: u8 = 120;

pub struct Scalar {
    pub rss_bytes: Option<u64>,
    pub rss_status: &'static str,
    pub peak_rss_bytes: Option<u64>,
    pub peak_rss_status: &'static str,
}

impl Scalar {
    pub fn sample() -> Self {
        Self::from_readings(current_rss(), peak_rss())
    }

    fn from_readings(rss: Reading, peak: Reading) -> Self {
        let (rss_bytes, rss_status) = match rss {
            Reading::Available(value) => (Some(value), "available"),
            Reading::Unsupported => (None, "unsupported"),
            Reading::Unavailable(_) => (None, "unavailable"),
            Reading::Error(_) => (None, "error"),
        };
        let (peak_rss_bytes, peak_rss_status) = match peak {
            Reading::Available(value) => (Some(value), "available"),
            Reading::Unsupported => (None, "unsupported"),
            Reading::Unavailable(_) => (None, "unavailable"),
            Reading::Error(_) => (None, "error"),
        };
        Self {
            rss_bytes,
            rss_status,
            peak_rss_bytes,
            peak_rss_status,
        }
    }
}

#[derive(Default)]
pub struct Telemetry {
    high_water_rss: Option<u64>,
    last_info_rss: Option<u64>,
    sampled: bool,
}

impl Telemetry {
    pub fn sample(
        &mut self,
        bound_locations: usize,
        standalone_locations: usize,
        full_locations: usize,
        active_generations: usize,
    ) {
        self.record(
            (bound_locations, standalone_locations, full_locations),
            active_generations,
            RuntimeSample::read(),
        );
    }

    fn record(
        &mut self,
        locations: (usize, usize, usize),
        active_generations: usize,
        sample: RuntimeSample,
    ) {
        let (bound_locations, standalone_locations, full_locations) = locations;
        let memory = Scalar::from_readings(sample.rss, sample.resources.peak_rss);
        let timestamp_ms = sample.timestamp_ms;
        let runtime_memory = sample.value();
        let info = !self.sampled
            || memory.rss_bytes.is_some_and(|rss| {
                self.high_water_rss.is_none_or(|high| rss > high)
                    || self
                        .last_info_rss
                        .is_none_or(|last| rss.abs_diff(last) >= 64 * 1024 * 1024)
            });
        self.sampled = true;
        if let Some(rss) = memory.rss_bytes {
            self.high_water_rss = Some(self.high_water_rss.map_or(rss, |high| high.max(rss)));
            if info {
                self.last_info_rss = Some(rss);
            }
        }
        if info {
            tracing::info!(component = "memory", rss_bytes = memory.rss_bytes,
                rss_status = memory.rss_status, peak_rss_bytes = memory.peak_rss_bytes,
                peak_rss_status = memory.peak_rss_status, heap_status = "unsupported",
                external_status = "unsupported", array_buffers_status = "unsupported",
                built_services_status = "unsupported", timestamp_ms, active_generations,
                runtime_memory = %runtime_memory,
                high_water_rss_bytes = self.high_water_rss, bound_locations, standalone_locations, full_locations,
                loaded_locations = bound_locations + standalone_locations, "runtime memory telemetry");
        } else {
            tracing::debug!(component = "memory", rss_bytes = memory.rss_bytes,
                rss_status = memory.rss_status, peak_rss_bytes = memory.peak_rss_bytes,
                peak_rss_status = memory.peak_rss_status, heap_status = "unsupported",
                external_status = "unsupported", array_buffers_status = "unsupported",
                built_services_status = "unsupported", timestamp_ms, active_generations,
                runtime_memory = %runtime_memory,
                high_water_rss_bytes = self.high_water_rss, bound_locations, standalone_locations, full_locations,
                loaded_locations = bound_locations + standalone_locations, "runtime memory telemetry");
        }
    }
}

pub struct Sampler {
    stop: Option<Sender<()>>,
    worker: Option<JoinHandle<()>>,
}

pub fn start(enabled: bool) -> io::Result<Sampler> {
    start_with(enabled, collect, emit, wait)
}

fn start_with(
    enabled: bool,
    mut collect: impl FnMut() -> Value + Send + 'static,
    mut emit: impl FnMut(u8, Value) + Send + 'static,
    mut wait: impl FnMut(&Receiver<()>, Duration) -> bool + Send + 'static,
) -> io::Result<Sampler> {
    if !enabled {
        return Ok(Sampler {
            stop: None,
            worker: None,
        });
    }
    let (stop, stopped) = mpsc::channel();
    let (ready, initialized) = mpsc::sync_channel(1);
    let dispatch = tracing::dispatcher::get_default(Clone::clone);
    let worker = thread::Builder::new()
        .name("ycoding-memory".into())
        .spawn(move || {
            tracing::dispatcher::with_default(&dispatch, || {
                for sequence in 1..=LIMIT {
                    if sequence > 1 && !wait(&stopped, INTERVAL) {
                        return;
                    }
                    if !matches!(stopped.try_recv(), Err(mpsc::TryRecvError::Empty)) {
                        return;
                    }
                    emit(sequence, collect());
                    if sequence == 1 {
                        let _ = ready.send(());
                    }
                }
            });
        })?;
    let mut sampler = Sampler {
        stop: Some(stop),
        worker: Some(worker),
    };
    if initialized.recv().is_err() {
        sampler.close()?;
        return Err(io::Error::other("memory sampler did not initialize"));
    }
    Ok(sampler)
}

impl Sampler {
    pub fn close(&mut self) -> io::Result<()> {
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
        }
        self.worker.take().map_or(Ok(()), |worker| {
            worker
                .join()
                .map_err(|_| io::Error::other("memory sampler worker failed"))
        })
    }
}

impl Drop for Sampler {
    fn drop(&mut self) {
        let _ = self.close();
    }
}

fn wait(stopped: &Receiver<()>, interval: Duration) -> bool {
    matches!(
        stopped.recv_timeout(interval),
        Err(mpsc::RecvTimeoutError::Timeout)
    )
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Reading {
    Available(u64),
    Unsupported,
    Unavailable(&'static str),
    Error(&'static str),
}

fn bytes(value: u64, scale: u64) -> Reading {
    match value.checked_mul(scale) {
        Some(0) => Reading::Unavailable("not-reported"),
        Some(value) => Reading::Available(value),
        None => Reading::Error("invalid-reading"),
    }
}

fn metric(reading: Reading, source: &str, basis: &str, unit: &str) -> Value {
    let mut value = json!({ "source": source, "basis": basis, "unit": unit });
    match reading {
        Reading::Available(number) => {
            value["status"] = json!("available");
            value["value"] = json!(number);
        }
        Reading::Unsupported => {
            value["status"] = json!("unsupported");
            value["reason"] = json!("api-unavailable");
        }
        Reading::Unavailable(reason) | Reading::Error(reason) => {
            value["status"] = json!(if matches!(reading, Reading::Error(_)) {
                "error"
            } else {
                "unavailable"
            });
            value["reason"] = json!(reason);
        }
    }
    value
}

#[derive(Clone, Copy)]
struct ResourceSummary {
    peak_rss: Reading,
    minor_faults: Reading,
    major_faults: Reading,
}

impl ResourceSummary {
    #[cfg(any(target_os = "linux", target_os = "macos", test))]
    fn from_raw(
        peak_rss: std::ffi::c_long,
        minor_faults: std::ffi::c_long,
        major_faults: std::ffi::c_long,
    ) -> Self {
        Self {
            peak_rss: peak_bytes(peak_rss),
            minor_faults: counter(minor_faults),
            major_faults: counter(major_faults),
        }
    }

    fn unavailable(reading: Reading) -> Self {
        Self {
            peak_rss: reading,
            minor_faults: reading,
            major_faults: reading,
        }
    }
}

struct RuntimeSample {
    timestamp_ms: Option<u64>,
    rss: Reading,
    resources: ResourceSummary,
}

impl RuntimeSample {
    fn read() -> Self {
        Self {
            timestamp_ms: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .ok()
                .and_then(|duration| duration.as_millis().try_into().ok()),
            rss: current_rss(),
            resources: resource_summary(),
        }
    }

    fn value(self) -> Value {
        let rss_source = if cfg!(target_os = "linux") {
            "/proc/self/status:VmRSS"
        } else {
            "none"
        };
        let native = cfg!(any(target_os = "linux", target_os = "macos"));
        json!({
            "timestampMs": self.timestamp_ms,
            "timestampStatus": if self.timestamp_ms.is_some() { "available" } else { "unavailable" },
            "runtime": { "name": "rust", "version": "unknown", "platform": std::env::consts::OS },
            "rss": metric(self.rss, rss_source, "current", "bytes"),
            "peakRss": metric(self.resources.peak_rss, if native { "getrusage(RUSAGE_SELF).ru_maxrss" } else { "none" }, "process-lifetime-peak", "bytes"),
            "commit": {
                "current": metric(Reading::Unsupported, "none", "current", "bytes"),
                "peak": metric(Reading::Unsupported, "none", "process-lifetime-peak", "bytes"),
            },
            "pageFaults": {
                "minor": metric(self.resources.minor_faults, if native { "getrusage(RUSAGE_SELF).ru_minflt" } else { "none" }, "process-lifetime-counter", "count"),
                "major": metric(self.resources.major_faults, if native { "getrusage(RUSAGE_SELF).ru_majflt" } else { "none" }, "process-lifetime-counter", "count"),
            },
            "heap": {
                "size": metric(Reading::Unsupported, "none", "current", "bytes"),
                "capacity": metric(Reading::Unsupported, "none", "current", "bytes"),
                "external": metric(Reading::Unsupported, "none", "current", "bytes"),
            },
            "nativeAllocations": metric(Reading::Unavailable("not-measured"), "none", "unverified", "bytes"),
            "allocatorRetained": metric(Reading::Unavailable("not-measured"), "none", "unverified", "bytes"),
        })
    }
}

fn collect() -> Value {
    RuntimeSample::read().value()
}

fn emit(sequence: u8, sample: Value) {
    tracing::debug!(component = "memory", role = "server", sequence, sample = %sample, "memory sample");
}

#[cfg(target_os = "linux")]
fn current_rss() -> Reading {
    use std::io::Read;
    let mut contents = Vec::new();
    let result = std::fs::File::open("/proc/self/status")
        .and_then(|file| file.take(65_537).read_to_end(&mut contents));
    if result.is_err() {
        return Reading::Error("read-failed");
    }
    if contents.len() > 65_536 {
        return Reading::Error("invalid-reading");
    }
    match std::str::from_utf8(&contents) {
        Ok(status) => proc_rss(status),
        Err(_) => Reading::Error("invalid-reading"),
    }
}

#[cfg(not(target_os = "linux"))]
fn current_rss() -> Reading {
    Reading::Unsupported
}

#[cfg(any(target_os = "linux", test))]
fn proc_rss(status: &str) -> Reading {
    let Some(line) = status.lines().find_map(|line| line.strip_prefix("VmRSS:")) else {
        return Reading::Unavailable("no-reading");
    };
    let mut fields = line.split_whitespace();
    let Some(value) = fields.next().and_then(|value| value.parse::<u64>().ok()) else {
        return Reading::Error("invalid-reading");
    };
    if fields.next() != Some("kB") || fields.next().is_some() {
        return Reading::Error("invalid-reading");
    }
    bytes(value, 1024)
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn read_usage() -> Result<libc::rusage, Reading> {
    let mut usage: libc::rusage = unsafe { std::mem::zeroed() };
    if unsafe { libc::getrusage(libc::RUSAGE_SELF, &mut usage) } != 0 {
        return Err(Reading::Error("read-failed"));
    }
    Ok(usage)
}

#[cfg(any(target_os = "linux", target_os = "macos", test))]
fn counter(value: std::ffi::c_long) -> Reading {
    u64::try_from(value).map_or(Reading::Error("invalid-reading"), Reading::Available)
}

#[cfg(any(target_os = "linux", target_os = "macos", test))]
fn peak_bytes(value: std::ffi::c_long) -> Reading {
    match counter(value) {
        Reading::Available(value) => bytes(value, if cfg!(target_os = "macos") { 1 } else { 1024 }),
        reading => reading,
    }
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn resource_summary() -> ResourceSummary {
    match read_usage() {
        Ok(usage) => ResourceSummary::from_raw(usage.ru_maxrss, usage.ru_minflt, usage.ru_majflt),
        Err(reading) => ResourceSummary::unavailable(reading),
    }
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn resource_summary() -> ResourceSummary {
    ResourceSummary::unavailable(Reading::Unsupported)
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn peak_rss() -> Reading {
    match read_usage() {
        Ok(usage) => peak_bytes(usage.ru_maxrss),
        Err(reading) => reading,
    }
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn peak_rss() -> Reading {
    Reading::Unsupported
}

#[cfg(test)]
mod tests;
