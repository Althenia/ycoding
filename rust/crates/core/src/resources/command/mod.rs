use super::{
    config::Entry,
    discovery::{self, Error},
};
use std::path::Path;
use ycoding_schema::{DomainDecode, DomainEncode, JsonValue, LosslessString, command::Info};
#[derive(Clone, Default)]
pub struct Service {
    pub event_source: crate::event_feed::EventSource,
    commands: Vec<Info>,
    bundled: Vec<Filled>,
    revision: u64,
}
#[derive(Clone)]
struct Filled {
    name: LosslessString,
    position: Option<usize>,
    template: Option<LosslessString>,
    description: Option<LosslessString>,
}
impl Service {
    pub fn from_entries(
        entries: &[Entry],
        diagnostics: &mut Vec<discovery::Diagnostic>,
    ) -> Result<Self, Error> {
        Self::from_documents(&discovery::documents(
            entries,
            discovery::Kind::Command,
            diagnostics,
        ))
    }
    pub fn from_project_entries(
        entries: &[Entry],
        project: &Path,
        diagnostics: &mut Vec<discovery::Diagnostic>,
    ) -> Result<Self, Error> {
        let mut service = Self::default();
        service.configure_entries(entries, diagnostics)?;
        service.settle_builtins(
            &crate::extension::plugin::disabled_from_entries(entries, project),
            project,
        )?;
        Ok(service)
    }
    pub fn configure_entries(
        &mut self,
        entries: &[Entry],
        diagnostics: &mut Vec<discovery::Diagnostic>,
    ) -> Result<(), Error> {
        self.configure(&discovery::documents(
            entries,
            discovery::Kind::Command,
            diagnostics,
        ))
    }
    pub fn settle_builtins(
        &mut self,
        builtins: &crate::extension::plugin::Builtins,
        project: &Path,
    ) -> Result<(), Error> {
        let directory = project
            .to_str()
            .ok_or_else(|| Error::InvalidPath(project.into()))?;
        let bundled = [
            (
                "init",
                include_str!("initialize.txt"),
                "guided AGENTS.md setup",
            ),
            (
                "review",
                include_str!("review.txt"),
                "review changes [commit|branch|pr], defaults to uncommitted",
            ),
        ]
        .map(|(name, template, description)| {
            (
                LosslessString::from(name),
                LosslessString::from(template.replacen("${path}", directory, 1)),
                LosslessString::from(description),
            )
        });
        let disabled = builtins.is_disabled("ycoding.command");
        if disabled == self.bundled.is_empty() {
            return Ok(());
        }
        if disabled {
            for filled in std::mem::take(&mut self.bundled).into_iter().rev() {
                let Some(position) = self.commands.iter().position(|c| c.name == filled.name)
                else {
                    continue;
                };
                let mut command = self.commands.remove(position);
                if filled.template.as_ref() == Some(&command.template) {
                    command.template = "".into();
                }
                if filled.description.is_some() && filled.description == command.description {
                    command.description = None;
                }
                let unset = command.template.is_empty()
                    && command.description.is_none()
                    && command.agent.is_none()
                    && command.model.is_none()
                    && command.subtask.is_none()
                    && command.locations.is_none();
                if !unset {
                    let index = filled.position.unwrap_or(self.commands.len());
                    self.commands
                        .insert(index.min(self.commands.len()), command);
                }
            }
        } else {
            for (index, (name, template, description)) in bundled.into_iter().enumerate() {
                let position = self.commands.iter().position(|c| c.name == name);
                let mut command = match position {
                    Some(position) => self.commands.remove(position),
                    None => Info {
                        name: name.clone(),
                        template: "".into(),
                        description: None,
                        agent: None,
                        model: None,
                        subtask: None,
                        locations: None,
                    },
                };
                let filled = Filled {
                    name,
                    position,
                    template: command.template.is_empty().then(|| template.clone()),
                    description: command.description.is_none().then(|| description.clone()),
                };
                if command.template.is_empty() {
                    command.template = template;
                }
                if command.description.is_none() {
                    command.description = Some(description);
                }
                self.commands.insert(index, command);
                self.bundled.push(filled);
            }
        }
        self.revision += 1;
        if self
            .event_source
            .emit(crate::event_feed::Data::CommandUpdated(Box::new(
                ycoding_schema::command::Empty,
            )))
            .is_err()
        {
            eprintln!("Command event publication failed");
        }
        Ok(())
    }
    pub fn from_documents(entries: &[Entry]) -> Result<Self, Error> {
        let mut service = Self::default();
        service.configure(entries)?;
        Ok(service)
    }
    fn configure(&mut self, entries: &[Entry]) -> Result<(), Error> {
        for entry in entries {
            let Entry::Document { path, info } = entry else {
                continue;
            };
            let Some(commands) = discovery::object(info)?.get(&"commands".into()) else {
                continue;
            };
            for (name, value) in discovery::object(commands)?.iter() {
                if self.get(name).is_none() {
                    self.update(name.clone(), |_| {});
                }
                let current = self
                    .commands
                    .iter_mut()
                    .find(|c| &c.name == name)
                    .expect("command was just inserted");
                let JsonValue::Object(mut encoded) = current.encode() else {
                    unreachable!()
                };
                let value = discovery::object(value)?;
                for field in ["template", "description", "agent", "subtask"] {
                    if let Some(value) = value.get(&field.into()) {
                        encoded.insert(field.into(), value.clone());
                    }
                }
                if let Some(value) = value.get(&"model".into()) {
                    encoded.insert("model".into(), discovery::selection(value)?.encode());
                }
                if let Some(path) = path.as_ref().filter(|p| p.is_absolute()) {
                    let location = discovery::absolute_path(path)?;
                    let locations = current.locations.get_or_insert_with(Vec::new);
                    if !locations.contains(&location) {
                        locations.push(location);
                    }
                    encoded.insert("locations".into(), locations.encode());
                }
                *current = Info::decode(&JsonValue::Object(encoded))?;
            }
        }
        Ok(())
    }
    pub fn list(&self) -> &[Info] {
        &self.commands
    }
    pub fn get(&self, name: &LosslessString) -> Option<&Info> {
        self.commands.iter().find(|c| &c.name == name)
    }
    pub fn update(&mut self, name: LosslessString, f: impl FnOnce(&mut Info)) {
        if self.get(&name).is_none() {
            self.commands.push(Info {
                name: name.clone(),
                template: "".into(),
                description: None,
                agent: None,
                model: None,
                subtask: None,
                locations: None,
            });
        }
        let command = self
            .commands
            .iter_mut()
            .find(|c| c.name == name)
            .expect("command was just inserted");
        f(command);
        command.name = name;
        self.revision += 1;
        if self
            .event_source
            .emit(crate::event_feed::Data::CommandUpdated(Box::new(
                ycoding_schema::command::Empty,
            )))
            .is_err()
        {
            eprintln!("Command event publication failed");
        }
    }
    pub fn remove(&mut self, name: &LosslessString) {
        self.commands.retain(|c| &c.name != name);
        self.revision += 1;
        if self
            .event_source
            .emit(crate::event_feed::Data::CommandUpdated(Box::new(
                ycoding_schema::command::Empty,
            )))
            .is_err()
        {
            eprintln!("Command event publication failed");
        }
    }
    pub fn revision(&self) -> u64 {
        self.revision
    }
}
