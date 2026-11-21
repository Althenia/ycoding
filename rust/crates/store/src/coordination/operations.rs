use super::{GroupTable, Member, MemberTable, codec::key};
use crate::{Error, Snapshot, TableSpec, Write};
use std::ops::Bound;
use ycoding_schema::LosslessString;

pub fn members(snapshot: &Snapshot, group: &LosslessString) -> Result<Vec<Member>, Error> {
    let prefix = key(group);
    let mut after = None;
    let mut members = Vec::new();
    loop {
        let rows = snapshot.scan::<MemberTable>(
            after
                .as_deref()
                .map_or(Bound::Included(prefix.as_slice()), Bound::Excluded),
            Bound::Unbounded,
            128,
        )?;
        if rows.is_empty() {
            break;
        }
        let done = rows.iter().any(|row| row.group_id != *group);
        after = rows.last().map(MemberTable::primary_key);
        members.extend(rows.into_iter().take_while(|row| row.group_id == *group));
        if done {
            break;
        }
    }
    Ok(members)
}

pub fn members_in(tx: &mut Write<'_>, group: &LosslessString) -> Result<Vec<Member>, Error> {
    let prefix = key(group);
    let mut after = None;
    let mut members = Vec::new();
    loop {
        let rows = tx.scan::<MemberTable>(
            after
                .as_deref()
                .map_or(Bound::Included(prefix.as_slice()), Bound::Excluded),
            Bound::Unbounded,
            128,
        )?;
        if rows.is_empty() {
            break;
        }
        let done = rows.iter().any(|row| row.group_id != *group);
        after = rows.last().map(MemberTable::primary_key);
        members.extend(rows.into_iter().take_while(|row| row.group_id == *group));
        if done {
            break;
        }
    }
    Ok(members)
}

pub fn delete(tx: &mut Write<'_>, group: &LosslessString) -> Result<bool, Error> {
    if tx.get::<GroupTable>(&key(group))?.is_none() {
        return Ok(false);
    }
    for member in members_in(tx, group)? {
        tx.delete::<MemberTable>(&MemberTable::primary_key(&member))?;
    }
    tx.delete::<GroupTable>(&key(group))
}

pub fn remove_session(tx: &mut Write<'_>, id: &LosslessString) -> Result<(), Error> {
    for group in tx.index::<GroupTable>("coordination_group_master_idx", &key(id), None, 1)? {
        delete(tx, &group.id)?;
    }
    for member in tx.index::<MemberTable>("coordination_member_session_idx", &key(id), None, 1)? {
        tx.delete::<MemberTable>(&MemberTable::primary_key(&member))?;
    }
    loop {
        let members =
            tx.index::<MemberTable>("coordination_member_owner_idx", &key(id), None, 128)?;
        if members.is_empty() {
            break;
        }
        for mut member in members {
            member.owner_session_id = None;
            MemberTable::put(tx, &member)?;
        }
    }
    Ok(())
}
