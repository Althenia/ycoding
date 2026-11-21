use super::{INTENT_BYTES, INTENT_LIMIT};
use crate::{Error, IndexDefinition, KeyPart, Metadata, TableSpec, Write, tuple_key};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Delivery {
    pub identity: [u8; 16],
    pub source_generation: u64,
    pub generation: u64,
    pub order: u64,
    pub applied: u64,
    pub valid: bool,
    pub rebuilding: bool,
    pub intents: usize,
    pub bytes: usize,
    pub privacy: u64,
    pub purges: Vec<Vec<u8>>,
    pub purge_all: bool,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Intent {
    pub source: String,
    pub identity: Vec<u8>,
    pub order: u64,
    pub generation: u64,
    pub delete: bool,
}
pub struct Change {
    pub source: &'static str,
    pub identity: Vec<u8>,
    pub delete: bool,
}

pub struct DeliveryTable;
pub struct IntentTable;

macro_rules! table {
    ($table:ty, $record:ty, $name:literal, $key:expr) => {
        impl TableSpec for $table {
            type Record = $record;
            const NAME: &'static str = $name;
            const INDEXES: &'static [IndexDefinition] = &[];
            fn primary_key(record: &$record) -> Vec<u8> {
                ($key)(record)
            }
            fn encode(record: &$record) -> Result<Vec<u8>, Error> {
                record.encode()
            }
            fn decode(bytes: &[u8]) -> Result<$record, Error> {
                <$record>::decode(bytes)
            }
            fn index_key(_: &IndexDefinition, _: &$record) -> Result<Option<Vec<u8>>, Error> {
                Err(Error::UnregisteredIndex)
            }
        }
    };
}
table!(
    DeliveryTable,
    Delivery,
    "analytics_delivery",
    |_: &Delivery| Vec::new()
);
table!(
    IntentTable,
    Intent,
    "analytics_intent",
    |record: &Intent| tuple_key(&[
        KeyPart::Bytes(record.source.as_bytes()),
        KeyPart::Bytes(&record.identity)
    ])
);

impl Delivery {
    pub(crate) fn initial(metadata: &Metadata) -> Self {
        Self {
            identity: metadata.database_identity,
            source_generation: metadata.generation,
            generation: 0,
            order: 0,
            applied: 0,
            valid: false,
            rebuilding: false,
            intents: 0,
            bytes: 0,
            privacy: 0,
            purges: Vec::new(),
            purge_all: false,
        }
    }
    pub(crate) fn matches(&self, metadata: &Metadata) -> bool {
        self.identity == metadata.database_identity && self.source_generation == metadata.generation
    }
    pub(crate) fn pending_purge(&self) -> bool {
        self.purge_all || !self.purges.is_empty()
    }
    fn encode(&self) -> Result<Vec<u8>, Error> {
        if self.intents > INTENT_LIMIT
            || self.bytes > INTENT_BYTES
            || self.purges.len() > INTENT_LIMIT
            || self
                .purges
                .iter()
                .map(|scope| scope.len() + 8)
                .sum::<usize>()
                > INTENT_BYTES
        {
            return Err(Error::Incompatible("analytics metadata exceeds budget"));
        }
        let mut bytes = vec![1];
        bytes.extend(self.identity);
        for value in [
            self.source_generation,
            self.generation,
            self.order,
            self.applied,
            self.intents as u64,
            self.bytes as u64,
            self.privacy,
        ] {
            bytes.extend(value.to_be_bytes());
        }
        bytes.push(
            u8::from(self.valid)
                | (u8::from(self.rebuilding) << 1)
                | (u8::from(self.purge_all) << 2),
        );
        bytes.extend((self.purges.len() as u64).to_be_bytes());
        for scope in &self.purges {
            append_bytes(&mut bytes, scope);
        }
        Ok(bytes)
    }
    fn decode(bytes: &[u8]) -> Result<Self, Error> {
        let mut reader = Reader(bytes);
        reader.version()?;
        let identity = reader
            .take(16)?
            .try_into()
            .map_err(|_| Error::Incompatible("analytics identity"))?;
        let source_generation = reader.number()?;
        let generation = reader.number()?;
        let order = reader.number()?;
        let applied = reader.number()?;
        let intents = reader.size()?;
        let bytes = reader.size()?;
        let privacy = reader.number()?;
        let flags = reader.take(1)?[0];
        if flags > 7 {
            return Err(Error::Incompatible("analytics flags"));
        }
        let count = reader.size()?;
        if count > INTENT_LIMIT {
            return Err(Error::Incompatible("analytics purge budget"));
        }
        let purges = (0..count)
            .map(|_| reader.bytes().map(<[u8]>::to_vec))
            .collect::<Result<Vec<_>, _>>()?;
        reader.end()?;
        let state = Self {
            identity,
            source_generation,
            generation,
            order,
            applied,
            intents,
            bytes,
            privacy,
            valid: flags & 1 != 0,
            rebuilding: flags & 2 != 0,
            purge_all: flags & 4 != 0,
            purges,
        };
        state.encode()?;
        Ok(state)
    }
}
impl Intent {
    fn encode(&self) -> Result<Vec<u8>, Error> {
        let mut bytes = vec![1];
        bytes.extend(self.generation.to_be_bytes());
        bytes.extend(self.order.to_be_bytes());
        bytes.push(u8::from(self.delete));
        append_bytes(&mut bytes, self.source.as_bytes());
        append_bytes(&mut bytes, &self.identity);
        Ok(bytes)
    }
    fn decode(bytes: &[u8]) -> Result<Self, Error> {
        let mut reader = Reader(bytes);
        reader.version()?;
        let generation = reader.number()?;
        let order = reader.number()?;
        let delete = match reader.take(1)? {
            [0] => false,
            [1] => true,
            _ => return Err(Error::Incompatible("analytics action")),
        };
        let source = String::from_utf8(reader.bytes()?.to_vec())
            .map_err(|_| Error::Incompatible("analytics source"))?;
        let identity = reader.bytes()?.to_vec();
        reader.end()?;
        Ok(Self {
            source,
            identity,
            generation,
            order,
            delete,
        })
    }
    pub(crate) fn entry_bytes(&self) -> Result<usize, Error> {
        Ok(IntentTable::primary_key(self).len() + self.encode()?.len())
    }
}

pub fn record(tx: &mut Write<'_>, change: Change) -> Result<u64, Error> {
    let result = (|| {
        if !super::identifier(change.source) {
            return Err(Error::InvalidConfiguration("invalid analytics source name"));
        }
        let mut state = current(tx)?;
        state.order = increment(state.order)?;
        if change.delete {
            state.privacy = increment(state.privacy)?;
        }
        if state.valid {
            let intent = Intent {
                source: change.source.to_owned(),
                identity: change.identity,
                order: state.order,
                generation: state.generation,
                delete: change.delete,
            };
            let old = tx.get::<IntentTable>(&IntentTable::primary_key(&intent))?;
            let count = state.intents + usize::from(old.is_none());
            let old_bytes = old
                .as_ref()
                .map(Intent::entry_bytes)
                .transpose()?
                .unwrap_or(0);
            let next_bytes = intent.entry_bytes()?;
            let bytes = state
                .bytes
                .checked_sub(old_bytes)
                .and_then(|bytes| bytes.checked_add(next_bytes))
                .ok_or(Error::Incompatible("analytics intent accounting"))?;
            if count > INTENT_LIMIT || bytes > INTENT_BYTES {
                state.valid = false;
                state.rebuilding = false;
            } else {
                tx.put::<IntentTable>(&intent)?;
                state.intents = count;
                state.bytes = bytes;
            }
        }
        tx.put::<DeliveryTable>(&state)?;
        Ok(state.order)
    })();
    result.map_err(|error| tx.reject(error))
}

pub fn privacy_changed(tx: &mut Write<'_>, scope: Vec<u8>, purge: bool) -> Result<u64, Error> {
    let result = (|| {
        let mut state = current(tx)?;
        state.order = increment(state.order)?;
        state.privacy = increment(state.privacy)?;
        state.valid = false;
        state.rebuilding = false;
        if purge && !state.purge_all && !state.purges.contains(&scope) {
            let bytes = state
                .purges
                .iter()
                .map(|scope| scope.len() + 8)
                .sum::<usize>();
            if state.purges.len() == INTENT_LIMIT
                || scope.len() > INTENT_BYTES.saturating_sub(bytes + 8)
            {
                state.purge_all = true;
                state.purges.clear();
            } else {
                state.purges.push(scope);
            }
        }
        tx.put::<DeliveryTable>(&state)?;
        Ok(state.order)
    })();
    result.map_err(|error| tx.reject(error))
}

pub(crate) fn current(tx: &mut Write<'_>) -> Result<Delivery, Error> {
    let mut state = tx
        .get::<DeliveryTable>(&[])?
        .unwrap_or_else(|| Delivery::initial(tx.metadata()));
    if !state.matches(tx.metadata()) {
        state.identity = tx.metadata().database_identity;
        state.source_generation = tx.metadata().generation;
        state.valid = false;
        state.rebuilding = false;
    }
    Ok(state)
}
pub(crate) fn increment(value: u64) -> Result<u64, Error> {
    value
        .checked_add(1)
        .ok_or(Error::Incompatible("analytics counter exhausted"))
}
fn append_bytes(target: &mut Vec<u8>, bytes: &[u8]) {
    target.extend((bytes.len() as u64).to_be_bytes());
    target.extend(bytes);
}
struct Reader<'a>(&'a [u8]);
impl<'a> Reader<'a> {
    fn take(&mut self, count: usize) -> Result<&'a [u8], Error> {
        if count > self.0.len() {
            return Err(Error::Incompatible("truncated analytics metadata"));
        }
        let (value, rest) = self.0.split_at(count);
        self.0 = rest;
        Ok(value)
    }
    fn number(&mut self) -> Result<u64, Error> {
        Ok(u64::from_be_bytes(
            self.take(8)?
                .try_into()
                .map_err(|_| Error::Incompatible("analytics integer"))?,
        ))
    }
    fn size(&mut self) -> Result<usize, Error> {
        usize::try_from(self.number()?).map_err(|_| Error::Incompatible("analytics size"))
    }
    fn bytes(&mut self) -> Result<&'a [u8], Error> {
        let count = self.size()?;
        self.take(count)
    }
    fn version(&mut self) -> Result<(), Error> {
        if self.take(1)? != [1] {
            return Err(Error::Incompatible("analytics codec version"));
        }
        Ok(())
    }
    fn end(self) -> Result<(), Error> {
        if !self.0.is_empty() {
            return Err(Error::Incompatible("trailing analytics metadata"));
        }
        Ok(())
    }
}
