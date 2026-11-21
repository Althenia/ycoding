use super::{
    config::Entry,
    discovery::{self, Error},
};
use std::path::Path;
use ycoding_schema::{
    DomainDecode, DomainEncode, JsonObject, JsonValue, LosslessString,
    agent::{Id, Info},
    permission, provider,
};

pub const DEFAULT_ID: &str = "god";
pub mod builtin;
pub mod prompts;
pub fn empty(id: Id) -> Info {
    Info {
        name: id.clone(),
        id,
        model: None,
        request: provider::Request {
            settings: provider::Settings::default(),
            headers: JsonObject::new(),
            body: provider::Settings::default(),
        },
        system: None,
        description: None,
        mode: "all".into(),
        hidden: false,
        color: None,
        steps: None,
        locations: None,
        permissions: vec![
            permission::Rule {
                action: "*".into(),
                resource: "*".into(),
                effect: permission::Effect("allow".into()),
            },
            permission::Rule {
                action: "external_directory".into(),
                resource: "*".into(),
                effect: permission::Effect("ask".into()),
            },
        ],
    }
}
pub fn is_selectable(agent: &Info) -> bool {
    agent.mode != "subagent".into() && !agent.hidden && agent.id != "btw".into()
}
pub fn is_autocomplete_selectable(agent: &Info) -> bool {
    !agent.hidden && agent.mode != "primary".into() && agent.id != "btw".into()
}
pub struct Selection<'a> {
    pub id: Id,
    pub info: Option<&'a Info>,
}

#[derive(Clone)]
pub struct Service {
    pub event_source: crate::event_feed::EventSource,
    agents: Vec<Info>,
    default: Option<Id>,
    revision: u64,
}
impl Service {
    pub fn new(agents: Vec<Info>) -> Self {
        Self {
            agents,
            event_source: Default::default(),
            default: None,
            revision: 0,
        }
    }
    pub fn from_entries(
        entries: &[Entry],
        home: &Path,
        agents: Vec<Info>,
        diagnostics: &mut Vec<discovery::Diagnostic>,
    ) -> Result<Self, Error> {
        Self::from_documents(
            &discovery::documents(entries, discovery::Kind::Agent, diagnostics),
            home,
            agents,
        )
    }
    pub fn from_documents(
        entries: &[Entry],
        home: &Path,
        agents: Vec<Info>,
    ) -> Result<Self, Error> {
        let mut service = Self::new(agents);
        let documents = entries
            .iter()
            .filter_map(|e| match e {
                Entry::Document { path, info } => Some((path, info)),
                _ => None,
            })
            .collect::<Vec<_>>();
        let mut permissions = Vec::new();
        for (_, doc) in &documents {
            let doc = discovery::object(doc)?;
            if let Some(value) = doc.get(&"permissions".into()) {
                permissions.extend(expand_permissions(
                    Vec::<permission::Rule>::decode(value)?,
                    home,
                )?);
            }
            if let Some(value) = doc.get(&"default_agent".into()) {
                service.default = Some(Id::decode(value)?);
            }
        }
        for agent in &mut service.agents {
            agent.permissions.extend(permissions.iter().cloned());
        }
        for (path, doc) in documents {
            let Some(items) = discovery::object(doc)?.get(&"agents".into()) else {
                continue;
            };
            for (id, item) in discovery::object(items)?.iter() {
                let item = discovery::object(item)?;
                if item.get(&"disabled".into()) == Some(&JsonValue::Bool(true)) {
                    service.remove(id);
                    continue;
                }
                if service.get(id).is_none() {
                    let mut agent = empty(id.clone());
                    agent.permissions.extend(permissions.iter().cloned());
                    service.agents.push(agent);
                }
                let current = service
                    .agents
                    .iter_mut()
                    .find(|a| &a.id == id)
                    .expect("agent was just inserted");
                let JsonValue::Object(mut encoded) = current.encode() else {
                    unreachable!()
                };
                for name in ["system", "description", "mode", "hidden", "color", "steps"] {
                    if let Some(value) = item.get(&name.into()) {
                        encoded.insert(name.into(), value.clone());
                    }
                }
                if let Some(value) = item.get(&"model".into()) {
                    encoded.insert("model".into(), discovery::selection(value)?.encode());
                }
                if let Some(value) = item.get(&"request".into()) {
                    let request = discovery::object(value)?;
                    for (name, target) in [
                        ("headers", &mut current.request.headers),
                        ("body", &mut current.request.body.0),
                    ] {
                        if let Some(value) = request.get(&name.into()) {
                            for (key, value) in discovery::object(value)?.iter() {
                                target.insert(key.clone(), value.clone());
                            }
                        }
                    }
                }
                encoded.insert("request".into(), current.request.encode());
                if let Some(path) = path.as_ref().filter(|p| p.is_absolute()) {
                    let location = discovery::absolute_path(path)?;
                    let locations = current.locations.get_or_insert_with(Vec::new);
                    if !locations.contains(&location) {
                        locations.push(location);
                    }
                }
                if let Some(value) = item.get(&"permissions".into()) {
                    current.permissions.extend(expand_permissions(
                        Vec::<permission::Rule>::decode(value)?,
                        home,
                    )?);
                }
                if let Some(locations) = &current.locations {
                    encoded.insert("locations".into(), locations.encode());
                }
                encoded.insert("permissions".into(), current.permissions.encode());
                *current = Info::decode(&JsonValue::Object(encoded))?;
            }
        }
        Ok(service)
    }
    pub fn get(&self, id: &Id) -> Option<&Info> {
        self.agents.iter().find(|a| &a.id == id)
    }
    pub fn update(&mut self, id: Id, f: impl FnOnce(&mut Info)) {
        if self.get(&id).is_none() {
            self.agents.push(empty(id.clone()));
        }
        let current = self
            .agents
            .iter_mut()
            .find(|a| a.id == id)
            .expect("agent was just inserted");
        f(current);
        current.id = id;
        self.revision += 1;
        if self
            .event_source
            .emit(crate::event_feed::Data::AgentUpdated(Box::new(
                ycoding_schema::agent::Empty,
            )))
            .is_err()
        {
            eprintln!("Agent event publication failed");
        }
    }
    pub fn set_default(&mut self, id: Option<Id>) {
        self.default = id;
        self.revision += 1;
        if self
            .event_source
            .emit(crate::event_feed::Data::AgentUpdated(Box::new(
                ycoding_schema::agent::Empty,
            )))
            .is_err()
        {
            eprintln!("Agent event publication failed");
        }
    }
    pub fn default_id(&self) -> Option<&Id> {
        self.default.as_ref()
    }
    pub fn remove(&mut self, id: &Id) {
        self.agents.retain(|a| &a.id != id);
        self.revision += 1;
        if self
            .event_source
            .emit(crate::event_feed::Data::AgentUpdated(Box::new(
                ycoding_schema::agent::Empty,
            )))
            .is_err()
        {
            eprintln!("Agent event publication failed");
        }
    }
    pub fn default(&self) -> Option<&Info> {
        self.default
            .as_ref()
            .and_then(|id| self.get(id))
            .filter(|a| is_selectable(a))
            .or_else(|| self.get(&DEFAULT_ID.into()).filter(|a| is_selectable(a)))
            .or_else(|| self.agents.iter().find(|a| is_selectable(a)))
    }
    pub fn resolve(&self, id: Option<&Id>) -> Option<&Info> {
        match id {
            Some(id) => self.get(id),
            None => self.default(),
        }
    }
    pub fn select(&self, id: Option<Id>) -> Selection<'_> {
        if let Some(id) = id {
            let info = self.get(&id);
            return Selection { id, info };
        }
        let info = self.default();
        Selection {
            id: info.map_or_else(|| DEFAULT_ID.into(), |a| a.id.clone()),
            info,
        }
    }
    pub fn list(&self) -> Vec<&Info> {
        let Some(first) = self.default() else {
            return self.agents.iter().collect();
        };
        std::iter::once(first)
            .chain(self.agents.iter().filter(|a| a.id != first.id))
            .collect()
    }
    pub fn revision(&self) -> u64 {
        self.revision
    }
}

fn expand_permissions(
    rules: Vec<permission::Rule>,
    home: &Path,
) -> Result<Vec<permission::Rule>, Error> {
    let home = home
        .to_str()
        .ok_or_else(|| Error::InvalidPath(home.into()))?;
    rules
        .into_iter()
        .map(|mut rule| {
            if ["external_directory", "read", "edit"].contains(&rule.action.as_str().unwrap_or(""))
                && let Some(resource) = rule.resource.as_str()
            {
                rule.resource = if resource == "~" || resource == "$HOME" {
                    LosslessString::from(home)
                } else if resource.starts_with("~/") {
                    format!("{home}{}", &resource[1..]).into()
                } else if resource.starts_with("$HOME/") || resource.starts_with("$HOME\\") {
                    format!("{home}{}", &resource[5..]).into()
                } else {
                    rule.resource
                };
            }
            Ok(rule)
        })
        .collect()
}
