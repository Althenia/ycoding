use crate::{Error, KeyPart, tuple_key};
use redb::TableDefinition;
use std::collections::BTreeSet;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct IndexDefinition {
    pub name: &'static str,
    pub unique: bool,
}

impl IndexDefinition {
    pub const fn unique(name: &'static str) -> Self {
        Self { name, unique: true }
    }
    pub const fn secondary(name: &'static str) -> Self {
        Self {
            name,
            unique: false,
        }
    }
}

pub trait TableSpec: 'static {
    type Record;
    const NAME: &'static str;
    const INDEXES: &'static [IndexDefinition];
    fn primary_key(record: &Self::Record) -> Vec<u8>;
    fn encode(record: &Self::Record) -> Result<Vec<u8>, Error>;
    fn decode(bytes: &[u8]) -> Result<Self::Record, Error>;
    fn index_key(index: &IndexDefinition, record: &Self::Record) -> Result<Option<Vec<u8>>, Error>;
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TableDeclaration {
    pub name: &'static str,
    pub indexes: &'static [IndexDefinition],
}

impl TableDeclaration {
    pub const fn of<T: TableSpec>() -> Self {
        Self {
            name: T::NAME,
            indexes: T::INDEXES,
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub struct Catalog {
    pub version: u64,
    tables: &'static [TableDeclaration],
}

impl Catalog {
    pub const EMPTY: Self = Self::new(1, &[]);
    pub const fn new(version: u64, tables: &'static [TableDeclaration]) -> Self {
        Self { version, tables }
    }
    pub const fn tables(&self) -> &'static [TableDeclaration] {
        self.tables
    }

    pub(crate) fn validate(&self) -> Result<(), Error> {
        if self.version != 1 {
            return Err(Error::InvalidConfiguration("unsupported catalog version"));
        }
        let mut names = BTreeSet::from(["storage_metadata"]);
        for table in self.tables {
            if table.name.is_empty() || !names.insert(table.name) {
                return Err(Error::InvalidConfiguration(
                    "empty, reserved or duplicate table name",
                ));
            }
            for index in table.indexes {
                if index.name.is_empty() || !names.insert(index.name) {
                    return Err(Error::InvalidConfiguration(
                        "empty, reserved or duplicate index name",
                    ));
                }
            }
        }
        Ok(())
    }

    pub(crate) fn require<T: TableSpec>(&self) -> Result<(), Error> {
        if !self.tables.contains(&TableDeclaration::of::<T>()) {
            return Err(Error::UnregisteredTable(T::NAME));
        }
        Ok(())
    }

    pub(crate) fn names(&self) -> BTreeSet<&'static str> {
        std::iter::once("storage_metadata")
            .chain(self.tables.iter().flat_map(|table| {
                std::iter::once(table.name).chain(table.indexes.iter().map(|index| index.name))
            }))
            .collect()
    }

    pub(crate) fn manifest(&self) -> Vec<u8> {
        let mut entries: Vec<_> = self
            .tables
            .iter()
            .flat_map(|table| {
                std::iter::once(tuple_key(&[KeyPart::Bytes(table.name.as_bytes())])).chain(
                    table.indexes.iter().map(|index| {
                        tuple_key(&[
                            KeyPart::Bytes(table.name.as_bytes()),
                            KeyPart::Bytes(index.name.as_bytes()),
                            KeyPart::U64(u64::from(index.unique)),
                        ])
                    }),
                )
            })
            .collect();
        entries.sort();
        tuple_key(
            &entries
                .iter()
                .map(|entry| KeyPart::Bytes(entry))
                .collect::<Vec<_>>(),
        )
    }
}

pub(crate) fn definition(name: &str) -> TableDefinition<'_, &[u8], &[u8]> {
    TableDefinition::new(name)
}

pub(crate) fn index_definition<T: TableSpec>(
    name: &str,
) -> Result<&'static IndexDefinition, Error> {
    T::INDEXES
        .iter()
        .find(|index| index.name == name)
        .ok_or(Error::UnregisteredIndex)
}
