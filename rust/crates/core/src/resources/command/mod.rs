use super::{
    config::Entry,
    discovery::{self, Error},
};
use ycoding_schema::{DomainDecode, DomainEncode, JsonValue, LosslessString, command::Info};
#[derive(Clone, Default)]
pub struct Service {
    commands: Vec<Info>,
    revision: u64,
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
    pub fn from_documents(entries: &[Entry]) -> Result<Self, Error> {
        let mut service = Self::default();
        for entry in entries {
            let Entry::Document { path, info } = entry else {
                continue;
            };
            let Some(commands) = discovery::object(info)?.get(&"commands".into()) else {
                continue;
            };
            for (name, value) in discovery::object(commands)?.iter() {
                if service.get(name).is_none() {
                    service.update(name.clone(), |_| {});
                }
                let current = service
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
        Ok(service)
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
    }
    pub fn remove(&mut self, name: &LosslessString) {
        self.commands.retain(|c| &c.name != name);
        self.revision += 1;
    }
    pub fn revision(&self) -> u64 {
        self.revision
    }
}
