use super::{Authority, Effect, Publisher, SessionAuthority, Wait, decision, state};
use std::{
    collections::BTreeMap,
    ops::Bound,
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};
use tokio::sync::oneshot;
use ycoding_schema::{
    LosslessString, permission, permission_saved, project_id::ProjectId, session_id::SessionId,
};
use ycoding_store::{
    Client, KeyPart, TableSpec,
    project::{Permission, PermissionTable},
    tuple_key,
};

#[derive(Debug)]
pub enum Error {
    Authority(state::Error),
    Store(ycoding_store::Error),
    Publish(String),
    Duplicate,
    NotFound,
    Blocked {
        rules: permission::Ruleset,
        permission: LosslessString,
        resources: Vec<LosslessString>,
    },
    Declined,
    Corrected(LosslessString),
}
impl From<state::Error> for Error {
    fn from(value: state::Error) -> Self {
        Self::Authority(value)
    }
}
impl From<ycoding_store::Error> for Error {
    fn from(value: ycoding_store::Error) -> Self {
        Self::Store(value)
    }
}

#[derive(Clone)]
pub struct SavedPermissions {
    pub store: Client,
}

impl SavedPermissions {
    pub fn list(&self, project: Option<&ProjectId>) -> Result<Vec<permission_saved::Info>, Error> {
        let snapshot = self.store.snapshot()?;
        let mut after = None;
        let mut result = vec![];
        loop {
            let rows = snapshot.scan::<PermissionTable>(
                after.as_deref().map_or(Bound::Unbounded, Bound::Excluded),
                Bound::Unbounded,
                128,
            )?;
            if rows.is_empty() {
                return Ok(result);
            }
            after = rows.last().map(PermissionTable::primary_key);
            for row in rows.into_iter().filter(|row| {
                project.is_none_or(|project| project.as_lossless() == &row.project_id)
            }) {
                result.push(permission_saved::Info {
                    id: permission_saved::Id(row.id),
                    project_id: ProjectId::new(row.project_id).expect("unrestricted project ID"),
                    action: row.action,
                    resource: row.resource,
                });
            }
        }
    }

    pub fn add(
        &self,
        project: &ProjectId,
        action: &LosslessString,
        resources: &[LosslessString],
    ) -> Result<(), Error> {
        if resources.is_empty() {
            return Ok(());
        }
        let project = project.as_lossless().clone();
        let action = action.clone();
        let resources = resources.to_vec();
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock after epoch")
            .as_millis() as i64;
        self.store
            .submit(move |tx| {
                for resource in resources {
                    let unique = tuple_key(&[
                        KeyPart::String(&project),
                        KeyPart::String(&action),
                        KeyPart::String(&resource),
                    ]);
                    if !tx
                        .index::<PermissionTable>(
                            "permission_project_action_resource_idx",
                            &unique,
                            None,
                            1,
                        )?
                        .is_empty()
                    {
                        continue;
                    }
                    tx.put::<PermissionTable>(&Permission {
                        id: state::decode_id::<permission::Id>("per_", 0).into_lossless(),
                        project_id: project.clone(),
                        action: action.clone(),
                        resource,
                        time_created: now,
                        time_updated: now,
                    })?;
                }
                Ok(())
            })?
            .wait()?;
        Ok(())
    }

    pub fn remove(&self, id: &permission_saved::Id) -> Result<(), Error> {
        let key = tuple_key(&[KeyPart::String(&id.0)]);
        self.store
            .submit(move |tx| {
                tx.delete::<PermissionTable>(&key)?;
                Ok(())
            })?
            .wait()?;
        Ok(())
    }

    fn rules(&self, project: &ProjectId) -> Result<permission::Ruleset, Error> {
        Ok(self
            .list(Some(project))?
            .into_iter()
            .map(|item| permission::Rule {
                action: item.action,
                resource: item.resource,
                effect: permission::Effect("allow".into()),
            })
            .collect())
    }
}

struct Pending {
    order: u64,
    request: permission::Request,
    agent: Option<LosslessString>,
    sender: oneshot::Sender<Result<(), Error>>,
}
struct Inner {
    authority: Authority,
    saved: SavedPermissions,
    project: ProjectId,
    publish: Publisher,
    pending: Mutex<BTreeMap<permission::Id, Pending>>,
}
#[derive(Clone)]
pub struct Permissions(Arc<Inner>);
pub struct Admission {
    pub id: permission::Id,
    pub effect: Effect,
    pub wait: Option<Wait<Result<(), Error>>>,
}

impl Permissions {
    pub fn new(authority: Authority, project: ProjectId, publish: Publisher) -> Self {
        Self(Arc::new(Inner {
            saved: SavedPermissions {
                store: authority.store.clone(),
            },
            authority,
            project,
            publish,
            pending: Mutex::new(BTreeMap::new()),
        }))
    }

    fn configured(
        &self,
        request: &permission::Request,
        agent: Option<&LosslessString>,
    ) -> Result<SessionAuthority, Error> {
        Ok(self.0.authority.session(&request.session_id, agent)?)
    }

    pub fn evaluate_effective(
        &self,
        session: &SessionId,
        agent: Option<&LosslessString>,
        action: &LosslessString,
        resource: &LosslessString,
    ) -> Result<Effect, Error> {
        let authority = self.0.authority.session(session, agent)?;
        if decision(
            action,
            std::slice::from_ref(resource),
            &authority.configured,
            &[],
        ) == Effect::Deny
        {
            return Ok(Effect::Deny);
        }
        Ok(decision(
            action,
            std::slice::from_ref(resource),
            &authority.configured,
            &self.0.saved.rules(&self.0.project)?,
        ))
    }

    pub fn ask(
        &self,
        request: permission::Request,
        agent: Option<LosslessString>,
    ) -> Result<Admission, Error> {
        let authority = self.configured(&request, agent.as_ref())?;
        let configured = decision(
            &request.action,
            &request.resources,
            &authority.configured,
            &[],
        );
        let effect = if configured == Effect::Deny {
            Effect::Deny
        } else {
            decision(
                &request.action,
                &request.resources,
                &authority.configured,
                &self.0.saved.rules(&self.0.project)?,
            )
        };
        let effect = if effect == Effect::Ask && authority.autonomy.can_auto_permission() {
            Effect::Allow
        } else {
            effect
        };
        let id = request.id.clone();
        if effect != Effect::Ask {
            return Ok(Admission {
                id,
                effect,
                wait: None,
            });
        }
        let (sender, receiver) = oneshot::channel();
        let mut pending = self
            .0
            .pending
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if pending.contains_key(&id) {
            return Err(Error::Duplicate);
        }
        pending.insert(
            id.clone(),
            Pending {
                order: state::next_order(),
                request: request.clone(),
                agent,
                sender,
            },
        );
        if let Err(error) = state::emit::<permission::Asked>(&self.0.publish, &request) {
            pending.remove(&id);
            return Err(Error::Publish(error));
        }
        Ok(Admission {
            id,
            effect,
            wait: Some(Wait::new(receiver, || {})),
        })
    }

    pub async fn assert(
        &self,
        request: permission::Request,
        agent: Option<LosslessString>,
    ) -> Result<(), Error> {
        let action = request.action.clone();
        let resources = request.resources.clone();
        let configured = self.configured(&request, agent.as_ref())?.configured;
        let admission = self.ask(request, agent)?;
        if admission.effect == Effect::Deny {
            return Err(Error::Blocked {
                rules: configured
                    .into_iter()
                    .filter(|rule| super::wildcard(&action, &rule.action))
                    .collect(),
                permission: action,
                resources,
            });
        }
        if let Some(wait) = admission.wait {
            let service = self.clone();
            let id = admission.id;
            return wait
                .on_cancel(move || service.cancel(&id))
                .await
                .map_err(|_| Error::Declined)?;
        }
        Ok(())
    }

    pub fn reply(
        &self,
        id: &permission::Id,
        reply: permission::Reply,
        message: Option<LosslessString>,
    ) -> Result<(), Error> {
        let mut pending = self
            .0
            .pending
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let item = pending.get(id).ok_or(Error::NotFound)?;
        let session_id = item.request.session_id.clone();
        state::emit::<permission::Replied>(
            &self.0.publish,
            &permission::RepliedData {
                session_id: session_id.clone(),
                request_id: id.clone(),
                reply: reply.clone(),
            },
        )
        .map_err(Error::Publish)?;
        let always = reply.0.as_str() == Some("always");
        if always && let Some(save) = &item.request.save {
            self.0
                .saved
                .add(&self.0.project, &item.request.action, save)?;
        }
        let saved = if always
            && item
                .request
                .save
                .as_ref()
                .is_some_and(|save| !save.is_empty())
        {
            Some(self.0.saved.rules(&self.0.project)?)
        } else {
            None
        };
        let item = pending.remove(id).expect("pending request held by lock");
        let reject = reply.0.as_str() == Some("reject");
        let result = if reject {
            Err(message
                .filter(|message| !message.is_empty())
                .map_or(Error::Declined, Error::Corrected))
        } else {
            Ok(())
        };
        let _ = item.sender.send(result);
        let ids = pending
            .iter()
            .filter_map(|(id, item)| {
                if reject {
                    return (item.request.session_id == session_id).then(|| id.clone());
                }
                let saved = saved.as_ref()?;
                let authority = self.configured(&item.request, item.agent.as_ref()).ok()?;
                (decision(
                    &item.request.action,
                    &item.request.resources,
                    &authority.configured,
                    saved,
                ) == Effect::Allow)
                    .then(|| id.clone())
            })
            .collect::<Vec<_>>();
        for id in ids {
            let item = pending.get(&id).expect("collected pending ID");
            state::emit::<permission::Replied>(
                &self.0.publish,
                &permission::RepliedData {
                    session_id: item.request.session_id.clone(),
                    request_id: id.clone(),
                    reply: permission::Reply(if reject { "reject" } else { "always" }.into()),
                },
            )
            .map_err(Error::Publish)?;
            let item = pending.remove(&id).expect("pending request held by lock");
            let _ = item
                .sender
                .send(if reject { Err(Error::Declined) } else { Ok(()) });
        }
        Ok(())
    }

    pub fn agent_selected(&self, session: &SessionId, agent: &LosslessString) -> Result<(), Error> {
        let ids = self
            .0
            .pending
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .iter()
            .filter(|(_, item)| {
                &item.request.session_id == session && item.agent.as_ref() != Some(agent)
            })
            .map(|(id, _)| id.clone())
            .collect::<Vec<_>>();
        for id in ids {
            let mut pending = self
                .0
                .pending
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            let Some(item) = pending.get(&id) else {
                continue;
            };
            state::emit::<permission::Replied>(
                &self.0.publish,
                &permission::RepliedData {
                    session_id: item.request.session_id.clone(),
                    request_id: id.clone(),
                    reply: permission::Reply("reject".into()),
                },
            )
            .map_err(Error::Publish)?;
            if let Some(item) = pending.remove(&id) {
                let _ = item.sender.send(Err(Error::Declined));
            }
        }
        Ok(())
    }

    pub fn list(&self) -> Vec<permission::Request> {
        let mut pending = self
            .0
            .pending
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .values()
            .map(|item| (item.order, item.request.clone()))
            .collect::<Vec<_>>();
        pending.sort_by_key(|(order, _)| *order);
        pending.into_iter().map(|(_, request)| request).collect()
    }
    pub fn for_session(&self, session: &SessionId) -> Vec<permission::Request> {
        self.list()
            .into_iter()
            .filter(|request| &request.session_id == session)
            .collect()
    }
    pub fn get(&self, id: &permission::Id) -> Option<permission::Request> {
        self.0
            .pending
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .get(id)
            .map(|item| item.request.clone())
    }
    pub fn cancel(&self, id: &permission::Id) {
        if let Some(item) = self
            .0
            .pending
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .remove(id)
        {
            let _ = item.sender.send(Err(Error::Declined));
        }
    }
    pub fn shutdown(&self) {
        let mut pending = self
            .0
            .pending
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        for (_, item) in std::mem::take(&mut *pending) {
            let _ = item.sender.send(Err(Error::Declined));
        }
    }
}
