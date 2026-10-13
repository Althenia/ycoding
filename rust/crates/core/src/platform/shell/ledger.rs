use super::super::process::{self, Command, RunOptions};
use std::{collections::BTreeSet, io, ops::Bound, time::Duration};
use ycoding_schema::{DomainEncode, JsonValue, LosslessString, shell::Id};
use ycoding_store::{
    Client, Error, IndexOrder, IndexQuery, KeyPart, Snapshot, TableSpec, Write,
    resources::{Shell, ShellTable},
    session::{EventTable, SessionTable},
    tuple_key,
};

pub const TERMINATE_GRACE: Duration = Duration::from_secs(3);
const STARTED_TYPE: &str = "session.execution.started.1";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Process {
    pub pid: u32,
    pub pgid: u32,
    pub started: String,
}

pub async fn processes() -> io::Result<Vec<Process>> {
    let mut command = Command::new("ps", ["-axo", "pid=,pgid=,lstart="]);
    command.stdin = process::Input::Ignore;
    command.env.insert("LC_ALL".into(), "C".into());
    command.env.insert("TZ".into(), "UTC".into());
    let result = process::run(
        command,
        RunOptions {
            max_output_bytes: Some(4 * 1024 * 1024),
            max_error_bytes: Some(1024),
            ..Default::default()
        },
    )
    .await?;
    result.require_success()?;
    Ok(String::from_utf8_lossy(&result.stdout)
        .lines()
        .filter_map(|line| {
            let fields: Vec<_> = line.split_whitespace().collect();
            (fields.len() >= 3).then_some(())?;
            Some(Process {
                pid: fields[0].parse().ok()?,
                pgid: fields[1].parse().ok()?,
                started: fields[2..].join(" "),
            })
        })
        .collect())
}

pub async fn identify(pid: u32) -> Option<Process> {
    processes()
        .await
        .ok()?
        .into_iter()
        .find(|item| item.pid == pid)
}

#[derive(Clone)]
pub struct Ledger(Client);

#[derive(Default, Debug)]
pub struct Reconciliation {
    pub process_list_unavailable: bool,
    pub signal_failures: Vec<(LosslessString, String)>,
}

impl Ledger {
    pub fn new(store: Client) -> Self {
        Self(store)
    }

    pub async fn record(
        &self,
        id: &Id,
        pid: u32,
        started: Option<String>,
        owner: &Process,
    ) -> Result<(), Error> {
        let row = Shell {
            id: shell_id(id),
            session_id: None,
            pid: i64::from(pid),
            process_started: started.map(Into::into),
            owner_pid: i64::from(owner.pid),
            owner_started: owner.started.clone().into(),
            notice_pending: 0,
            time_created: super::super::now() as i64,
            time_lost: None,
            start_seq: -1,
        };
        self.0.submit(move |tx| ShellTable::insert(tx, &row))?.await
    }

    pub async fn release(&self, id: &Id) -> Result<(), Error> {
        let key = key(&shell_id(id));
        self.0
            .submit(move |tx| {
                if tx
                    .get::<ShellTable>(&key)?
                    .is_some_and(|row| row.notice_pending == 0)
                {
                    tx.delete::<ShellTable>(&key)?;
                }
                Ok(())
            })?
            .await
    }

    pub async fn notice_owed(
        &self,
        id: &Id,
        session_id: ycoding_schema::session_id::SessionId,
    ) -> Result<(), Error> {
        let key = key(&shell_id(id));
        self.0
            .submit(move |tx| {
                if let Some(mut row) = tx.get::<ShellTable>(&key)? {
                    row.session_id = Some(session_id.into_lossless());
                    row.notice_pending = 1;
                    ShellTable::put(tx, &row)?;
                }
                Ok(())
            })?
            .await
    }

    pub async fn notice_admitted(&self, id: &Id) -> Result<(), Error> {
        let key = key(&shell_id(id));
        self.0
            .submit(move |tx| {
                tx.delete::<ShellTable>(&key)?;
                Ok(())
            })?
            .await
    }

    pub fn lost_sessions(&self) -> Result<Vec<LosslessString>, Error> {
        let snapshot = self.0.snapshot()?;
        let mut sessions = BTreeSet::new();
        for row in rows::<ShellTable>(&snapshot)? {
            if row.time_lost.is_none() {
                continue;
            }
            if let Some(id) = row.session_id
                && snapshot.get::<SessionTable>(&key(&id))?.is_some()
            {
                let prefix = started_prefix(&id);
                let latest = snapshot
                    .index_range::<EventTable>(
                        "event_aggregate_type_seq_idx",
                        started_query(&prefix),
                    )?
                    .first()
                    .map_or(-1, |event| event.record.seq);
                if latest <= row.start_seq {
                    sessions.insert(id);
                }
            }
        }
        Ok(sessions.into_iter().collect())
    }

    pub async fn reconcile(&self, grace: Duration) -> io::Result<Reconciliation> {
        let pending = self
            .0
            .submit(|tx| {
                let mut pending = Vec::new();
                let mut cursor = None;
                loop {
                    let page = tx.scan::<ShellTable>(
                        cursor.as_deref().map_or(Bound::Unbounded, Bound::Excluded),
                        Bound::Unbounded,
                        128,
                    )?;
                    cursor = page.last().map(ShellTable::primary_key);
                    for row in page {
                        if row.time_lost.is_none() {
                            pending.push(row);
                            continue;
                        }
                        let unacknowledged = match &row.session_id {
                            Some(id) => {
                                tx.get::<SessionTable>(&key(id))?.is_some()
                                    && latest_start(tx, id)? <= row.start_seq
                            }
                            None => false,
                        };
                        if !unacknowledged {
                            tx.delete::<ShellTable>(&ShellTable::primary_key(&row))?;
                        }
                    }
                    if cursor.is_none() {
                        break;
                    }
                }
                Ok(pending)
            })
            .map_err(io::Error::other)?
            .await
            .map_err(io::Error::other)?;
        let mut report = Reconciliation::default();
        if pending.is_empty() {
            return Ok(report);
        }
        let snapshot = match processes().await {
            Ok(snapshot) => snapshot,
            Err(_) => {
                report.process_list_unavailable = true;
                return Ok(report);
            }
        };
        let mut work = tokio::task::JoinSet::new();
        for mut row in pending {
            if snapshot.iter().any(|item| {
                i64::from(item.pid) == row.owner_pid
                    && item.started == row.owner_started.as_str().unwrap_or_default()
            }) {
                continue;
            }
            let alive = survivors(&row, &snapshot);
            let store = self.0.clone();
            work.spawn(async move {
                let mut failures = Vec::new();
                if alive {
                    if let Err(error) = signal(&row, false) {
                        failures.push((row.id.clone(), error.to_string()));
                    }
                    let deadline = tokio::time::Instant::now() + grace;
                    let mut exited = false;
                    while tokio::time::Instant::now() < deadline {
                        tokio::time::sleep(Duration::from_millis(100).min(grace)).await;
                        if processes().await.is_ok_and(|after| survivors(&row, &after)) {
                            continue;
                        }
                        exited = true;
                        break;
                    }
                    if !exited && let Err(error) = signal(&row, true) {
                        failures.push((row.id.clone(), error.to_string()));
                    }
                }
                store
                    .submit(move |tx| {
                        if row.notice_pending == 0 || row.session_id.is_none() {
                            tx.delete::<ShellTable>(&ShellTable::primary_key(&row))?;
                            return Ok(());
                        }
                        row.time_lost = Some(super::super::now() as i64);
                        row.start_seq =
                            latest_start(tx, row.session_id.as_ref().expect("owed session"))?;
                        ShellTable::put(tx, &row)
                    })
                    .map_err(io::Error::other)?
                    .await
                    .map_err(io::Error::other)?;
                Ok::<_, io::Error>(failures)
            });
        }
        while let Some(result) = work.join_next().await {
            report
                .signal_failures
                .extend(result.map_err(io::Error::other)??);
        }
        Ok(report)
    }
}

fn latest_start(tx: &mut Write<'_>, session: &LosslessString) -> Result<i64, Error> {
    let prefix = started_prefix(session);
    Ok(tx
        .index_range::<EventTable>("event_aggregate_type_seq_idx", started_query(&prefix))?
        .first()
        .map_or(-1, |event| event.record.seq))
}
fn started_prefix(session: &LosslessString) -> Vec<u8> {
    tuple_key(&[
        KeyPart::String(session),
        KeyPart::String(&STARTED_TYPE.into()),
    ])
}
fn started_query(prefix: &[u8]) -> IndexQuery<'_> {
    IndexQuery {
        lower: Bound::Unbounded,
        upper: Bound::Unbounded,
        prefix: Some(prefix),
        order: IndexOrder::Descending,
        after: None,
        limit: 1,
    }
}

pub fn survivors(row: &Shell, snapshot: &[Process]) -> bool {
    if let Some(leader) = snapshot.iter().find(|item| i64::from(item.pid) == row.pid) {
        return row
            .process_started
            .as_ref()
            .and_then(LosslessString::as_str)
            == Some(leader.started.as_str());
    }
    snapshot.iter().any(|item| i64::from(item.pgid) == row.pid)
}

fn signal(row: &Shell, force: bool) -> io::Result<()> {
    #[cfg(unix)]
    {
        let pid = i32::try_from(row.pid).map_err(io::Error::other)?;
        if pid <= 0 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "Invalid shell PID",
            ));
        }
        if unsafe { libc::kill(-pid, if force { libc::SIGKILL } else { libc::SIGTERM }) } != 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }
    #[cfg(windows)]
    {
        let _ = (row, force);
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "POSIX shell reconciliation is unavailable on Windows",
        ))
    }
}

fn rows<T: TableSpec>(snapshot: &Snapshot) -> Result<Vec<T::Record>, Error> {
    let mut rows = Vec::new();
    let mut cursor = None;
    loop {
        let page = snapshot.scan::<T>(
            cursor.as_deref().map_or(Bound::Unbounded, Bound::Excluded),
            Bound::Unbounded,
            128,
        )?;
        cursor = page.last().map(T::primary_key);
        rows.extend(page);
        if cursor.is_none() {
            return Ok(rows);
        }
    }
}

fn shell_id(id: &Id) -> LosslessString {
    let JsonValue::String(id) = id.encode() else {
        unreachable!("shell ID encodes as string")
    };
    id
}
fn key(id: &LosslessString) -> Vec<u8> {
    tuple_key(&[KeyPart::String(id)])
}
