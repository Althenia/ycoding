use super::{
    Error,
    authority::{self, Reader, key},
    error,
};
use crate::{
    event_feed::{self, Feed},
    session::{
        autonomy::{self, DecisionChange},
        projector::random_event_id,
    },
};
use std::{
    collections::{BTreeMap, BTreeSet},
    future::Future,
    ops::Bound,
    sync::{Arc, Mutex, Weak},
};
use ycoding_schema::{
    DomainDecode, DomainEncode, LosslessString, Nullable, coordination as c,
    schema::{NonNegativeInt, PositiveInt},
    session,
};
use ycoding_store::{
    Client, IndexOrder, IndexQuery, KeyPart, TableSpec, Write,
    coordination::{self as tables, GroupTable, MemberTable},
    resources::{Kv, KvTable},
    session::{self as events, Document, NewEvent, SessionTable},
};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Role {
    Master,
    Supervisor,
    Executor,
}
#[derive(Clone, Debug, PartialEq)]
pub struct Group {
    pub id: c::GroupId,
    pub name: LosslessString,
    pub revision: c::Revision,
    pub master_session_id: session::Id,
    pub member_session_ids: Vec<session::Id>,
    pub settings: c::GroupSettings,
    pub active: bool,
    pub paused_reason: Option<c::PausedReason>,
    pub time: c::Time,
}
#[derive(Clone, Debug, PartialEq)]
pub struct Scope {
    pub group_id: c::GroupId,
    pub master_session_id: session::Id,
    pub member_session_ids: Vec<session::Id>,
    pub settings: c::GroupSettings,
    pub active: bool,
    pub paused_reason: Option<c::PausedReason>,
}
#[derive(Clone, Debug, PartialEq)]
pub struct Access {
    pub scope: Scope,
    pub role: Role,
    pub owned_session_ids: Vec<session::Id>,
    pub owner_session_id: Option<session::Id>,
}
#[derive(Clone, Debug)]
pub struct OwnerInput {
    pub session_id: session::Id,
    pub owner_session_id: Option<session::Id>,
    pub reason: Option<c::ReleaseReason>,
}
pub fn can_act(access: &Access, id: &session::Id) -> bool {
    access.scope.member_session_ids.contains(id)
        && (access.role == Role::Master
            || (access.role == Role::Supervisor && access.owned_session_ids.contains(id)))
}

#[derive(Clone)]
pub struct Service {
    client: Client,
    feed: Feed,
    shared: Arc<Shared>,
}
struct Shared {
    live: Mutex<BTreeMap<c::GroupId, Live>>,
    locks: Mutex<BTreeMap<c::GroupId, Weak<tokio::sync::Mutex<()>>>>,
}
#[derive(Clone, Copy, Eq, PartialEq)]
enum Live {
    Created,
    Active,
    Interrupted,
}
struct Commit {
    row: tables::Group,
    members: Vec<tables::Member>,
    updated: c::GroupRevision,
    live: Option<Live>,
    deleted: bool,
    changed: bool,
}

impl Service {
    pub fn new(client: Client, feed: Feed) -> Self {
        Self {
            client,
            feed,
            shared: Arc::new(Shared {
                live: Mutex::new(BTreeMap::new()),
                locks: Mutex::new(BTreeMap::new()),
            }),
        }
    }
    pub(crate) fn client(&self) -> &Client {
        &self.client
    }
    async fn inherit_master_autonomy(
        &self,
        master: &session::Id,
        members: &[session::Id],
    ) -> Result<(), Error> {
        if members.is_empty() {
            return Ok(());
        }
        let service = autonomy::Service::new(self.client.clone());
        let effective = service.effective(master).map_err(autonomy_error)?;
        let change = DecisionChange::new(
            Some(effective.permissions),
            Some(effective.guardrails),
            Some(effective.answers),
        )
        .ok_or_else(error::conflict)?;
        for member in members {
            service
                .set_decisions(member, change)
                .await
                .map_err(autonomy_error)?;
        }
        Ok(())
    }
    pub fn get(&self, id: &c::GroupId) -> Result<Group, Error> {
        let snapshot = self.client.snapshot()?;
        let row = snapshot
            .get::<GroupTable>(&key(id.as_lossless()))?
            .ok_or_else(error::not_found)?;
        self.group(row, tables::members(&snapshot, id.as_lossless())?)
    }
    pub fn list(&self) -> Result<Vec<Group>, Error> {
        let snapshot = self.client.snapshot()?;
        snapshot
            .index_range::<GroupTable>(
                "coordination_group_updated_idx",
                IndexQuery {
                    lower: Bound::Unbounded,
                    upper: Bound::Unbounded,
                    prefix: None,
                    order: IndexOrder::Descending,
                    after: None,
                    limit: 200,
                },
            )?
            .into_iter()
            .map(|entry| {
                let members = tables::members(&snapshot, &entry.record.id)?;
                self.group(entry.record, members)
            })
            .collect()
    }
    pub fn scope_of(&self, id: &session::Id) -> Result<Option<Scope>, Error> {
        let snapshot = self.client.snapshot()?;
        authority::scope(&mut Reader::Snapshot(&snapshot), id.as_lossless())?
            .map(|row| {
                let members = tables::members(&snapshot, &row.id)?;
                self.group(row, members).map(scope)
            })
            .transpose()
    }
    pub fn member_of(&self, id: &session::Id) -> Result<Option<Scope>, Error> {
        let snapshot = self.client.snapshot()?;
        authority::member(&mut Reader::Snapshot(&snapshot), id.as_lossless())?
            .map(|row| {
                let members = tables::members(&snapshot, &row.id)?;
                self.group(row, members).map(scope)
            })
            .transpose()
    }
    pub fn access_of(&self, id: &session::Id) -> Result<Option<Access>, Error> {
        let snapshot = self.client.snapshot()?;
        authority::access(&mut Reader::Snapshot(&snapshot), id.as_lossless())?
            .map(|access| {
                Ok(Access {
                    scope: scope(self.group(access.group, access.members)?),
                    role: access.role,
                    owned_session_ids: access
                        .owned
                        .into_iter()
                        .map(session::Id::new)
                        .collect::<Result<_, _>>()?,
                    owner_session_id: access.owner.map(session::Id::new).transpose()?,
                })
            })
            .transpose()
    }
    pub async fn with_ownership<T>(&self, id: &c::GroupId, effect: impl Future<Output = T>) -> T {
        let mutex = {
            let mut locks = self
                .shared
                .locks
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            locks.retain(|_, lock| lock.strong_count() > 0);
            if let Some(lock) = locks.get(id).and_then(Weak::upgrade) {
                lock
            } else {
                let lock = Arc::new(tokio::sync::Mutex::new(()));
                locks.insert(id.clone(), Arc::downgrade(&lock));
                lock
            }
        };
        let _ownership = mutex.lock().await;
        effect.await
    }
    pub async fn create(&self, input: c::CreateInput) -> Result<Group, Error> {
        let input = c::CreateInput::decode(&input.encode())?;
        let random = random_event_id()?;
        let suffix = random
            .as_lossless()
            .as_str()
            .ok_or_else(|| Error::refused("Project identifier generation failed"))?;
        let id = c::GroupId::new(format!("cgrp_{suffix}"))?;
        let event = random_event_id()?;
        let master = input.master_session_id.clone();
        let members = input.member_session_ids.clone();
        let announcement = random_event_id()?.into_lossless();
        let commit = self
            .commit_unannounced(move |tx| {
                validate(
                    tx,
                    None,
                    &input.master_session_id,
                    &input.member_session_ids,
                )?;
                let now = chrono::Utc::now().timestamp_millis();
                let row = tables::Group {
                    id: id.into_lossless(),
                    name: input.name,
                    revision: 0,
                    master_session_id: input.master_session_id.into_lossless(),
                    concurrency: None,
                    delegated_decisions: None,
                    time_created: now,
                    time_updated: now,
                };
                GroupTable::insert(tx, &row)?;
                for member in input.member_session_ids {
                    MemberTable::insert(
                        tx,
                        &tables::Member {
                            group_id: row.id.clone(),
                            session_id: member.into_lossless(),
                            owner_session_id: None,
                        },
                    )?;
                }
                let members = tables::members_in(tx, &row.id)?;
                append(
                    tx,
                    event,
                    "coordination.group.created.2",
                    &row,
                    &snapshot(&row, &members)?,
                )?;
                change(row, members, Some(Live::Created), false, true)
            })
            .await?;
        self.inherit_master_autonomy(&master, &members).await?;
        self.announce(announcement, &commit.updated);
        self.group(commit.row, commit.members)
    }
    pub async fn add_member(
        &self,
        id: &c::GroupId,
        session_id: session::Id,
        owner_session_id: Option<session::Id>,
        preserve_autonomy: bool,
    ) -> Result<Group, Error> {
        let id = id.clone();
        let joined = session_id.clone();
        let changed = random_event_id()?;
        let owned = random_event_id()?;
        let announcement = random_event_id()?.into_lossless();
        let commit = self
            .commit_unannounced(move |tx| {
                let mut row = tx
                    .get::<GroupTable>(&key(id.as_lossless()))?
                    .ok_or_else(error::not_found)?;
                let master = session::Id::new(row.master_session_id.clone()).map_err(record)?;
                let mut ids = tables::members_in(tx, &row.id)?
                    .iter()
                    .map(|member| session::Id::new(member.session_id.clone()))
                    .collect::<Result<Vec<_>, _>>()
                    .map_err(record)?;
                ids.push(session_id.clone());
                validate(tx, Some(&row.id), &master, &ids)?;
                row.revision = row.revision.checked_add(1).ok_or_else(error::conflict)?;
                c::Revision::new(row.revision).map_err(record)?;
                row.time_updated = chrono::Utc::now().timestamp_millis();
                GroupTable::put(tx, &row)?;
                MemberTable::insert(
                    tx,
                    &tables::Member {
                        group_id: row.id.clone(),
                        session_id: session_id.as_lossless().clone(),
                        owner_session_id: owner_session_id
                            .as_ref()
                            .map(|owner| owner.as_lossless().clone()),
                    },
                )?;
                let members = tables::members_in(tx, &row.id)?;
                append(
                    tx,
                    changed,
                    "coordination.group.changed.1",
                    &row,
                    &snapshot(&row, &members)?,
                )?;
                if let Some(owner) = &owner_session_id {
                    let data = c::OwnerChangedData {
                        group_id: id.clone(),
                        revision: c::Revision::new(row.revision).map_err(record)?,
                        session_id: session_id.clone(),
                        owner_session_id: Some(owner.clone()),
                        reason: None,
                    };
                    append(
                        tx,
                        owned,
                        "coordination.member.owner.changed.1",
                        &row,
                        &data,
                    )?;
                }
                change(row, members, None, false, true)
            })
            .await?;
        if !preserve_autonomy {
            self.inherit_master_autonomy(
                &session::Id::new(commit.row.master_session_id.clone())?,
                std::slice::from_ref(&joined),
            )
            .await?;
        }
        self.announce(announcement, &commit.updated);
        self.group(commit.row, commit.members)
    }
    pub async fn remove_member(
        &self,
        id: &c::GroupId,
        session_id: &session::Id,
    ) -> Result<Group, Error> {
        let id = id.clone();
        let session_id = session_id.clone();
        let event = random_event_id()?;
        let commit = self
            .commit(move |tx| {
                let mut row = tx
                    .get::<GroupTable>(&key(id.as_lossless()))?
                    .ok_or_else(error::not_found)?;
                let primary = ycoding_store::tuple_key(&[
                    KeyPart::String(id.as_lossless()),
                    KeyPart::String(session_id.as_lossless()),
                ]);
                if tx.get::<MemberTable>(&primary)?.is_none() {
                    return Err(error::ineligible("Session is not a member of this Project"));
                }
                tx.delete::<MemberTable>(&primary)?;
                row.revision = row.revision.checked_add(1).ok_or_else(error::conflict)?;
                c::Revision::new(row.revision).map_err(record)?;
                row.time_updated = chrono::Utc::now().timestamp_millis();
                GroupTable::put(tx, &row)?;
                let members = tables::members_in(tx, &row.id)?;
                append(
                    tx,
                    event,
                    "coordination.group.changed.1",
                    &row,
                    &snapshot(&row, &members)?,
                )?;
                change(row, members, None, false, true)
            })
            .await?;
        self.group(commit.row, commit.members)
    }
    pub async fn update(&self, id: &c::GroupId, input: c::UpdateInput) -> Result<Group, Error> {
        self.with_ownership(id, self.update_inner(id, input)).await
    }
    async fn update_inner(&self, id: &c::GroupId, input: c::UpdateInput) -> Result<Group, Error> {
        let input = c::UpdateInput::decode(&input.encode())?;
        let previous = self.get(id)?.member_session_ids;
        let id = id.clone();
        let event = random_event_id()?;
        let announcement = random_event_id()?.into_lossless();
        let commit = self
            .commit_unannounced(move |tx| {
                let mut row = tx
                    .get::<GroupTable>(&key(id.as_lossless()))?
                    .ok_or_else(error::not_found)?;
                if row.revision != input.revision.get() {
                    return Err(error::conflict());
                }
                let previous = tables::members_in(tx, &row.id)?;
                let master = input
                    .master_session_id
                    .unwrap_or(session::Id::new(row.master_session_id.clone()).map_err(record)?);
                let ids = input.member_session_ids.unwrap_or(
                    previous
                        .iter()
                        .map(|member| session::Id::new(member.session_id.clone()))
                        .collect::<Result<Vec<_>, _>>()
                        .map_err(record)?,
                );
                validate(tx, Some(&row.id), &master, &ids)?;
                let owners = if master.as_lossless() == &row.master_session_id {
                    previous
                        .iter()
                        .filter_map(|member| {
                            member
                                .owner_session_id
                                .as_ref()
                                .map(|owner| (member.session_id.clone(), owner.clone()))
                        })
                        .collect::<BTreeMap<_, _>>()
                } else {
                    BTreeMap::new()
                };
                if let Some(name) = input.name {
                    row.name = name;
                }
                if master.as_lossless() != &row.master_session_id {
                    tx.delete::<KvTable>(&pause_key(&id))?;
                }
                row.master_session_id = master.into_lossless();
                row.revision = row.revision.checked_add(1).ok_or_else(error::conflict)?;
                c::Revision::new(row.revision).map_err(record)?;
                row.time_updated = chrono::Utc::now().timestamp_millis();
                if let Some(settings) = input.settings {
                    row.concurrency = match settings.concurrency {
                        Nullable::Null => None,
                        Nullable::Value(value) => Some(value.get()),
                    };
                    row.delegated_decisions = settings
                        .delegated_decisions
                        .as_ref()
                        .map(Document::from_domain)
                        .transpose()?;
                }
                for member in previous {
                    tx.delete::<MemberTable>(&MemberTable::primary_key(&member))?;
                }
                GroupTable::put(tx, &row)?;
                for member in ids {
                    MemberTable::insert(
                        tx,
                        &tables::Member {
                            group_id: row.id.clone(),
                            owner_session_id: owners.get(member.as_lossless()).cloned(),
                            session_id: member.into_lossless(),
                        },
                    )?;
                }
                let members = tables::members_in(tx, &row.id)?;
                append(
                    tx,
                    event,
                    "coordination.group.changed.1",
                    &row,
                    &snapshot(&row, &members)?,
                )?;
                change(row, members, None, false, true)
            })
            .await?;
        let updated = commit.updated.clone();
        let group = self.group(commit.row, commit.members)?;
        let added = group
            .member_session_ids
            .iter()
            .filter(|member| !previous.contains(member))
            .cloned()
            .collect::<Vec<_>>();
        self.inherit_master_autonomy(&group.master_session_id, &added)
            .await?;
        self.announce(announcement, &updated);
        Ok(group)
    }
    pub async fn delete(&self, id: &c::GroupId) -> Result<(), Error> {
        self.with_ownership(id, self.delete_inner(id)).await
    }
    async fn delete_inner(&self, id: &c::GroupId) -> Result<(), Error> {
        let id = id.clone();
        let event = random_event_id()?;
        self.commit(move |tx| {
            let mut row = tx
                .get::<GroupTable>(&key(id.as_lossless()))?
                .ok_or_else(error::not_found)?;
            row.revision = row.revision.checked_add(1).ok_or_else(error::conflict)?;
            let data = c::GroupRevision {
                group_id: id,
                revision: c::Revision::new(row.revision).map_err(record)?,
            };
            tables::delete(tx, &row.id)?;
            tx.delete::<KvTable>(&pause_key(&data.group_id))?;
            append(tx, event, "coordination.group.deleted.1", &row, &data)?;
            change(row, vec![], None, true, true)
        })
        .await?;
        Ok(())
    }
    pub async fn set_owner(&self, id: &c::GroupId, input: OwnerInput) -> Result<(), Error> {
        let id = id.clone();
        let event = random_event_id()?;
        self.commit(move |tx| {
            let row = tx
                .get::<GroupTable>(&key(id.as_lossless()))?
                .ok_or_else(error::not_found)?;
            let primary = ycoding_store::tuple_key(&[
                ycoding_store::KeyPart::String(&row.id),
                ycoding_store::KeyPart::String(input.session_id.as_lossless()),
            ]);
            let mut member = tx
                .get::<MemberTable>(&primary)?
                .ok_or_else(error::not_found)?;
            let owner = input
                .owner_session_id
                .as_ref()
                .map(|id| id.as_lossless().clone());
            if member.owner_session_id == owner {
                return change(
                    row,
                    tables::members_in(tx, id.as_lossless())?,
                    None,
                    false,
                    false,
                );
            }
            member.owner_session_id = owner;
            MemberTable::put(tx, &member)?;
            let data = c::OwnerChangedData {
                group_id: id,
                revision: c::Revision::new(row.revision).map_err(record)?,
                session_id: input.session_id,
                owner_session_id: input.owner_session_id,
                reason: input.reason,
            };
            append(
                tx,
                event,
                "coordination.member.owner.changed.1",
                &row,
                &data,
            )?;
            let members = tables::members_in(tx, &row.id)?;
            change(row, members, None, false, true)
        })
        .await?;
        Ok(())
    }
    pub fn activate(&self, id: &c::GroupId) -> Result<(), Error> {
        self.live(id, Live::Active)
    }
    pub fn pause(&self, id: &c::GroupId) -> Result<(), Error> {
        self.live(id, Live::Interrupted)
    }
    pub fn pause_master(&self, id: &session::Id) -> Result<(), Error> {
        if let Some(scope) = self
            .scope_of(id)?
            .filter(|scope| scope.master_session_id == *id)
        {
            self.pause(&scope.group_id)?;
        }
        Ok(())
    }
    fn live(&self, id: &c::GroupId, value: Live) -> Result<(), Error> {
        let group = self.get(id)?;
        let key = pause_key(id);
        let name = pause_name(id);
        let paused = value == Live::Interrupted;
        self.client
            .submit(move |tx| {
                if paused {
                    let time = chrono::Utc::now().timestamp_millis();
                    KvTable::put(
                        tx,
                        &Kv {
                            key: name,
                            value: Document::new(ycoding_schema::JsonValue::Bool(true))?,
                            time_created: time,
                            time_updated: time,
                        },
                    )
                } else {
                    tx.delete::<KvTable>(&key)?;
                    Ok(())
                }
            })?
            .wait()?;
        let event = random_event_id()?;
        {
            let mut live = self
                .shared
                .live
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            if live.get(id) == Some(&value) {
                return Ok(());
            }
            live.insert(id.clone(), value);
        }
        publish(
            &self.feed,
            event.into_lossless(),
            c::GroupRevision {
                group_id: id.clone(),
                revision: group.revision,
            },
        );
        Ok(())
    }
    async fn commit(
        &self,
        operation: impl FnOnce(&mut Write<'_>) -> Result<Commit, ycoding_store::Error> + Send + 'static,
    ) -> Result<Commit, Error> {
        let announcement = random_event_id()?.into_lossless();
        let commit = self.commit_unannounced(operation).await?;
        if commit.changed {
            self.announce(announcement, &commit.updated);
        }
        Ok(commit)
    }
    async fn commit_unannounced(
        &self,
        operation: impl FnOnce(&mut Write<'_>) -> Result<Commit, ycoding_store::Error> + Send + 'static,
    ) -> Result<Commit, Error> {
        let shared = Arc::clone(&self.shared);
        Ok(self
            .client
            .submit_owned(operation, move |result| {
                let Ok(change) = result else {
                    return;
                };
                if !change.changed {
                    return;
                }
                let mut live = shared
                    .live
                    .lock()
                    .unwrap_or_else(|error| error.into_inner());
                if change.deleted {
                    live.remove(&change.updated.group_id);
                } else if let Some(value) = change.live {
                    live.insert(change.updated.group_id.clone(), value);
                }
            })?
            .await?)
    }
    fn announce(&self, id: LosslessString, updated: &c::GroupRevision) {
        publish(&self.feed, id, updated.clone());
    }
    fn group(&self, row: tables::Group, members: Vec<tables::Member>) -> Result<Group, Error> {
        let id = c::GroupId::new(row.id.clone())?;
        let live = self
            .shared
            .live
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .get(&id)
            .copied();
        let live = match live {
            Some(live) => live,
            None => {
                let paused = self
                    .client
                    .snapshot()?
                    .get::<KvTable>(&pause_key(&id))?
                    .is_some();
                *self
                    .shared
                    .live
                    .lock()
                    .unwrap_or_else(|error| error.into_inner())
                    .entry(id.clone())
                    .or_insert(if paused {
                        Live::Interrupted
                    } else {
                        Live::Active
                    })
            }
        };
        Ok(Group {
            id,
            name: row.name.clone(),
            revision: c::Revision::new(row.revision)?,
            master_session_id: session::Id::new(row.master_session_id.clone())?,
            member_session_ids: members
                .into_iter()
                .map(|member| session::Id::new(member.session_id))
                .collect::<Result<_, _>>()?,
            settings: settings(&row)?,
            active: live == Live::Active,
            paused_reason: (live == Live::Interrupted).then_some(c::PausedReason::Interrupted),
            time: c::Time {
                created: NonNegativeInt::new(row.time_created)?,
                updated: NonNegativeInt::new(row.time_updated)?,
            },
        })
    }
}
fn autonomy_error(error: autonomy::Error) -> Error {
    match error {
        autonomy::Error::Store(error) => Error::Store(error),
        autonomy::Error::NotFound(_) => Error::refused("Session does not exist"),
    }
}
fn pause_name(id: &c::GroupId) -> LosslessString {
    let mut units = "coordination.paused.".encode_utf16().collect::<Vec<_>>();
    units.extend(id.as_lossless().code_units());
    LosslessString::from_utf16(units)
}
fn pause_key(id: &c::GroupId) -> Vec<u8> {
    ycoding_store::tuple_key(&[KeyPart::String(&pause_name(id))])
}
fn scope(group: Group) -> Scope {
    Scope {
        group_id: group.id,
        master_session_id: group.master_session_id,
        member_session_ids: group.member_session_ids,
        settings: group.settings,
        active: group.active,
        paused_reason: group.paused_reason,
    }
}
fn record(error: ycoding_schema::DecodeError) -> ycoding_store::Error {
    ycoding_store::Error::Record(Box::new(error))
}
fn settings(row: &tables::Group) -> Result<c::GroupSettings, ycoding_store::Error> {
    Ok(c::GroupSettings {
        concurrency: row
            .concurrency
            .map(PositiveInt::new)
            .transpose()
            .map_err(record)?
            .map_or(Nullable::Null, Nullable::Value),
        delegated_decisions: row
            .delegated_decisions
            .as_ref()
            .map(Document::domain)
            .transpose()?,
    })
}
fn snapshot(
    row: &tables::Group,
    members: &[tables::Member],
) -> Result<c::Snapshot, ycoding_store::Error> {
    Ok(c::Snapshot {
        group_id: c::GroupId::new(row.id.clone()).map_err(record)?,
        revision: c::Revision::new(row.revision).map_err(record)?,
        name: row.name.clone(),
        master_session_id: session::Id::new(row.master_session_id.clone()).map_err(record)?,
        member_session_ids: members
            .iter()
            .map(|member| session::Id::new(member.session_id.clone()))
            .collect::<Result<_, _>>()
            .map_err(record)?,
        settings: settings(row)?,
    })
}
fn change(
    row: tables::Group,
    members: Vec<tables::Member>,
    live: Option<Live>,
    deleted: bool,
    changed: bool,
) -> Result<Commit, ycoding_store::Error> {
    let updated = c::GroupRevision {
        group_id: c::GroupId::new(row.id.clone()).map_err(record)?,
        revision: c::Revision::new(row.revision).map_err(record)?,
    };
    Ok(Commit {
        row,
        members,
        updated,
        live,
        deleted,
        changed,
    })
}
fn append(
    tx: &mut Write<'_>,
    id: ycoding_schema::event::Id,
    kind: &str,
    row: &tables::Group,
    data: &impl DomainEncode,
) -> Result<(), ycoding_store::Error> {
    match events::append(
        tx,
        &NewEvent {
            id: id.into_lossless(),
            aggregate_id: row.id.clone(),
            created: chrono::Utc::now().timestamp_millis(),
            type_: kind.into(),
            data: data.encode(),
        },
        None,
    )? {
        events::Append::Appended(_) => Ok(()),
        events::Append::Replayed(_) | events::Append::Ignored => Err(
            ycoding_store::Error::Rejected("duplicate Project event identity"),
        ),
    }
}
fn publish(feed: &Feed, id: LosslessString, data: c::GroupRevision) {
    feed.publish(event_feed::Ephemeral {
        id,
        created: chrono::Utc::now().timestamp_millis(),
        session: None,
        location: None,
        metadata: None,
        data: event_feed::Data::CoordinationUpdated(Box::new(data)),
    });
}
fn validate(
    tx: &mut Write<'_>,
    group: Option<&LosslessString>,
    master: &session::Id,
    members: &[session::Id],
) -> Result<(), ycoding_store::Error> {
    if members.len() > c::MAX_MEMBERS {
        return Err(error::ineligible("A Project admits at most 64 members"));
    }
    let mut seen = BTreeSet::new();
    for id in std::iter::once(master).chain(members) {
        if !seen.insert(id) {
            return Err(error::ineligible(
                "Main and members must be distinct Sessions",
            ));
        }
        let row = tx
            .get::<SessionTable>(&key(id.as_lossless()))?
            .ok_or_else(|| error::ineligible("Session does not exist"))?;
        if row.parent_id.is_some() || row.time_archived.is_some() {
            return Err(error::ineligible("Only active root Sessions are eligible"));
        }
        if tx
            .index::<GroupTable>(
                "coordination_group_master_idx",
                &key(id.as_lossless()),
                None,
                1,
            )?
            .iter()
            .any(|row| Some(&row.id) != group)
            || tx
                .index::<MemberTable>(
                    "coordination_member_session_idx",
                    &key(id.as_lossless()),
                    None,
                    1,
                )?
                .iter()
                .any(|row| Some(&row.group_id) != group)
        {
            return Err(error::ineligible(
                "Session already belongs to another Project",
            ));
        }
    }
    Ok(())
}
