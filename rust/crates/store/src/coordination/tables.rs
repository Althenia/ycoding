use super::codec::{Document, check, key, require, table};
use crate::{Error, IndexDefinition, KeyPart, tuple_key};
use ycoding_schema::{
    LosslessString, coordination,
    schema::{NonNegativeInt, PositiveInt},
    session,
};

fn group_valid(row: &Group) -> Result<(), Error> {
    coordination::GroupId::new(row.id.clone()).map_err(|error| Error::Record(Box::new(error)))?;
    session::Id::new(row.master_session_id.clone())
        .map_err(|error| Error::Record(Box::new(error)))?;
    check(
        (1..=120).contains(&row.name.len()),
        "coordination group name",
    )?;
    for value in [row.revision, row.time_created, row.time_updated] {
        NonNegativeInt::new(value).map_err(|error| Error::Record(Box::new(error)))?;
    }
    if let Some(value) = row.concurrency {
        PositiveInt::new(value).map_err(|error| Error::Record(Box::new(error)))?;
    }
    if let Some(policy) = &row.delegated_decisions {
        let ycoding_schema::JsonValue::Object(fields) = policy.value() else {
            return Err(Error::Rejected(
                "coordination delegated policy must be an object",
            ));
        };
        check(
            fields.iter().all(|(key, _)| {
                matches!(
                    key.as_str(),
                    Some("categories" | "actions" | "resources" | "expiresAt")
                )
            }),
            "unknown coordination delegated policy field",
        )?;
    }
    Ok(())
}

table!(GroupTable, Group, "coordination_group", {
    id: LosslessString,
    name: LosslessString,
    revision: i64,
    master_session_id: LosslessString,
    concurrency: Option<i64>,
    delegated_decisions: Option<Document<coordination::DelegatedDecisions>>,
    time_created: i64,
    time_updated: i64
}, row, key(&row.id), &[
    IndexDefinition::unique("coordination_group_master_idx"),
    IndexDefinition::secondary("coordination_group_updated_idx")
], index, {
    match index.name {
        "coordination_group_master_idx" => Ok(Some(key(&row.master_session_id))),
        "coordination_group_updated_idx" => Ok(Some(tuple_key(&[KeyPart::I64(row.time_updated),KeyPart::String(&row.id)]))),
        _ => Err(Error::UnregisteredIndex)
    }
}, group_valid(row), tx, {
    require::<crate::session::SessionTable>(tx,&key(&row.master_session_id))?;
});

table!(MemberTable, Member, "coordination_member", {
    group_id: LosslessString,
    session_id: LosslessString,
    owner_session_id: Option<LosslessString>
}, row, tuple_key(&[KeyPart::String(&row.group_id),KeyPart::String(&row.session_id)]), &[
    IndexDefinition::secondary("coordination_member_owner_idx"),
    IndexDefinition::unique("coordination_member_session_idx")
], index, {
    match index.name {
        "coordination_member_owner_idx" => Ok(row.owner_session_id.as_ref().map(key)),
        "coordination_member_session_idx" => Ok(Some(key(&row.session_id))),
        _ => Err(Error::UnregisteredIndex)
    }
}, {
    coordination::GroupId::new(row.group_id.clone()).map_err(|error| Error::Record(Box::new(error)))?;
    session::Id::new(row.session_id.clone()).map_err(|error| Error::Record(Box::new(error)))?;
    if let Some(owner)=&row.owner_session_id { session::Id::new(owner.clone()).map_err(|error| Error::Record(Box::new(error)))?; }
    Ok::<_,Error>(())
}, tx, {
    require::<GroupTable>(tx,&key(&row.group_id))?;
    require::<crate::session::SessionTable>(tx,&key(&row.session_id))?;
    if let Some(owner)=&row.owner_session_id { require::<crate::session::SessionTable>(tx,&key(owner))?; }
});
