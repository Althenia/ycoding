use super::{
    Component, Edit, Error, Harness, Item, Op, Origin, Pending, Version, VersionId, Versions, rules,
};
use serde_json::{Map, Value, json};
use std::{
    fs, io,
    path::{Path, PathBuf},
    sync::Mutex,
};

const CURRENT: &str = "current";
const VERSIONS: &str = "versions";

pub struct FileVersions {
    directory: PathBuf,
    guard: Mutex<()>,
}

impl FileVersions {
    pub fn new(directory: impl Into<PathBuf>) -> Self {
        Self {
            directory: directory.into(),
            guard: Mutex::new(()),
        }
    }

    fn current_id(&self) -> Result<VersionId, Error> {
        match fs::read_to_string(self.directory.join(CURRENT)) {
            Ok(text) => valid(text.trim()).map(|id| VersionId(id.to_owned())),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(rules::genesis().id),
            Err(error) => Err(unavailable(error)),
        }
    }

    fn load(&self, id: &VersionId) -> Result<Option<Version>, Error> {
        if *id == rules::genesis().id {
            return Ok(Some(rules::genesis()));
        }
        let id = valid(&id.0)?;
        match fs::read_to_string(self.directory.join(VERSIONS).join(format!("{id}.json"))) {
            Ok(text) => decode(&text).map(Some),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(unavailable(error)),
        }
    }

    fn head(&self) -> Result<Version, Error> {
        let _guard = self.guard.lock().map_err(poisoned)?;
        let id = self.current_id()?;
        self.load(&id)?
            .ok_or_else(|| Error::Invalid(format!("current version {} is missing", id.0)))
    }

    fn advance(&self, version: Version, expected: &VersionId) -> Result<(), Error> {
        let _guard = self.guard.lock().map_err(poisoned)?;
        valid(&version.id.0)?;
        let current = self.current_id()?;
        if current != *expected {
            return Err(Error::Conflict(format!(
                "current version is {}, not {}",
                current.0, expected.0
            )));
        }
        match self.load(&version.id)? {
            Some(stored) if stored == version => {}
            Some(_) => {
                return Err(Error::Invalid(format!(
                    "version {} already exists with different content",
                    version.id.0
                )));
            }
            None => {
                if version.parent.as_ref() != Some(expected)
                    || version.id != rules::identify(version.parent.as_ref(), &version.harness)
                {
                    return Err(Error::Invalid(format!(
                        "version {} is not a content-addressed child of {}",
                        version.id.0, expected.0
                    )));
                }
                write(
                    &self
                        .directory
                        .join(VERSIONS)
                        .join(format!("{}.json", version.id.0)),
                    &encode(&version),
                )?;
            }
        }
        write(&self.directory.join(CURRENT), &version.id.0)
    }
}

impl Versions for FileVersions {
    fn current(&self) -> Pending<'_, Version> {
        Box::pin(async move { self.head() })
    }

    fn get(&self, id: &VersionId) -> Pending<'_, Option<Version>> {
        let id = id.clone();
        Box::pin(async move {
            let _guard = self.guard.lock().map_err(poisoned)?;
            self.load(&id)
        })
    }

    fn publish(&self, version: Version, expected: &VersionId) -> Pending<'_, ()> {
        let expected = expected.clone();
        Box::pin(async move { self.advance(version, &expected) })
    }
}

fn valid(id: &str) -> Result<&str, Error> {
    let digits = id.strip_prefix("hv_").unwrap_or_default();
    if digits.len() == 32 && digits.bytes().all(|b| b.is_ascii_hexdigit()) {
        Ok(id)
    } else {
        Err(Error::Invalid(format!("malformed version id {id:?}")))
    }
}

fn unavailable(error: io::Error) -> Error {
    Error::Unavailable(error.to_string())
}

fn poisoned<T>(_: std::sync::PoisonError<T>) -> Error {
    Error::Unavailable("version store lock poisoned".into())
}

fn write(path: &Path, text: &str) -> Result<(), Error> {
    let parent = path
        .parent()
        .ok_or_else(|| Error::Unavailable("version store path has no parent".into()))?;
    fs::create_dir_all(parent).map_err(unavailable)?;
    let staging = path.with_extension("tmp");
    fs::write(&staging, text).map_err(unavailable)?;
    fs::rename(&staging, path).map_err(unavailable)
}

fn origin(origin: Origin) -> &'static str {
    match origin {
        Origin::General => "general",
        Origin::Domain => "domain",
    }
}

pub fn encode(version: &Version) -> String {
    let harness = version
        .harness
        .items
        .iter()
        .map(|(component, items)| {
            (
                component.as_str().to_owned(),
                Value::Array(
                    items
                        .iter()
                        .map(|item| json!({"key": item.key, "content": item.content}))
                        .collect(),
                ),
            )
        })
        .collect::<Map<_, _>>();
    let edits = version.edits.iter().map(|edit| {
        let mut value = json!({
            "component": edit.component.as_str(),
            "key": edit.key,
            "origin": origin(edit.origin),
            "rationale": edit.rationale,
        });
        match &edit.op {
            Op::Set(content) => {
                value["op"] = "set".into();
                value["content"] = content.clone().into();
            }
            Op::Remove => value["op"] = "remove".into(),
        }
        value
    });
    json!({
        "id": version.id.0,
        "parent": version.parent.as_ref().map(|parent| parent.0.clone()),
        "created_at": version.created_at,
        "task": version.task,
        "harness": harness,
        "edits": edits.collect::<Vec<_>>(),
    })
    .to_string()
}

pub fn decode(text: &str) -> Result<Version, Error> {
    let invalid = |what: &str| Error::Invalid(format!("stored version: {what}"));
    let root: Value = serde_json::from_str(text).map_err(|_| invalid("not JSON"))?;
    let string = |value: &Value, key: &str| -> Result<String, Error> {
        value
            .get(key)
            .and_then(Value::as_str)
            .map(str::to_owned)
            .ok_or_else(|| invalid(key))
    };
    let component = |name: &str| {
        Component::ALL
            .into_iter()
            .find(|component| component.as_str() == name)
            .ok_or_else(|| invalid("component"))
    };
    let mut harness = Harness::default();
    for (name, items) in root
        .get("harness")
        .and_then(Value::as_object)
        .ok_or_else(|| invalid("harness"))?
    {
        let items = items.as_array().ok_or_else(|| invalid("items"))?;
        harness.items.insert(
            component(name)?,
            items
                .iter()
                .map(|item| {
                    Ok(Item {
                        key: string(item, "key")?,
                        content: string(item, "content")?,
                    })
                })
                .collect::<Result<_, Error>>()?,
        );
    }
    let edits = root
        .get("edits")
        .and_then(Value::as_array)
        .ok_or_else(|| invalid("edits"))?
        .iter()
        .map(|edit| {
            Ok(Edit {
                component: component(&string(edit, "component")?)?,
                key: string(edit, "key")?,
                op: match string(edit, "op")?.as_str() {
                    "set" => Op::Set(string(edit, "content")?),
                    "remove" => Op::Remove,
                    _ => return Err(invalid("op")),
                },
                origin: match string(edit, "origin")?.as_str() {
                    "general" => Origin::General,
                    "domain" => Origin::Domain,
                    _ => return Err(invalid("origin")),
                },
                rationale: string(edit, "rationale")?,
            })
        })
        .collect::<Result<_, Error>>()?;
    Ok(Version {
        id: VersionId(string(&root, "id")?),
        parent: root
            .get("parent")
            .and_then(Value::as_str)
            .map(|parent| VersionId(parent.to_owned())),
        harness: rules::canonical(harness),
        edits,
        created_at: root
            .get("created_at")
            .and_then(Value::as_i64)
            .ok_or_else(|| invalid("created_at"))?,
        task: root.get("task").and_then(Value::as_str).map(str::to_owned),
    })
}
