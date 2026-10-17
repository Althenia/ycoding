use super::{DatabaseKind, Error, Report, Request};
use crate::{Metadata, TableSpec};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

const MAGIC: &[u8] = b"ycoding-import-checkpoint\x01";

pub(super) struct Checkpoint {
    pub(super) kind: DatabaseKind,
    pub(super) metadata: Metadata,
    pub(super) report: Report,
    pub(super) validated: usize,
    pub(super) sealed: bool,
}

pub(super) fn path(candidate: &Path) -> PathBuf {
    let mut path = candidate.as_os_str().to_os_string();
    path.push(".import-v1");
    PathBuf::from(path)
}

impl Checkpoint {
    pub(super) fn new(request: &Request<'_>, fingerprint: (String, i64)) -> Self {
        Self {
            kind: request.kind,
            metadata: request.metadata.clone(),
            report: Report {
                source_fingerprint: fingerprint.0,
                source_bytes: fingerprint.1,
                importer_version: super::provenance::IMPORTER_VERSION,
                tables: Vec::new(),
                latency_high_water: None,
            },
            validated: 0,
            sealed: false,
        }
    }

    pub(super) fn read(candidate: &Path) -> Result<Option<Self>, Error> {
        let path = path(candidate);
        let info = match std::fs::symlink_metadata(&path) {
            Ok(info) => info,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error.into()),
        };
        if !info.is_file() || info.len() > 131_072 {
            return Err(Error::Checkpoint("unsafe checkpoint file"));
        }
        let mut contents = Vec::new();
        std::fs::File::open(path)?
            .take(131_073)
            .read_to_end(&mut contents)?;
        let mut bytes = contents.as_slice();
        if take(&mut bytes, MAGIC.len())? != MAGIC {
            return Err(Error::Checkpoint("unsupported checkpoint version"));
        }
        let kind = match take(&mut bytes, 1)?[0] {
            0 => DatabaseKind::Core,
            1 => DatabaseKind::Bootstrap,
            2 => DatabaseKind::Meeting,
            _ => return Err(Error::Checkpoint("unknown database kind")),
        };
        let identity = take(&mut bytes, 16)?
            .try_into()
            .map_err(|_| Error::Checkpoint("identity"))?;
        let generation = number(&mut bytes)?;
        let metadata = Metadata::new(identity, generation);
        metadata.validate()?;
        let manifest_bytes =
            usize::try_from(number(&mut bytes)?).map_err(|_| Error::Checkpoint("catalog size"))?;
        if take(&mut bytes, manifest_bytes)? != super::catalog(kind).manifest() {
            return Err(Error::Checkpoint("catalog mismatch"));
        }
        let validated = usize::try_from(number(&mut bytes)?)
            .map_err(|_| Error::Checkpoint("validation count"))?;
        let sealed = match take(&mut bytes, 1)?[0] {
            0 => false,
            1 => true,
            _ => return Err(Error::Checkpoint("invalid seal")),
        };
        let report = super::ProvenanceTable::decode(bytes)?;
        let mappings = super::mappings::tables(kind);
        if report.tables.len() > mappings.len()
            || validated > report.tables.len()
            || (validated > 0 && report.tables.len() != mappings.len())
            || (sealed && validated != mappings.len())
            || report.tables.iter().zip(mappings).any(|(table, mapping)| {
                !(table.name == mapping.name
                    || (mapping.name == super::mappings::FACTS
                        && table.name == super::mappings::BACKFILL))
                    || table.rows < 0
                    || !digest(&table.digest)
            })
            || !digest(&report.source_fingerprint)
        {
            return Err(Error::Checkpoint("invalid checkpoint progress"));
        }
        Ok(Some(Self {
            kind,
            metadata,
            report,
            validated,
            sealed,
        }))
    }

    pub(super) fn save(&self, candidate: &Path) -> Result<(), Error> {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let path = path(candidate);
        let temporary = path.with_extension(format!(
            "tmp-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        let manifest = super::catalog(self.kind).manifest();
        let mut bytes = MAGIC.to_vec();
        bytes.push(match self.kind {
            DatabaseKind::Core => 0,
            DatabaseKind::Bootstrap => 1,
            DatabaseKind::Meeting => 2,
        });
        bytes.extend_from_slice(&self.metadata.database_identity);
        bytes.extend_from_slice(&self.metadata.generation.to_be_bytes());
        bytes.extend_from_slice(&(manifest.len() as u64).to_be_bytes());
        bytes.extend_from_slice(&manifest);
        bytes.extend_from_slice(&(self.validated as u64).to_be_bytes());
        bytes.push(u8::from(self.sealed));
        bytes.extend_from_slice(&super::ProvenanceTable::encode(&self.report)?);
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temporary)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
        drop(file);
        std::fs::rename(&temporary, &path)?;
        #[cfg(unix)]
        std::fs::File::open(path.parent().unwrap_or(Path::new(".")))?.sync_all()?;
        Ok(())
    }
}

fn take<'a>(bytes: &mut &'a [u8], count: usize) -> Result<&'a [u8], Error> {
    if count > bytes.len() {
        return Err(Error::Checkpoint("truncated checkpoint"));
    }
    let (value, rest) = bytes.split_at(count);
    *bytes = rest;
    Ok(value)
}

fn number(bytes: &mut &[u8]) -> Result<u64, Error> {
    Ok(u64::from_be_bytes(
        take(bytes, 8)?
            .try_into()
            .map_err(|_| Error::Checkpoint("integer"))?,
    ))
}

fn digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

#[cfg(test)]
mod tests;
