use crate::catalog::definition;
use crate::{Catalog, Error};
use redb::{Database, Durability, ReadableDatabase, TableHandle};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Metadata {
    pub database_identity: [u8; 16],
    pub generation: u64,
}

impl Metadata {
    pub const PHYSICAL_FORMAT: &'static [u8] = b"ycoding-redb";
    pub const RECORD_CODEC_VERSION: u64 = 1;
    pub const KEY_CODEC_VERSION: u64 = 1;
    pub const fn new(database_identity: [u8; 16], generation: u64) -> Self {
        Self {
            database_identity,
            generation,
        }
    }
    pub(crate) fn validate(&self) -> Result<(), Error> {
        if self.database_identity == [0; 16] || self.generation == 0 {
            return Err(Error::Incompatible(
                "invalid database identity or generation",
            ));
        }
        Ok(())
    }
}

pub(crate) fn bootstrap(
    db: &Database,
    catalog: Catalog,
    initial: Option<Metadata>,
) -> Result<Metadata, Error> {
    if let Some(metadata) = initial {
        let mut write = db.begin_write()?;
        write.set_durability(Durability::Immediate)?;
        {
            let mut table = write.open_table(definition("storage_metadata"))?;
            for (key, value) in [
                ("physical_format", Metadata::PHYSICAL_FORMAT.to_vec()),
                ("catalog_version", catalog.version.to_be_bytes().to_vec()),
                (
                    "record_codec_version",
                    Metadata::RECORD_CODEC_VERSION.to_be_bytes().to_vec(),
                ),
                (
                    "key_codec_version",
                    Metadata::KEY_CODEC_VERSION.to_be_bytes().to_vec(),
                ),
                ("database_identity", metadata.database_identity.to_vec()),
                ("generation", metadata.generation.to_be_bytes().to_vec()),
                ("catalog_manifest", catalog.manifest()),
            ] {
                table.insert(key.as_bytes(), value.as_slice())?;
            }
        }
        for name in catalog.names() {
            drop(write.open_table(definition(name))?);
        }
        write.commit().map_err(commit_error)?;
        return Ok(metadata);
    }
    let read = db.begin_read()?;
    let names = read
        .list_tables()?
        .map(|table| table.name().to_owned())
        .collect::<std::collections::BTreeSet<_>>();
    if names != catalog.names().into_iter().map(str::to_owned).collect()
        || read.list_multimap_tables()?.next().is_some()
    {
        return Err(Error::Incompatible("table catalog mismatch"));
    }
    for name in catalog.names() {
        drop(
            read.open_table(definition(name))
                .map_err(|_| Error::Incompatible("table physical types mismatch"))?,
        );
    }
    let table = read.open_table(definition("storage_metadata"))?;
    for (key, expected) in [
        ("physical_format", Metadata::PHYSICAL_FORMAT.to_vec()),
        ("catalog_version", catalog.version.to_be_bytes().to_vec()),
        (
            "record_codec_version",
            Metadata::RECORD_CODEC_VERSION.to_be_bytes().to_vec(),
        ),
        (
            "key_codec_version",
            Metadata::KEY_CODEC_VERSION.to_be_bytes().to_vec(),
        ),
        ("catalog_manifest", catalog.manifest()),
    ] {
        if table
            .get(key.as_bytes())?
            .is_none_or(|value| value.value() != expected)
        {
            return Err(Error::Incompatible(
                "format, catalog or codec version mismatch",
            ));
        }
    }
    let identity = table
        .get(b"database_identity".as_slice())?
        .ok_or(Error::Incompatible("missing database identity"))?;
    let generation = table
        .get(b"generation".as_slice())?
        .ok_or(Error::Incompatible("missing database generation"))?;
    let metadata = Metadata {
        database_identity: identity
            .value()
            .try_into()
            .map_err(|_| Error::Incompatible("invalid database identity"))?,
        generation: u64::from_be_bytes(
            generation
                .value()
                .try_into()
                .map_err(|_| Error::Incompatible("invalid database generation"))?,
        ),
    };
    metadata.validate()?;
    Ok(metadata)
}

pub(crate) fn commit_error(error: redb::CommitError) -> Error {
    match error {
        redb::CommitError::TransactionPoisoned => Error::TransactionAborted,
        error => Error::CommitUncertain(error),
    }
}
