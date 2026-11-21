use super::{Role, error};
use ycoding_schema::{LosslessString, coordination as c, session};
use ycoding_store::{
    Error, KeyPart, Snapshot, TableSpec, Write,
    coordination::{self, Group, GroupTable, Member, MemberTable},
    session::SessionTable,
    tuple_key,
};

pub(super) fn key(id: &LosslessString) -> Vec<u8> {
    tuple_key(&[KeyPart::String(id)])
}

pub(super) enum Reader<'a, 'tx> {
    Snapshot(&'a Snapshot),
    Transaction(&'a mut Write<'tx>),
}
impl Reader<'_, '_> {
    pub fn get<T: TableSpec>(&mut self, key: &[u8]) -> Result<Option<T::Record>, Error> {
        match self {
            Self::Snapshot(snapshot) => snapshot.get::<T>(key),
            Self::Transaction(tx) => tx.get::<T>(key),
        }
    }
    pub fn index<T: TableSpec>(
        &mut self,
        name: &str,
        key: &[u8],
        limit: usize,
    ) -> Result<Vec<T::Record>, Error> {
        match self {
            Self::Snapshot(snapshot) => snapshot.index::<T>(name, key, None, limit),
            Self::Transaction(tx) => tx.index::<T>(name, key, None, limit),
        }
    }
    pub fn members(&mut self, id: &LosslessString) -> Result<Vec<Member>, Error> {
        match self {
            Self::Snapshot(snapshot) => coordination::members(snapshot, id),
            Self::Transaction(tx) => coordination::members_in(tx, id),
        }
    }
}

pub(super) struct Resolved {
    pub group: Group,
    pub members: Vec<Member>,
    pub role: Role,
    pub owner: Option<LosslessString>,
    pub owned: Vec<LosslessString>,
}

pub fn coordinating(snapshot: &Snapshot, session: &session::Id) -> Result<bool, Error> {
    Ok(scope(&mut Reader::Snapshot(snapshot), session.as_lossless())?.is_some())
}

pub fn execution_rules(
    action: &LosslessString,
    resources: &[LosslessString],
) -> Vec<ycoding_schema::permission::Rule> {
    let deny = |action: &str, resource: LosslessString| ycoding_schema::permission::Rule {
        action: action.into(),
        resource,
        effect: ycoding_schema::permission::Effect("deny".into()),
    };
    let mut rules = vec![deny("edit", "*".into())];
    if action.as_str() == Some("shell") {
        rules.extend(
            resources
                .iter()
                .filter(|resource| !crate::process::guardrails::read_only_shell(resource))
                .map(|resource| deny("shell", resource.clone())),
        );
    }
    rules
}

pub(super) fn scope(
    reader: &mut Reader<'_, '_>,
    session: &LosslessString,
) -> Result<Option<Group>, Error> {
    let mut current = Some(session.clone());
    for _ in 0..32 {
        let Some(id) = current else {
            break;
        };
        if let Some(group) = reader
            .index::<GroupTable>("coordination_group_master_idx", &key(&id), 1)?
            .into_iter()
            .next()
        {
            return Ok(Some(group));
        }
        current = reader
            .get::<SessionTable>(&key(&id))?
            .and_then(|row| row.parent_id);
    }
    Ok(None)
}
pub(super) fn member(
    reader: &mut Reader<'_, '_>,
    session: &LosslessString,
) -> Result<Option<Group>, Error> {
    let Some(member) = reader
        .index::<MemberTable>("coordination_member_session_idx", &key(session), 1)?
        .into_iter()
        .next()
    else {
        return Ok(None);
    };
    reader.get::<GroupTable>(&key(&member.group_id))
}

pub(super) fn access(
    reader: &mut Reader<'_, '_>,
    session: &LosslessString,
) -> Result<Option<Resolved>, Error> {
    let mut current = Some(session.clone());
    for _ in 0..32 {
        let Some(id) = current else {
            break;
        };
        let group = match scope(reader, &id)? {
            Some(group) => Some(group),
            None => member(reader, &id)?,
        };
        if let Some(group) = group {
            let members = reader.members(&group.id)?;
            let owned = members
                .iter()
                .filter(|member| member.owner_session_id.as_ref() == Some(session))
                .map(|member| member.session_id.clone())
                .collect::<Vec<_>>();
            let role = if group.master_session_id == *session {
                Role::Master
            } else if owned.is_empty() {
                Role::Executor
            } else {
                Role::Supervisor
            };
            let owner = members
                .iter()
                .find(|member| member.session_id == *session)
                .map(|member| {
                    member
                        .owner_session_id
                        .clone()
                        .unwrap_or_else(|| group.master_session_id.clone())
                });
            return Ok(Some(Resolved {
                group,
                members,
                role,
                owner,
                owned,
            }));
        }
        current = reader
            .get::<SessionTable>(&key(&id))?
            .and_then(|row| row.parent_id);
    }
    Ok(None)
}

pub fn authorize_member_in(
    tx: &mut Write<'_>,
    caller: &session::Id,
    target: &session::Id,
    group: &c::GroupId,
) -> Result<(), Error> {
    let mut reader = Reader::Transaction(tx);
    let Some(access) = access(&mut reader, caller.as_lossless())? else {
        return Err(error::denied(
            "The project tool requires a current Project scope",
        ));
    };
    if &access.group.id != group.as_lossless()
        || !access
            .members
            .iter()
            .any(|member| &member.session_id == target.as_lossless())
    {
        return Err(error::denied("Session is not a member of this Project"));
    }
    if access.role != Role::Master
        && !access
            .owned
            .iter()
            .any(|member| member == target.as_lossless())
    {
        return Err(error::denied(
            "Only the current owner or Main acts on this member",
        ));
    }
    Ok(())
}
