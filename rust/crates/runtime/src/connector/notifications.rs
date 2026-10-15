use super::{Driver, Error, protocol_error};
use crate::{Core, convert};
use std::{
    collections::{BTreeMap, BTreeSet},
    time::{Duration, Instant},
};
use ycoding_core::{
    event_feed::{Item, Payload},
    session::{completion, list, outstanding},
    ycoding_schema::{LosslessString, session},
};
use ycoding_protocol::v5;

pub(super) const TYPES: &[&str] = &[
    "session.created.2",
    "session.deleted.2",
    "session.updated.1",
    "session.renamed.1",
    "session.moved.1",
    "session.execution.started.1",
    "session.execution.succeeded.1",
    "session.execution.failed.1",
    "session.execution.interrupted.1",
    "session.work.completed.1",
    "session.input.admitted.1",
    "session.input.promoted.1",
    "session.input.consumed.1",
    "session.task.updated.1",
    "session.shell.started.1",
    "session.shell.ended.1",
    "session.step.ended.1",
    "session.step.failed.1",
    "permission.asked",
    "permission.replied",
    "question.asked",
    "question.replied",
    "question.rejected",
    "form.created",
    "form.replied",
    "form.cancelled",
    "guardrail.asked",
    "guardrail.replied",
    "guardrail.decided",
    "session.status",
    "session.idle",
    "shell.created",
    "shell.exited",
    "shell.deleted",
];

pub(super) struct Notifications {
    last_status: Option<v5::Status>,
    due: Option<Instant>,
    requests: BTreeSet<session::Id>,
    failed: BTreeSet<LosslessString>,
    failures_dirty: bool,
    baseline: bool,
    after: Option<session::Id>,
    completion_due: Instant,
}

impl Notifications {
    pub(super) fn new() -> Self {
        Self {
            last_status: None,
            due: Some(Instant::now()),
            requests: BTreeSet::new(),
            failed: BTreeSet::new(),
            failures_dirty: true,
            baseline: true,
            after: None,
            completion_due: Instant::now(),
        }
    }

    fn changed(&mut self, item: &Item) {
        self.due
            .get_or_insert_with(|| Instant::now() + Duration::from_millis(250));
        match &item.payload {
            Payload::Ephemeral(event) => {
                self.requests.extend(event.session.clone());
            }
            Payload::Durable(event) => {
                if matches!(
                    event.type_.as_str(),
                    Some("session.execution.started.1" | "session.execution.failed.1")
                ) {
                    self.failures_dirty = true;
                }
            }
        }
    }

    fn status(&mut self, core: &Core) -> Result<v5::Status, Error> {
        let sessions = core
            .sessions
            .list(&list::Query::default())
            .map_err(|_| Error::Transport)?
            .into_iter()
            .map(|info| {
                Ok((
                    info.id
                        .as_lossless()
                        .to_utf8()
                        .map_err(|_| Error::Transport)?,
                    info,
                ))
            })
            .collect::<Result<BTreeMap<_, _>, Error>>()?;
        let active = core.execution.active();
        let work = outstanding::read(
            &core.sessions,
            &core.orchestration,
            core.execution.jobs(),
            &active,
            self.failures_dirty,
        )
        .map_err(|_| Error::Transport)?;
        if self.failures_dirty {
            self.failed = work.failed;
        }
        let roots = |ids: &BTreeSet<LosslessString>| {
            ids.iter()
                .filter_map(|id| root(id, &sessions))
                .collect::<BTreeSet<_>>()
        };
        let running = roots(&work.running);
        let owed = roots(&work.sessions)
            .difference(&running)
            .cloned()
            .collect::<BTreeSet<_>>();
        let lost = roots(&work.lost);
        let failed = roots(&self.failed);
        let mut locations = core
            .locations
            .cached()
            .into_iter()
            .map(|key| (key, Vec::new()))
            .collect::<BTreeMap<_, _>>();
        for info in sessions.values() {
            let key = (
                info.location.directory.as_lossless().clone(),
                info.location
                    .workspace_id
                    .as_ref()
                    .map(|id| id.as_lossless().clone()),
            );
            if let Some(members) = locations.get_mut(&key) {
                members.push(&info.id);
            }
        }
        for id in active.iter().chain(self.requests.iter()) {
            if let Some(info) =
                sessions.get(&id.as_lossless().to_utf8().map_err(|_| Error::Transport)?)
            {
                locations
                    .entry((
                        info.location.directory.as_lossless().clone(),
                        info.location
                            .workspace_id
                            .as_ref()
                            .map(|id| id.as_lossless().clone()),
                    ))
                    .or_insert_with(Vec::new)
                    .push(id);
            }
        }
        let mut needs = BTreeMap::new();
        let mut requests = BTreeSet::new();
        let mut need = |id: &LosslessString, kind: v5::AttentionNeed| {
            if let Some(root) = root(id, &sessions) {
                if let Ok(id) = session::Id::new(id.clone()) {
                    requests.insert(id);
                }
                needs
                    .entry(root)
                    .and_modify(|current: &mut v5::AttentionNeed| {
                        if (kind as i32) < (*current as i32) {
                            *current = kind;
                        }
                    })
                    .or_insert(kind);
            }
        };
        for members in locations.values() {
            if members.is_empty() {
                continue;
            }
            let (_, services) = core
                .locations
                .session(members[0])
                .map_err(|_| Error::Transport)?;
            for services in core.locations.policy_sets(&services.info) {
                for request in services.permissions.list() {
                    need(
                        request.session_id.as_lossless(),
                        v5::AttentionNeed::Permission,
                    );
                }
                for request in services.questions.list() {
                    need(
                        request.session_id.as_lossless(),
                        v5::AttentionNeed::Question,
                    );
                }
                for form in services.forms.list(None) {
                    need(&form.session_id, v5::AttentionNeed::Question);
                }
                let mut reviewed = BTreeSet::new();
                for member in members {
                    if !root(member.as_lossless(), &sessions)
                        .is_some_and(|root| reviewed.insert(root))
                    {
                        continue;
                    }
                    for request in services
                        .guardrails
                        .for_session(member)
                        .map_err(|_| Error::Transport)?
                    {
                        need(request.session_id.as_lossless(), v5::AttentionNeed::Review);
                    }
                }
            }
        }
        let attention = needs
            .keys()
            .cloned()
            .chain(failed.iter().cloned())
            .chain(lost.iter().cloned())
            .collect::<BTreeSet<_>>();
        let failed = failed
            .into_iter()
            .filter(|id| !needs.contains_key(id) && !lost.contains(id))
            .collect::<BTreeSet<_>>();
        let details = attention
            .iter()
            .filter_map(|id| {
                let title = sessions
                    .get(id)
                    .and_then(|session| alert_title(&convert::readable(&session.title)));
                let need = needs.get(id).map(|need| *need as i32);
                (title.is_some() || need.is_some()).then(|| v5::AttentionDetail {
                    session_id: id.clone(),
                    title: title.map(|title| convert::text(&title)),
                    need,
                })
            })
            .collect::<Vec<_>>();
        let result = v5::Status {
            running: bounded(running)?,
            attention: bounded(attention)?,
            outstanding: (!owed.is_empty())
                .then(|| bounded(owed).map(|items| v5::IdentifierList { items }))
                .transpose()?,
            failed: (!failed.is_empty())
                .then(|| bounded(failed).map(|items| v5::IdentifierList { items }))
                .transpose()?,
            details: (!details.is_empty()).then_some(v5::AttentionList { items: details }),
        };
        self.requests = requests;
        self.failures_dirty = false;
        Ok(result)
    }
}

impl Driver {
    pub(super) fn notification_event(&mut self, core: &Core, item: &Item) -> Result<(), Error> {
        self.notifications.changed(item);
        if let Payload::Durable(event) = &item.payload
            && event.type_.as_str() == Some("session.work.completed.1")
        {
            if self.notifications.baseline {
                self.notifications.after = None;
                self.notifications.completion_due = Instant::now();
            } else if let Err(error) = self.live_completion(core, event) {
                tracing::debug!(
                    ?error,
                    "live completion delivery failed; replaying the bounded baseline"
                );
                self.notifications.baseline = true;
                self.notifications.after = None;
                self.notifications.completion_due = Instant::now();
            }
        }
        Ok(())
    }

    fn live_completion(
        &mut self,
        core: &Core,
        event: &ycoding_core::ycoding_store::session::Event,
    ) -> Result<(), Error> {
        let id = session::Id::new(event.aggregate_id.clone()).map_err(|_| Error::Transport)?;
        if let Some(info) = core.sessions.get(&id).map_err(|_| Error::Transport)?
            && info.parent_id.is_none()
        {
            self.notification(v5::control::Kind::Completions(v5::Completions {
                items: vec![receipt(&event.id, event.seq, event.created, &info)?],
                more: false,
            }))?;
        }
        Ok(())
    }

    pub(super) fn feed_notifications(&mut self, core: &Core) -> Result<(), Error> {
        if !self.established {
            return Ok(());
        }
        if self
            .notifications
            .due
            .is_some_and(|due| Instant::now() >= due)
        {
            match self.notifications.status(core) {
                Ok(status) if self.notifications.last_status.as_ref() == Some(&status) => {
                    self.notifications.due = None;
                }
                Ok(status) => match self.notification(v5::control::Kind::Status(status.clone())) {
                    Ok(()) => {
                        self.notifications.last_status = Some(status);
                        self.notifications.due = None;
                    }
                    Err(error) => {
                        tracing::debug!(?error, "remote status delivery deferred");
                        self.notifications.due = Some(Instant::now() + Duration::from_secs(1));
                    }
                },
                Err(error) => {
                    tracing::debug!(?error, "remote status read deferred");
                    self.notifications.due = Some(Instant::now() + Duration::from_secs(1));
                }
            }
        }
        if self.notifications.baseline && Instant::now() >= self.notifications.completion_due {
            match self.completion_page(core) {
                Ok(next) => {
                    self.notifications.baseline = next.is_some();
                    self.notifications.after = next;
                    self.notifications.completion_due = Instant::now();
                }
                Err(error) => {
                    tracing::debug!(?error, "remote completion replay deferred");
                    self.notifications.completion_due = Instant::now() + Duration::from_secs(1);
                }
            }
        }
        Ok(())
    }

    fn completion_page(&mut self, core: &Core) -> Result<Option<session::Id>, Error> {
        let page =
            completion::Completion::new(core.sessions.clone(), core.execution.jobs().clone())
                .latest(completion::Page {
                    after: self.notifications.after.clone(),
                    limit: v5::CollectionLimit::CompletionsItemsMaxCount as usize,
                })
                .map_err(|_| Error::Transport)?;
        let items = page
            .data
            .iter()
            .map(|item| {
                let info = core
                    .sessions
                    .get(&item.session_id)
                    .map_err(|_| Error::Transport)?
                    .ok_or(Error::Transport)?;
                receipt(item.id.as_lossless(), item.seq, item.created, &info)
            })
            .collect::<Result<Vec<_>, _>>()?;
        self.notification(v5::control::Kind::Completions(v5::Completions {
            items,
            more: page.next.is_some(),
        }))?;
        Ok(page.next)
    }

    fn notification(&mut self, kind: v5::control::Kind) -> Result<(), Error> {
        let body = v5::frame::Body::Control(v5::Control { kind: Some(kind) });
        self.machine
            .enqueue(
                body.clone(),
                self.reserve(v5::LedgerClass::Normal, body),
                self.now(),
            )
            .map_err(protocol_error)
    }
}

fn root(id: &LosslessString, sessions: &BTreeMap<String, session::Info>) -> Option<String> {
    let mut current = id.to_utf8().ok()?;
    let mut seen = BTreeSet::new();
    loop {
        if !seen.insert(current.clone()) {
            return None;
        }
        let info = sessions.get(&current)?;
        let Some(parent) = &info.parent_id else {
            return Some(current);
        };
        current = parent.as_lossless().to_utf8().ok()?;
    }
}

fn bounded(ids: BTreeSet<String>) -> Result<Vec<String>, Error> {
    if ids.len() > v5::CollectionLimit::StatusRunningMaxCount as usize {
        return Err(Error::Transport);
    }
    Ok(ids.into_iter().collect())
}

fn receipt(
    id: &LosslessString,
    seq: i64,
    created: i64,
    info: &session::Info,
) -> Result<v5::Completion, Error> {
    if !(0..=9_007_199_254_740_991).contains(&seq)
        || !(-9_007_199_254_740_991..=9_007_199_254_740_991).contains(&created)
    {
        return Err(Error::Transport);
    }
    Ok(v5::Completion {
        id: id.to_utf8().map_err(|_| Error::Transport)?,
        sequence: seq as u64,
        created_ms: created,
        session_id: info
            .id
            .as_lossless()
            .to_utf8()
            .map_err(|_| Error::Transport)?,
        title: alert_title(&convert::readable(&info.title)).map(|title| convert::text(&title)),
    })
}

fn alert_title(value: &str) -> Option<String> {
    let clean = value
        .chars()
        .map(|point| {
            if point.is_control()
                || matches!(point, '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}' | '\u{feff}')
            {
                ' '
            } else {
                point
            }
        })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    if clean.is_empty() {
        return None;
    }
    let limit = v5::CodePointLimit::AttentionDetailTitleMaxCodepoints as usize;
    if clean.chars().count() <= limit {
        return Some(clean);
    }
    Some(format!(
        "{}…",
        clean.chars().take(limit - 1).collect::<String>().trim_end()
    ))
}

#[cfg(test)]
mod tests {
    use super::{Error, alert_title, bounded};

    #[test]
    fn status_bounds_reject_overflow_instead_of_truncating() {
        assert_eq!(
            bounded((0..500).map(|id| format!("ses_{id:03}")).collect())
                .unwrap()
                .len(),
            500
        );
        assert_eq!(
            bounded((0..501).map(|id| format!("ses_{id:03}")).collect()),
            Err(Error::Transport)
        );
    }

    #[test]
    fn titles_are_trimmed_bounded_and_free_of_controls_and_bidi() {
        assert_eq!(
            alert_title("\u{202e}\n\u{feff} Test\t value \u{2067}"),
            Some("Test value".into())
        );
        assert_eq!(alert_title("\u{85}\u{feff}"), None);
        assert_eq!(alert_title(&"🦀".repeat(120)).unwrap().chars().count(), 120);
        assert_eq!(
            alert_title(&"🦀".repeat(121)).unwrap(),
            format!("{}…", "🦀".repeat(119))
        );
    }
}
