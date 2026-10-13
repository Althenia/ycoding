use super::codec::{Field, key, require, table};
use super::document::{self, Kind, parse, text};
use crate::{Error, IndexDefinition, KeyPart, TableSpec, Write, tuple_key};
use ycoding_schema::LosslessString;

table!(MeetingTable, Meeting, "meetings", { id: LosslessString, data: LosslessString }, r, key(&r.id), &[], index, { let _ = (index, r); Err(Error::UnregisteredIndex) }, {
    let value = parse(Kind::Meeting, &r.data)?;
    if r.id.as_str().is_none() || text(&value, "id")? != &r.id { return Err(document::invalid()) }
    Ok(())
}, tx, {});

table!(SegmentTable, Segment, "segments", { id: LosslessString, meeting_id: LosslessString, sequence: i64, state: LosslessString, original_text: LosslessString, data: LosslessString }, r, key(&r.id), &[IndexDefinition::unique("final_sequence"), IndexDefinition::secondary("segment_order")], index, {
    match index.name {
        "final_sequence" if r.state.as_str() != Some("final") => Ok(None),
        "final_sequence" | "segment_order" => Ok(Some(tuple_key(&[KeyPart::String(&r.meeting_id), KeyPart::I64(r.sequence)]))),
        _ => Err(Error::UnregisteredIndex),
    }
}, {
    let value = parse(Kind::Segment, &r.data)?;
    if r.id.as_str().is_none() || r.meeting_id.as_str().is_none() || text(&value, "id")? != &r.id || text(&value, "meetingID")? != &r.meeting_id || document::number(&value, "sequence")? != r.sequence as f64 || !(0..=9_007_199_254_740_991).contains(&r.sequence) || text(&value, "state")? != &r.state { return Err(document::invalid()) }
    Ok(())
}, tx, { require::<MeetingTable>(tx, &key(&r.meeting_id))?; });

table!(ReferenceTable, Reference, "knowledge_references", { meeting_id: LosslessString, server: LosslessString, target: LosslessString, data: LosslessString }, r, tuple_key(&[KeyPart::String(&r.meeting_id), KeyPart::String(&r.server), KeyPart::String(&r.target)]), &[], index, { let _ = (index, r); Err(Error::UnregisteredIndex) }, {
    let value = parse(Kind::Reference, &r.data)?;
    if r.server.as_str().is_none() || r.target.as_str().is_none() || text(&value, "server")? != &r.server || text(&value, "target")? != &r.target { return Err(document::invalid()) }
    Ok(())
}, tx, { require::<MeetingTable>(tx, &key(&r.meeting_id))?; });

#[derive(Clone, Debug, PartialEq)]
pub struct Record {
    pub id: LosslessString,
    pub meeting_id: LosslessString,
    pub position: i64,
    pub data: LosslessString,
}

pub(super) trait ChildTable: TableSpec<Record = Record> {
    const KIND: Kind;
}

macro_rules! child_table {
    ($table:ident, $name:literal, $index:literal, $kind:ident) => {
        pub struct $table;
        impl ChildTable for $table {
            const KIND: Kind = Kind::$kind;
        }
        impl TableSpec for $table {
            type Record = Record;
            const NAME: &'static str = $name;
            const INDEXES: &'static [IndexDefinition] = &[IndexDefinition::secondary($index)];
            fn primary_key(record: &Record) -> Vec<u8> {
                key(&record.id)
            }
            fn encode(record: &Record) -> Result<Vec<u8>, Error> {
                let value = parse(Self::KIND, &record.data)?;
                let id = if matches!(Self::KIND, Kind::Plan) {
                    text(&value, "meetingID")?
                } else {
                    text(&value, "id")?
                };
                if record.id.as_str().is_none()
                    || id != &record.id
                    || text(&value, "meetingID")? != &record.meeting_id
                {
                    return Err(document::invalid());
                }
                let mut bytes = vec![1];
                record.id.encode(&mut bytes)?;
                record.meeting_id.encode(&mut bytes)?;
                record.position.encode(&mut bytes)?;
                record.data.encode(&mut bytes)?;
                Ok(bytes)
            }
            fn decode(mut bytes: &[u8]) -> Result<Record, Error> {
                if bytes.first() != Some(&1) {
                    return Err(Error::Incompatible("Meeting record codec"));
                }
                bytes = &bytes[1..];
                let record = Record {
                    id: LosslessString::decode(&mut bytes)?,
                    meeting_id: LosslessString::decode(&mut bytes)?,
                    position: i64::decode(&mut bytes)?,
                    data: LosslessString::decode(&mut bytes)?,
                };
                if !bytes.is_empty() {
                    return Err(Error::Incompatible("trailing Meeting record bytes"));
                }
                Self::encode(&record)?;
                Ok(record)
            }
            fn index_key(
                index: &IndexDefinition,
                record: &Record,
            ) -> Result<Option<Vec<u8>>, Error> {
                match index.name {
                    $index => Ok(Some(key(&record.meeting_id))),
                    _ => Err(Error::UnregisteredIndex),
                }
            }
        }
        impl $table {
            pub fn put(tx: &mut Write<'_>, record: &Record) -> Result<(), Error> {
                require::<MeetingTable>(tx, &key(&record.meeting_id))?;
                tx.put::<Self>(record)
            }
        }
    };
}
child_table!(FindingTable, "findings", "findings_meeting", Finding);
child_table!(
    CheckpointTable,
    "checkpoints",
    "checkpoints_meeting",
    Checkpoint
);
child_table!(ProposalTable, "proposals", "proposals_meeting", Proposal);
child_table!(PlanTable, "plans", "plans_meeting", Plan);
child_table!(ApprovalTable, "approvals", "approvals_meeting", Approval);
child_table!(JobTable, "jobs", "jobs_meeting", Job);
