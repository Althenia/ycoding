use crate::{
    convert,
    dispatch::{Failure, Invocation},
    services::Environment,
};
use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex, MutexGuard, PoisonError},
    time::{Duration, Instant},
};
use ycoding_core::resources::attachment_store;
use ycoding_protocol::v5;

pub const TTL: Duration = Duration::from_secs(10 * 60);
pub const SCHEME: &str = "ycoding-upload://";
const MAX_CHUNKS: u64 = 1_024;
const MAX_CHUNK_BYTES: usize = 21_000;
const MAX_BYTES: usize = attachment_store::MAX_BYTES;
const MAX_CONNECTION_BYTES: usize = 40 * 1024 * 1024;
const MAX_UPLOADS: usize = 64;

pub type Clock = Arc<dyn Fn() -> Duration + Send + Sync>;

pub struct Piece<'a> {
    pub id: &'a str,
    pub index: u64,
    pub offset: u64,
    pub last: bool,
    pub data: &'a [u8],
}

#[derive(Debug, PartialEq, Eq)]
pub enum Appended {
    Received(u64),
    Complete(String),
}

struct Upload {
    session: String,
    chunks: u64,
    bytes: Vec<u8>,
    complete: bool,
    expires: Duration,
}

type Uploads = BTreeMap<(String, String), Upload>;

// Staged pieces belong to one relay connection and Session, as in the TypeScript
// bridge: the connector gives each connection its own Environment and clears this
// owner when the connection ends.
pub struct Staging {
    uploads: Mutex<Uploads>,
    clock: Clock,
}

impl Default for Staging {
    fn default() -> Self {
        let start = Instant::now();
        Self::with_clock(Arc::new(move || start.elapsed()))
    }
}

impl Staging {
    pub fn with_clock(clock: Clock) -> Self {
        Self {
            uploads: Mutex::new(BTreeMap::new()),
            clock,
        }
    }

    pub fn append(
        &self,
        connection: &str,
        session: &str,
        piece: Piece<'_>,
    ) -> Result<Appended, Failure> {
        let (now, mut uploads) = self.current();
        if !uuid(piece.id)
            || piece.index >= MAX_CHUNKS
            || piece.data.is_empty()
            || piece.data.len() > MAX_CHUNK_BYTES
        {
            return Err(invalid("Invalid attachment upload chunk"));
        }
        let key = (connection.to_owned(), piece.id.to_owned());
        match uploads.get(&key) {
            Some(existing)
                if existing.session != session
                    || existing.complete
                    || existing.chunks != piece.index
                    || existing.bytes.len() as u64 != piece.offset =>
            {
                return Err(invalid(
                    "Attachment chunks must arrive once, in order, for one Session",
                ));
            }
            None if piece.index != 0 || piece.offset != 0 => {
                return Err(invalid(
                    "Attachment chunks must arrive once, in order, for one Session",
                ));
            }
            _ => {}
        }
        let (count, total) = uploads
            .iter()
            .filter(|((owner, _), _)| owner == connection)
            .fold((0, 0), |(count, total), (_, upload)| {
                (count + 1, total + upload.bytes.len())
            });
        if !uploads.contains_key(&key) && count >= MAX_UPLOADS {
            return Err(too_large(
                "Too many attachment uploads are retained on this connection",
            ));
        }
        let current = uploads.get(&key).map_or(0, |upload| upload.bytes.len());
        if current + piece.data.len() > MAX_BYTES || total + piece.data.len() > MAX_CONNECTION_BYTES
        {
            uploads.remove(&key);
            return Err(too_large("Attachment exceeds the upload size limit"));
        }
        let upload = uploads.entry(key).or_insert_with(|| Upload {
            session: session.to_owned(),
            chunks: 0,
            bytes: Vec::new(),
            complete: false,
            expires: now,
        });
        upload.chunks += 1;
        upload.bytes.extend_from_slice(piece.data);
        upload.complete = piece.last;
        upload.expires = now + TTL;
        Ok(if piece.last {
            Appended::Complete(format!("{SCHEME}{}", piece.id))
        } else {
            Appended::Received(upload.bytes.len() as u64)
        })
    }

    pub fn resolve(&self, connection: &str, session: &str, uri: &str) -> Result<Vec<u8>, Failure> {
        let (now, mut uploads) = self.current();
        let id = uri.strip_prefix(SCHEME).unwrap_or_default();
        let upload = uploads
            .get_mut(&(connection.to_owned(), id.to_owned()))
            .filter(|upload| upload.session == session && upload.complete)
            .ok_or_else(|| invalid("Attachment upload is unavailable or incomplete"))?;
        upload.expires = now + TTL;
        Ok(upload.bytes.clone())
    }

    pub fn clear(&self) {
        self.lock().clear();
    }

    pub fn retained(&self) -> (usize, usize) {
        let (_, uploads) = self.current();
        (
            uploads.len(),
            uploads.values().map(|upload| upload.bytes.len()).sum(),
        )
    }

    fn current(&self) -> (Duration, MutexGuard<'_, Uploads>) {
        let now = (self.clock)();
        let mut uploads = self.lock();
        uploads.retain(|_, upload| upload.expires > now);
        (now, uploads)
    }

    fn lock(&self) -> MutexGuard<'_, BTreeMap<(String, String), Upload>> {
        self.uploads.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

pub(crate) struct Release(pub(crate) Arc<Environment>);

impl Drop for Release {
    fn drop(&mut self) {
        self.0.uploads.clear();
    }
}

pub async fn upload(
    invocation: Invocation,
    request: v5::SessionAttachmentUploadRequest,
) -> Result<v5::SessionAttachmentUploadResult, Failure> {
    let Some(v5::scope::Target::Session(session)) = &invocation.scope.target else {
        return Err(invalid("Attachment upload requires a Session"));
    };
    let payload = request.payload;
    let id = convert::domain(&payload.upload_id)?
        .to_utf8()
        .map_err(|_| invalid("Invalid attachment upload chunk"))?;
    let appended = invocation.environment.uploads.append(
        &invocation.connection_id,
        session,
        Piece {
            id: &id,
            index: payload.index,
            offset: payload.offset,
            last: payload.last,
            data: &payload.data,
        },
    )?;
    Ok(v5::SessionAttachmentUploadResult {
        kind: Some(match appended {
            Appended::Received(received) => v5::session_attachment_upload_result::Kind::Value2(
                v5::SessionAttachmentUploadResultValue2 { received },
            ),
            Appended::Complete(uri) => v5::session_attachment_upload_result::Kind::Value1(
                v5::SessionAttachmentUploadResultValue1 {
                    uri: convert::text(&uri),
                },
            ),
        }),
    })
}

fn uuid(id: &str) -> bool {
    let bytes = id.as_bytes();
    let hex = |range: std::ops::Range<usize>| {
        bytes[range]
            .iter()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(byte))
    };
    bytes.len() == 36
        && [8, 13, 18, 23].iter().all(|index| bytes[*index] == b'-')
        && hex(0..8)
        && hex(9..13)
        && bytes[14] == b'4'
        && hex(15..18)
        && matches!(bytes[19], b'8' | b'9' | b'a' | b'b')
        && hex(20..23)
        && hex(24..36)
}

fn invalid(message: &'static str) -> Failure {
    Failure::Connector { code: 1, message }
}

fn too_large(message: &'static str) -> Failure {
    Failure::Connector { code: 2, message }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    const ID: &str = "1b4e28ba-2fa1-4d3b-9b5a-3f2b8f6c9d10";

    fn id(n: usize) -> String {
        format!("1b4e28ba-2fa1-4d3b-9b5a-{n:012x}")
    }

    fn piece<'a>(id: &'a str, index: u64, offset: u64, last: bool, data: &'a [u8]) -> Piece<'a> {
        Piece {
            id,
            index,
            offset,
            last,
            data,
        }
    }

    fn code(result: Result<Appended, Failure>) -> i32 {
        match result {
            Err(Failure::Connector { code, .. }) => code,
            other => panic!("expected a connector failure, got {other:?}"),
        }
    }

    fn manual() -> (Staging, Arc<AtomicU64>) {
        let elapsed = Arc::new(AtomicU64::new(0));
        let clock = elapsed.clone();
        (
            Staging::with_clock(Arc::new(move || {
                Duration::from_secs(clock.load(Ordering::Acquire))
            })),
            elapsed,
        )
    }

    #[test]
    fn pieces_arrive_once_in_order_for_one_session_and_connection() {
        let staging = Staging::default();
        assert_eq!(
            staging.append("c", "s", piece(ID, 0, 0, false, b"abc")),
            Ok(Appended::Received(3))
        );
        for rejected in [
            piece(ID, 0, 0, false, b"abc"),
            piece(ID, 2, 3, false, b"d"),
            piece(ID, 1, 2, false, b"d"),
        ] {
            assert_eq!(code(staging.append("c", "s", rejected)), 1);
        }
        assert_eq!(
            code(staging.append("c", "other", piece(ID, 1, 3, true, b"d"))),
            1
        );
        assert_eq!(
            code(staging.append("c", "s", piece(&id(9), 1, 0, true, b"d"))),
            1
        );
        assert_eq!(
            staging.append("c", "s", piece(ID, 1, 3, true, b"def")),
            Ok(Appended::Complete(format!("ycoding-upload://{ID}")))
        );
        assert_eq!(
            code(staging.append("c", "s", piece(ID, 2, 6, true, b"g"))),
            1
        );
        for invalid in [
            piece("not-a-uuid", 0, 0, true, b"x"),
            piece("1b4e28ba-2fa1-3d3b-9b5a-3f2b8f6c9d10", 0, 0, true, b"x"),
            piece("1B4E28BA-2FA1-4D3B-9B5A-3F2B8F6C9D10", 0, 0, true, b"x"),
            piece(&id(1), 1024, 0, true, b"x"),
            piece(&id(1), 0, 0, true, b""),
            piece(&id(1), 0, 0, true, &[0; MAX_CHUNK_BYTES + 1]),
        ] {
            assert_eq!(code(staging.append("c", "s", invalid)), 1);
        }
        let uri = format!("ycoding-upload://{ID}");
        assert_eq!(staging.resolve("c", "s", &uri).unwrap(), b"abcdef");
        for (connection, session) in [("other", "s"), ("c", "other")] {
            assert!(staging.resolve(connection, session, &uri).is_err());
        }
    }

    #[test]
    fn connections_hold_at_most_sixty_four_uploads_and_forty_mebibytes() {
        let staging = Staging::default();
        for n in 0..MAX_UPLOADS {
            staging
                .append("c", "s", piece(&id(n), 0, 0, true, b"x"))
                .unwrap();
        }
        assert_eq!(
            code(staging.append("c", "s", piece(&id(64), 0, 0, true, b"x"))),
            2
        );
        staging
            .append("d", "s", piece(&id(64), 0, 0, true, b"x"))
            .unwrap();
        let staging = Staging::default();
        let chunk = vec![7; MAX_CHUNK_BYTES];
        let mut offset = 0;
        let mut index = 0;
        while offset + MAX_CHUNK_BYTES <= MAX_BYTES {
            staging
                .append("c", "s", piece(&id(1), index, offset as u64, false, &chunk))
                .unwrap();
            offset += MAX_CHUNK_BYTES;
            index += 1;
        }
        let rest = vec![7; MAX_BYTES - offset];
        staging
            .append("c", "s", piece(&id(1), index, offset as u64, true, &rest))
            .unwrap();
        assert_eq!(staging.retained(), (1, MAX_BYTES));
        offset = 0;
        index = 0;
        while offset + MAX_CHUNK_BYTES <= MAX_BYTES {
            staging
                .append("c", "s", piece(&id(2), index, offset as u64, false, &chunk))
                .unwrap();
            offset += MAX_CHUNK_BYTES;
            index += 1;
        }
        assert_eq!(
            code(staging.append("c", "s", piece(&id(2), index, offset as u64, false, &chunk))),
            2,
            "one upload is bounded at 20 MiB"
        );
        assert_eq!(
            staging.retained(),
            (1, MAX_BYTES),
            "the oversized upload is dropped"
        );
        let staging = Staging::default();
        for n in 0..2 {
            let mut offset = 0;
            let mut index = 0;
            while offset < MAX_BYTES {
                let length = MAX_CHUNK_BYTES.min(MAX_BYTES - offset);
                staging
                    .append(
                        "c",
                        "s",
                        piece(
                            &id(n),
                            index,
                            offset as u64,
                            offset + length == MAX_BYTES,
                            &chunk[..length],
                        ),
                    )
                    .unwrap();
                offset += length;
                index += 1;
            }
        }
        assert_eq!(
            code(staging.append("c", "s", piece(&id(3), 0, 0, true, b"x"))),
            2
        );
        staging
            .append("d", "s", piece(&id(3), 0, 0, true, b"x"))
            .unwrap();
    }

    #[test]
    fn idle_uploads_expire_after_ten_minutes_and_resolution_renews_them() {
        let (staging, elapsed) = manual();
        staging
            .append("c", "s", piece(ID, 0, 0, false, b"ab"))
            .unwrap();
        elapsed.store(TTL.as_secs(), Ordering::Release);
        assert_eq!(staging.retained(), (0, 0));
        assert_eq!(
            code(staging.append("c", "s", piece(ID, 1, 2, true, b"cd"))),
            1,
            "an expired upload accepts no further pieces"
        );
        let uri = format!("ycoding-upload://{ID}");
        staging
            .append("c", "s", piece(ID, 0, 0, true, b"ab"))
            .unwrap();
        elapsed.store(TTL.as_secs() * 2 - 1, Ordering::Release);
        assert_eq!(staging.resolve("c", "s", &uri).unwrap(), b"ab");
        elapsed.store(TTL.as_secs() * 3 - 2, Ordering::Release);
        assert_eq!(staging.resolve("c", "s", &uri).unwrap(), b"ab");
        elapsed.store(TTL.as_secs() * 4, Ordering::Release);
        assert!(staging.resolve("c", "s", &uri).is_err());
        assert_eq!(staging.retained(), (0, 0));
    }

    #[test]
    fn closing_the_connection_releases_its_staged_uploads() {
        let environment = Arc::new(Environment {
            services: crate::services::Services {
                identity: crate::services::Identity {
                    version: "test".into(),
                    pid: 1,
                    source_epoch: "epoch".into(),
                },
                auth: crate::LocalAuth::disabled(),
                cors: Vec::new(),
                budgets: Default::default(),
                core: None,
            },
            urls: Vec::new(),
            subscriptions: Default::default(),
            uploads: Default::default(),
        });
        let release = Release(environment.clone());
        environment
            .uploads
            .append("c", "s", piece(ID, 0, 0, false, &[1; 4096]))
            .unwrap();
        environment
            .uploads
            .append("c", "s", piece(&id(2), 0, 0, true, b"done"))
            .unwrap();
        assert_eq!(environment.uploads.retained(), (2, 4100));
        drop(release);
        assert_eq!(environment.uploads.retained(), (0, 0));
        assert!(
            environment
                .uploads
                .resolve("c", "s", &format!("ycoding-upload://{}", id(2)))
                .is_err()
        );
    }

    #[test]
    fn replaced_or_cleared_references_no_longer_resolve() {
        let (staging, elapsed) = manual();
        let uri = format!("ycoding-upload://{ID}");
        staging
            .append("c", "s", piece(ID, 0, 0, true, b"first"))
            .unwrap();
        elapsed.store(TTL.as_secs() + 1, Ordering::Release);
        staging
            .append("c", "s", piece(ID, 0, 0, false, b"second"))
            .unwrap();
        assert!(
            staging.resolve("c", "s", &uri).is_err(),
            "a reference to a replaced, incomplete upload is rejected"
        );
        staging.clear();
        assert_eq!(staging.retained(), (0, 0));
        assert!(staging.resolve("c", "s", &uri).is_err());
    }
}
