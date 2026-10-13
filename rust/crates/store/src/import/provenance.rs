use crate::session::codec::Field;
use crate::{Error, IndexDefinition, TableSpec};
use ycoding_schema::LosslessString;

#[derive(Clone, Debug, PartialEq)]
pub struct TableSummary {
    pub name: String,
    pub rows: i64,
    pub digest: String,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Report {
    pub source_fingerprint: String,
    pub source_bytes: i64,
    pub importer_version: i64,
    pub tables: Vec<TableSummary>,
    pub latency_high_water: Option<i64>,
}

pub struct ProvenanceTable;
impl TableSpec for ProvenanceTable {
    type Record = Report;
    const NAME: &'static str = "import_provenance";
    const INDEXES: &'static [IndexDefinition] = &[];
    fn primary_key(_: &Report) -> Vec<u8> {
        vec![]
    }
    fn encode(record: &Report) -> Result<Vec<u8>, Error> {
        if record.importer_version != 1 || record.source_bytes < 0 {
            return Err(Error::Incompatible("import provenance version or size"));
        }
        let mut bytes = vec![1];
        LosslessString::from(record.source_fingerprint.clone()).encode(&mut bytes)?;
        record.source_bytes.encode(&mut bytes)?;
        record.importer_version.encode(&mut bytes)?;
        (record.tables.len() as i64).encode(&mut bytes)?;
        for table in &record.tables {
            LosslessString::from(table.name.clone()).encode(&mut bytes)?;
            table.rows.encode(&mut bytes)?;
            LosslessString::from(table.digest.clone()).encode(&mut bytes)?;
        }
        record.latency_high_water.encode(&mut bytes)?;
        Ok(bytes)
    }
    fn decode(mut bytes: &[u8]) -> Result<Report, Error> {
        if bytes.first() != Some(&1) {
            return Err(Error::Incompatible("import provenance codec"));
        }
        bytes = &bytes[1..];
        let source_fingerprint = LosslessString::decode(&mut bytes)?
            .to_utf8()
            .map_err(|_| Error::Incompatible("import fingerprint"))?;
        let source_bytes = i64::decode(&mut bytes)?;
        let importer_version = i64::decode(&mut bytes)?;
        let count = i64::decode(&mut bytes)?;
        if !(0..=49).contains(&count) {
            return Err(Error::Incompatible("import table count"));
        }
        let tables = (0..count)
            .map(|_| {
                Ok(TableSummary {
                    name: LosslessString::decode(&mut bytes)?
                        .to_utf8()
                        .map_err(|_| Error::Incompatible("import table name"))?,
                    rows: i64::decode(&mut bytes)?,
                    digest: LosslessString::decode(&mut bytes)?
                        .to_utf8()
                        .map_err(|_| Error::Incompatible("import digest"))?,
                })
            })
            .collect::<Result<Vec<_>, Error>>()?;
        let latency_high_water = Option::<i64>::decode(&mut bytes)?;
        if !bytes.is_empty() {
            return Err(Error::Incompatible("import provenance trailing bytes"));
        }
        let record = Report {
            source_fingerprint,
            source_bytes,
            importer_version,
            tables,
            latency_high_water,
        };
        Self::encode(&record)?;
        Ok(record)
    }
    fn index_key(_: &IndexDefinition, _: &Report) -> Result<Option<Vec<u8>>, Error> {
        Err(Error::UnregisteredIndex)
    }
}
