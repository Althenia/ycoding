use super::{Authority, Publisher, Wait, state};
use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex},
};
use tokio::sync::oneshot;
use ycoding_schema::question;

#[derive(Debug)]
pub enum Error {
    NotFound,
    Duplicate,
    Rejected,
    Publish(String),
}
struct Pending {
    order: u64,
    request: question::Request,
    sender: oneshot::Sender<Result<Vec<question::Answer>, Error>>,
}
struct Inner {
    authority: Authority,
    publish: Publisher,
    pending: Mutex<BTreeMap<question::Id, Pending>>,
}
#[derive(Clone)]
pub struct Questions(Arc<Inner>);
pub enum Admission {
    Answered(Vec<question::Answer>),
    Pending(Wait<Result<Vec<question::Answer>, Error>>),
}

impl Questions {
    pub fn new(authority: Authority, publish: Publisher) -> Self {
        Self(Arc::new(Inner {
            authority,
            publish,
            pending: Mutex::new(BTreeMap::new()),
        }))
    }
    pub fn ask(&self, request: question::Request) -> Result<Admission, Error> {
        if self
            .0
            .authority
            .session(&request.session_id, None)
            .is_ok_and(|session| session.autonomy.can_auto_answer())
        {
            return Ok(Admission::Answered(
                request
                    .questions
                    .iter()
                    .map(|question| {
                        vec![
                            question
                                .options
                                .first()
                                .filter(|option| !option.label.is_empty())
                                .map_or_else(
                                    || "Continue with the safest reasonable default.".into(),
                                    |option| option.label.clone(),
                                ),
                        ]
                    })
                    .collect(),
            ));
        }
        let id = request.id.clone();
        let mut pending = self
            .0
            .pending
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if pending.contains_key(&id) {
            return Err(Error::Duplicate);
        }
        let (sender, receiver) = oneshot::channel();
        pending.insert(
            id.clone(),
            Pending {
                order: state::next_order(),
                request: request.clone(),
                sender,
            },
        );
        if let Err(error) = state::emit::<question::Asked>(&self.0.publish, &request) {
            pending.remove(&id);
            return Err(Error::Publish(error));
        }
        let service = self.clone();
        Ok(Admission::Pending(Wait::new(receiver, move || {
            service.cancel(&id);
        })))
    }
    pub fn reply(&self, id: &question::Id, answers: Vec<question::Answer>) -> Result<(), Error> {
        let mut pending = self
            .0
            .pending
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let item = pending.get(id).ok_or(Error::NotFound)?;
        state::emit::<question::Replied>(
            &self.0.publish,
            &question::RepliedData {
                session_id: item.request.session_id.clone(),
                request_id: id.clone(),
                answers: answers.clone(),
            },
        )
        .map_err(Error::Publish)?;
        let item = pending.remove(id).expect("pending question held by lock");
        let _ = item.sender.send(Ok(answers));
        Ok(())
    }
    pub fn reject(&self, id: &question::Id) -> Result<(), Error> {
        let mut pending = self
            .0
            .pending
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let item = pending.get(id).ok_or(Error::NotFound)?;
        state::emit::<question::Rejected>(
            &self.0.publish,
            &question::RejectedData {
                session_id: item.request.session_id.clone(),
                request_id: id.clone(),
            },
        )
        .map_err(Error::Publish)?;
        let item = pending.remove(id).expect("pending question held by lock");
        let _ = item.sender.send(Err(Error::Rejected));
        Ok(())
    }
    pub fn list(&self) -> Vec<question::Request> {
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
    pub fn cancel(&self, id: &question::Id) {
        if let Some(item) = self
            .0
            .pending
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .remove(id)
        {
            let _ = item.sender.send(Err(Error::Rejected));
        }
    }
    pub fn shutdown(&self) {
        let mut pending = self
            .0
            .pending
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        for (_, item) in std::mem::take(&mut *pending) {
            let _ = item.sender.send(Err(Error::Rejected));
        }
    }
}
