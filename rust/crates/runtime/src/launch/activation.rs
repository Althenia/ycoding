use super::{LaunchError, metadata, source_epoch, write_private};
use std::path::{Path, PathBuf};
use ycoding_core::ycoding_schema::{
    DomainDecode, JsonObject, JsonValue, LosslessString, parse_json, stringify_json,
};
use ycoding_core::ycoding_store::{
    Metadata, Options, Snapshot, Store, TableSpec, artifacts, import, session,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ImportError {
    LegacyMarker,
    InvalidState,
    SourceBusy,
    JournalMode,
    MeetingBusy,
    Resources,
    SourceMissing,
    InterruptedImport,
}

impl std::fmt::Display for ImportError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            Self::LegacyMarker => "This root has an unsupported v1 import marker. It was left unchanged; use a separate empty root or obtain an explicit recovery disposition.",
            Self::InvalidState => "Invalid import selection, checkpoint, or selected store. All existing data was left unchanged.",
            Self::SourceBusy => "stable YCoding is writing; close it and retry",
            Self::JournalMode => "Stable SQLite lacks recoverable on-disk journal evidence. Use a WAL snapshot or a valid file rollback journal; MEMORY/OFF and ambiguous rollback snapshots are refused.",
            Self::MeetingBusy => "Stable Meeting ownership is live or unverifiable; close its owner and retry.",
            Self::Resources => "Import resources are missing, changed, or unsafe; no store was activated.",
            Self::SourceMissing => "The explicit import source is missing. Nothing was changed; restore it to resume the interrupted import.",
            Self::InterruptedImport => "An earlier import was interrupted and no import source was given. Nothing was changed; set the import source again to resume it.",
        })
    }
}
impl std::error::Error for ImportError {}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Phase {
    Copied,
    Imported(import::Progress),
    Sealed,
    ResourcesPublished,
    StorePublished,
    MarkerPublished,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct Resource {
    path: String,
    digest: String,
    bytes: i64,
}

struct Selection {
    id: String,
    kind: import::DatabaseKind,
    metadata: Metadata,
    imported: bool,
    sealed: bool,
    source: String,
    copied: String,
    resources: Vec<Resource>,
}

#[derive(Clone, Debug)]
pub enum ImportSource {
    Default(PathBuf),
    Explicit(PathBuf),
    None,
}

#[derive(Clone, Copy, Debug)]
pub struct Paths<'a> {
    pub file: &'a Path,
    pub marker: &'a Path,
    pub scratch_root: &'a Path,
    pub source_resources: &'a Path,
    pub target_resources: &'a Path,
    pub create_parents: bool,
}

pub(super) fn import_would_run(
    file: &Path,
    marker: &Path,
    kind: import::DatabaseKind,
) -> Result<bool, LaunchError> {
    if marker.try_exists()? {
        if read_selection(marker, kind)?.sealed {
            return Ok(false);
        }
        return Err(invalid());
    }
    let journal = marker.with_extension("stage-v2");
    if !journal.try_exists()? || !file.try_exists()? {
        return Ok(true);
    }
    Ok(!read_selection(&journal, kind)?.sealed)
}

pub(super) fn activate(
    source: &ImportSource,
    paths: Paths<'_>,
    kind: import::DatabaseKind,
    mut progress: impl FnMut(Phase) -> Result<(), LaunchError>,
) -> Result<(), LaunchError> {
    let (file, marker) = (paths.file, paths.marker);
    let journal = marker.with_extension("stage-v2");
    if matches!(source, ImportSource::None) && !marker.try_exists()? && !journal.try_exists()? {
        return Ok(());
    }
    prepare_directory(file.parent().ok_or_else(invalid)?, paths.create_parents)?;
    prepare_directory(marker.parent().ok_or_else(invalid)?, paths.create_parents)?;
    let lease_path = marker.with_extension("import-lock");
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let lease = options.open(lease_path)?;
    lease.try_lock().map_err(|_| invalid())?;
    if marker.try_exists()? {
        let selection = read_selection(marker, kind)?;
        if !selection.sealed {
            return Err(invalid());
        }
        verify_selected(file, &selection)?;
        return remove_staging(file, &selection.id);
    }
    let saved = if journal.try_exists()? {
        Some(read_selection(&journal, kind)?)
    } else {
        None
    };
    if file.try_exists()? {
        let selection = saved.filter(|state| state.sealed).ok_or_else(invalid)?;
        verify_selected(file, &selection)?;
        write_selection(marker, &selection)?;
        remove_staging(file, &selection.id)?;
        progress(Phase::MarkerPublished)?;
        return Ok(());
    }
    let (source, explicit) = match source {
        ImportSource::Default(path) => (path.as_path(), false),
        ImportSource::Explicit(path) => (path.as_path(), true),
        ImportSource::None => return Err(LaunchError::Import(ImportError::InterruptedImport)),
    };
    if explicit && !source.try_exists()? {
        return Err(LaunchError::Import(ImportError::SourceMissing));
    }
    let needs_source = explicit || saved.as_ref().is_none_or(|state| state.imported);
    if needs_source && kind == import::DatabaseKind::Meeting {
        require_idle_meeting(source)?;
    }
    let resources = if needs_source {
        resource_inventory(paths.source_resources, source, kind)?
    } else {
        Vec::new()
    };
    let fingerprint = if needs_source {
        original_fingerprint(source)?
    } else {
        "absent".into()
    };
    let mut selection = match saved {
        Some(state)
            if (!state.imported && !explicit)
                || (state.imported
                    && state.source == fingerprint
                    && state.resources == resources
                    && !state.copied.is_empty()) =>
        {
            state
        }
        _ => Selection {
            id: source_epoch()?,
            kind,
            metadata: metadata()?,
            imported: source.try_exists()?,
            sealed: false,
            source: fingerprint,
            copied: String::new(),
            resources,
        },
    };
    let scratch = paths
        .scratch_root
        .join(format!("stable-import-{}", selection.id));
    let candidate = file.with_file_name(format!(".stable-import-{}.redb", selection.id));
    let copied = scratch.join("source.sqlite");
    private_directory(&scratch)?;
    write_selection(&journal, &selection)?;
    if selection.imported && selection.copied.is_empty() {
        if copied.try_exists()? {
            return Err(invalid());
        }
        import::copy_source(source, &copied).map_err(import_error)?;
        copy_resources(
            paths.source_resources,
            &scratch.join("resources"),
            &selection.resources,
        )?;
        if original_fingerprint(source)? != selection.source
            || resource_inventory(paths.source_resources, source, kind)? != selection.resources
        {
            return Err(LaunchError::Import(ImportError::SourceBusy));
        }
        selection.copied = import::file_fingerprint(&copied).map_err(import_error)?.0;
        write_selection(&journal, &selection)?;
        progress(Phase::Copied)?;
    }
    if selection.imported {
        if import::file_fingerprint(&copied).map_err(import_error)?.0 != selection.copied {
            return Err(invalid());
        }
        let identity = if candidate.try_exists()? {
            import::resume_metadata(&candidate).map_err(import_error)?
        } else {
            selection.metadata.clone()
        };
        if identity != selection.metadata {
            return Err(invalid());
        }
        let mut interrupted = None;
        let staged = import::stage(
            import::Request {
                source: &copied,
                candidate: &candidate,
                kind,
                metadata: identity,
            },
            |phase| match progress(Phase::Imported(phase)) {
                Ok(()) => std::ops::ControlFlow::Continue(()),
                Err(error) => {
                    interrupted = Some(error);
                    std::ops::ControlFlow::Break(())
                }
            },
        );
        if let Some(error) = interrupted {
            return Err(error);
        }
        staged.map_err(import_error)?;
        if import::sealed(&candidate, kind).map_err(import_error)?.0 != selection.metadata {
            return Err(invalid());
        }
        if kind == import::DatabaseKind::Core {
            let store = Store::open(&candidate, Options::core(), import::catalog(kind))
                .map_err(|_| invalid())?;
            let snapshot = store.snapshot().map_err(|_| invalid())?;
            verify_resources(&snapshot, &scratch.join("resources"))?;
            drop(snapshot);
            store.shutdown().map_err(|_| invalid())?;
        }
    } else if !candidate.try_exists()? {
        let store = Store::initialize(
            &candidate,
            store_options(kind),
            import::catalog(kind),
            selection.metadata.clone(),
        )
        .map_err(|_| invalid())?;
        store.shutdown().map_err(|_| invalid())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&candidate, std::fs::Permissions::from_mode(0o600))?;
        }
    }
    if !selection.imported {
        verify_selected(&candidate, &selection)?;
    }
    if selection.imported
        && (original_fingerprint(source)? != selection.source
            || resource_inventory(paths.source_resources, source, kind)? != selection.resources)
    {
        return Err(LaunchError::Import(ImportError::SourceBusy));
    }
    selection.sealed = true;
    write_selection(&journal, &selection)?;
    progress(Phase::Sealed)?;
    copy_resources(
        &scratch.join("resources"),
        paths.target_resources,
        &selection.resources,
    )?;
    progress(Phase::ResourcesPublished)?;
    std::fs::File::open(&candidate)?.sync_all()?;
    std::fs::rename(&candidate, file)?;
    sync_parent(file)?;
    progress(Phase::StorePublished)?;
    verify_selected(file, &selection)?;
    write_selection(marker, &selection)?;
    remove_staging(file, &selection.id)?;
    progress(Phase::MarkerPublished)?;
    Ok(())
}

fn remove_staging(file: &Path, id: &str) -> Result<(), LaunchError> {
    let candidate = file.with_file_name(format!(".stable-import-{id}.redb"));
    if candidate.try_exists()? {
        return Ok(());
    }
    for suffix in [".import-lock", ".import-v1"] {
        let mut name = candidate.as_os_str().to_owned();
        name.push(suffix);
        match std::fs::remove_file(name) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
    }
    Ok(())
}

fn store_options(kind: import::DatabaseKind) -> Options {
    if kind == import::DatabaseKind::Meeting {
        Options::meeting()
    } else {
        Options::core()
    }
}

fn verify_selected(file: &Path, selection: &Selection) -> Result<(), LaunchError> {
    let store = Store::open(
        file,
        store_options(selection.kind),
        import::catalog(selection.kind),
    )
    .map_err(|_| invalid())?;
    if store.metadata() != &selection.metadata {
        return Err(invalid());
    }
    let snapshot = store.snapshot().map_err(|_| invalid())?;
    if selection.imported
        && snapshot
            .get::<import::ProvenanceTable>(&[])
            .map_err(|_| invalid())?
            .is_none_or(|report| report.source_fingerprint != selection.copied)
    {
        return Err(invalid());
    }
    drop(snapshot);
    store.shutdown().map_err(|_| invalid())
}

fn original_fingerprint(source: &Path) -> Result<String, LaunchError> {
    if !source.try_exists()? {
        return Ok("absent".into());
    }
    import::source_fingerprint(source).map_err(import_error)
}

fn resource_inventory(
    root: &Path,
    source: &Path,
    kind: import::DatabaseKind,
) -> Result<Vec<Resource>, LaunchError> {
    if kind != import::DatabaseKind::Core || !source.try_exists()? {
        return Ok(Vec::new());
    }
    let mut files = Vec::new();
    for directory in ["attachments", "project-artifacts"] {
        let path = root.join(directory);
        match std::fs::symlink_metadata(&path) {
            Ok(_) => inventory(root, &path, &mut files)?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => (),
            Err(_) => return Err(LaunchError::Import(ImportError::Resources)),
        }
    }
    files.sort_by(|left, right| left.path.cmp(&right.path));
    Ok(files)
}

fn inventory(root: &Path, path: &Path, files: &mut Vec<Resource>) -> Result<(), LaunchError> {
    let info = std::fs::symlink_metadata(path)?;
    if info.is_symlink() {
        return Err(LaunchError::Import(ImportError::Resources));
    }
    if info.is_dir() {
        for entry in std::fs::read_dir(path)? {
            inventory(root, &entry?.path(), files)?;
        }
        return Ok(());
    }
    if !info.is_file() {
        return Err(LaunchError::Import(ImportError::Resources));
    }
    let (digest, bytes) = import::file_fingerprint(path).map_err(import_error)?;
    files.push(Resource {
        path: path
            .strip_prefix(root)
            .map_err(|_| invalid())?
            .to_str()
            .ok_or_else(invalid)?
            .replace(std::path::MAIN_SEPARATOR, "/"),
        digest,
        bytes,
    });
    Ok(())
}

fn copy_resources(source: &Path, target: &Path, resources: &[Resource]) -> Result<(), LaunchError> {
    for resource in resources {
        let from = source.join(&resource.path);
        let to = target.join(&resource.path);
        let mut current = target.to_path_buf();
        for component in resource.path.split('/') {
            current.push(component);
            match std::fs::symlink_metadata(&current) {
                Ok(info) if info.is_symlink() => {
                    return Err(LaunchError::Import(ImportError::Resources));
                }
                Err(error) if error.kind() != std::io::ErrorKind::NotFound => {
                    return Err(error.into());
                }
                _ => (),
            }
        }
        if import::file_fingerprint(&from).map_err(import_error)?
            != (resource.digest.clone(), resource.bytes)
        {
            return Err(LaunchError::Import(ImportError::Resources));
        }
        if std::fs::symlink_metadata(&to).is_ok() {
            if import::file_fingerprint(&to).map_err(import_error)?
                != (resource.digest.clone(), resource.bytes)
            {
                return Err(LaunchError::Import(ImportError::Resources));
            }
            continue;
        }
        private_directory(to.parent().ok_or_else(invalid)?)?;
        let temporary = to.with_extension(format!("import-{}", source_epoch()?));
        let mut input = std::fs::File::open(&from)?;
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut output = options.open(&temporary)?;
        std::io::copy(&mut input, &mut output)?;
        output.sync_all()?;
        drop(output);
        if import::file_fingerprint(&temporary).map_err(import_error)?
            != (resource.digest.clone(), resource.bytes)
        {
            return Err(LaunchError::Import(ImportError::Resources));
        }
        std::fs::hard_link(&temporary, &to)?;
        std::fs::remove_file(temporary)?;
        sync_parent(&to)?;
    }
    Ok(())
}

fn verify_resources(snapshot: &Snapshot, root: &Path) -> Result<(), LaunchError> {
    let attachments = ycoding_core::resources::attachment_store::Store::new(root.to_path_buf())
        .map_err(|_| resource_error())?;
    walk::<session::MessageTable>(snapshot, |row| {
        if row.type_.as_str() == Some("user") {
            verify_attachments(&row.data, &attachments)?;
        }
        Ok(())
    })?;
    walk::<session::PendingTable>(snapshot, |row| {
        if row.type_.as_str() == Some("user") {
            verify_attachments(&row.data, &attachments)?;
        }
        Ok(())
    })?;
    walk::<session::EventTable>(snapshot, |row| {
        if row.type_.as_str() == Some("session.input.admitted.1") {
            let value = object_value(&row.data)?;
            if let Some(JsonValue::Object(input)) = value.get(&"input".into())
                && input.get(&"type".into()) == Some(&JsonValue::String("user".into()))
            {
                verify_attachments(
                    input.get(&"data".into()).ok_or_else(resource_error)?,
                    &attachments,
                )?;
            }
        }
        Ok(())
    })?;
    walk::<artifacts::VersionTable>(snapshot, |row| {
        let scope = snapshot
            .get::<artifacts::ScopeTable>(&ycoding_core::ycoding_store::tuple_key(&[
                ycoding_core::ycoding_store::KeyPart::String(&row.scope_id),
            ]))
            .map_err(|_| resource_error())?
            .ok_or_else(resource_error)?;
        let storage = scope.storage_id.as_str().ok_or_else(resource_error)?;
        let relative = row.content_relpath.as_str().ok_or_else(resource_error)?;
        if storage.contains(['/', '\\']) || matches!(storage, "" | "." | "..") {
            return Err(resource_error());
        }
        let path = root.join("project-artifacts").join(storage).join(relative);
        if import::file_fingerprint(&path)
            .map_err(|_| resource_error())?
            .0
            != row.content_digest.as_str().ok_or_else(resource_error)?
        {
            return Err(resource_error());
        }
        Ok(())
    })
}

fn walk<T: TableSpec>(
    snapshot: &Snapshot,
    mut consume: impl FnMut(T::Record) -> Result<(), LaunchError>,
) -> Result<(), LaunchError> {
    let mut after = None;
    loop {
        let rows = snapshot
            .scan::<T>(
                after
                    .as_deref()
                    .map_or(std::ops::Bound::Unbounded, std::ops::Bound::Excluded),
                std::ops::Bound::Unbounded,
                128,
            )
            .map_err(|_| resource_error())?;
        if rows.is_empty() {
            return Ok(());
        }
        after = rows.last().map(T::primary_key);
        for row in rows {
            consume(row)?;
        }
    }
}

fn object_value(value: &JsonValue) -> Result<JsonObject, LaunchError> {
    match value {
        JsonValue::Object(object) => Ok(object.clone()),
        JsonValue::String(text) => match parse_json(text.as_str().ok_or_else(resource_error)?)
            .map_err(|_| resource_error())?
        {
            JsonValue::Object(object) => Ok(object),
            _ => Err(resource_error()),
        },
        _ => Err(resource_error()),
    }
}

fn verify_attachments(
    value: &JsonValue,
    store: &ycoding_core::resources::attachment_store::Store,
) -> Result<(), LaunchError> {
    let object = object_value(value)?;
    let Some(files) = object.get(&"files".into()) else {
        return Ok(());
    };
    let JsonValue::Array(files) = files else {
        return Err(resource_error());
    };
    for file in files {
        let JsonValue::Object(file) = file else {
            return Err(resource_error());
        };
        if let Some(content) = file.get(&"content".into()) {
            let content =
                ycoding_core::ycoding_schema::prompt::ManagedAttachmentContent::decode(content)
                    .map_err(|_| resource_error())?;
            store.read(&content).map_err(|_| resource_error())?;
        }
    }
    Ok(())
}

fn resource_error() -> LaunchError {
    LaunchError::Import(ImportError::Resources)
}

fn require_idle_meeting(source: &Path) -> Result<(), LaunchError> {
    let lock = source.parent().ok_or_else(invalid)?.join("runtime.lock");
    match std::fs::symlink_metadata(&lock) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Ok(info) if info.is_file() && info.len() <= 4096 => (),
        _ => return Err(LaunchError::Import(ImportError::MeetingBusy)),
    }
    let value = parse_json(&std::fs::read_to_string(lock)?)
        .map_err(|_| LaunchError::Import(ImportError::MeetingBusy))?;
    let pid = match value {
        JsonValue::Object(object) => match object.get(&"pid".into()) {
            Some(JsonValue::Number(pid))
                if *pid >= 1.0 && *pid <= i32::MAX as f64 && pid.fract() == 0.0 =>
            {
                *pid as u32
            }
            _ => return Err(LaunchError::Import(ImportError::MeetingBusy)),
        },
        _ => return Err(LaunchError::Import(ImportError::MeetingBusy)),
    };
    match ycoding_core::platform::process::is_alive(pid) {
        Ok(false) => Ok(()),
        _ => Err(LaunchError::Import(ImportError::MeetingBusy)),
    }
}

fn read_selection(path: &Path, kind: import::DatabaseKind) -> Result<Selection, LaunchError> {
    let info = std::fs::symlink_metadata(path)?;
    if !info.is_file() || info.len() > 8 * 1024 * 1024 {
        return Err(invalid());
    }
    let JsonValue::Object(object) =
        parse_json(&std::fs::read_to_string(path)?).map_err(|_| invalid())?
    else {
        return Err(invalid());
    };
    if object.get(&"version".into()) == Some(&JsonValue::Number(1.0)) {
        return Err(LaunchError::Import(ImportError::LegacyMarker));
    }
    if object.len() != 10 || object.get(&"version".into()) != Some(&JsonValue::Number(2.0)) {
        return Err(invalid());
    }
    let id = string(&object, "id")?;
    if id.len() != 36
        || id
            .bytes()
            .any(|byte| !byte.is_ascii_hexdigit() && byte != b'-')
    {
        return Err(invalid());
    }
    if string(&object, "kind")? != kind_name(kind) {
        return Err(invalid());
    }
    let identity = string(&object, "identity")?;
    if identity.len() != 32 || !identity.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(invalid());
    }
    let mut bytes = [0; 16];
    for (index, byte) in bytes.iter_mut().enumerate() {
        *byte =
            u8::from_str_radix(&identity[index * 2..index * 2 + 2], 16).map_err(|_| invalid())?;
    }
    let generation = string(&object, "generation")?
        .parse::<u64>()
        .map_err(|_| invalid())?;
    if bytes == [0; 16] || generation == 0 {
        return Err(invalid());
    }
    let Some(JsonValue::Array(values)) = object.get(&"resources".into()) else {
        return Err(invalid());
    };
    let mut resources = Vec::new();
    for value in values {
        let JsonValue::Object(value) = value else {
            return Err(invalid());
        };
        if value.len() != 3 {
            return Err(invalid());
        }
        let path = string(value, "path")?;
        let components = path.split('/').collect::<Vec<_>>();
        if !matches!(
            components.first(),
            Some(&"attachments" | &"project-artifacts")
        ) || components.iter().any(|value| {
            value.is_empty() || *value == "." || *value == ".." || value.contains('\\')
        }) {
            return Err(invalid());
        }
        let digest = string(value, "digest")?;
        if digest.len() != 64
            || !digest
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        {
            return Err(invalid());
        }
        let bytes = string(value, "bytes")?
            .parse::<i64>()
            .map_err(|_| invalid())?;
        if bytes < 0
            || resources
                .iter()
                .any(|resource: &Resource| resource.path == path)
        {
            return Err(invalid());
        }
        resources.push(Resource {
            path,
            digest,
            bytes,
        });
    }
    let imported = boolean(&object, "imported")?;
    let sealed = boolean(&object, "sealed")?;
    let source = string(&object, "source")?;
    let copied = string(&object, "copied")?;
    let hash = |value: &str| {
        value.len() == 64
            && value
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    };
    if (imported
        && (!hash(&source)
            || (!copied.is_empty() && !hash(&copied))
            || (sealed && copied.is_empty())))
        || (!imported && (source != "absent" || !copied.is_empty() || !resources.is_empty()))
        || (kind != import::DatabaseKind::Core && !resources.is_empty())
    {
        return Err(invalid());
    }
    Ok(Selection {
        id,
        kind,
        metadata: Metadata::new(bytes, generation),
        imported,
        sealed,
        source,
        copied,
        resources,
    })
}

fn write_selection(path: &Path, selection: &Selection) -> Result<(), LaunchError> {
    let mut object = JsonObject::new();
    object.insert("version".into(), JsonValue::Number(2.0));
    for (key, value) in [
        ("id", selection.id.clone()),
        ("kind", kind_name(selection.kind).into()),
        (
            "identity",
            selection
                .metadata
                .database_identity
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect(),
        ),
        ("generation", selection.metadata.generation.to_string()),
        ("source", selection.source.clone()),
        ("copied", selection.copied.clone()),
    ] {
        object.insert(key.into(), JsonValue::String(value.into()));
    }
    object.insert("imported".into(), JsonValue::Bool(selection.imported));
    object.insert("sealed".into(), JsonValue::Bool(selection.sealed));
    object.insert(
        "resources".into(),
        JsonValue::Array(
            selection
                .resources
                .iter()
                .map(|resource| {
                    let mut value = JsonObject::new();
                    for (key, text) in [
                        ("path", resource.path.clone()),
                        ("digest", resource.digest.clone()),
                        ("bytes", resource.bytes.to_string()),
                    ] {
                        value.insert(key.into(), JsonValue::String(text.into()));
                    }
                    JsonValue::Object(value)
                })
                .collect(),
        ),
    );
    let encoded = stringify_json(&JsonValue::Object(object));
    if encoded.len() > 8 * 1024 * 1024 {
        return Err(invalid());
    }
    write_private(path, encoded.as_bytes()).map_err(LaunchError::from)
}

fn kind_name(kind: import::DatabaseKind) -> &'static str {
    match kind {
        import::DatabaseKind::Core => "core",
        import::DatabaseKind::Bootstrap => "bootstrap",
        import::DatabaseKind::Meeting => "meeting",
    }
}
fn string(object: &JsonObject, key: &str) -> Result<String, LaunchError> {
    match object.get(&LosslessString::from(key)) {
        Some(JsonValue::String(value)) => value.to_utf8().map_err(|_| invalid()),
        _ => Err(invalid()),
    }
}
fn boolean(object: &JsonObject, key: &str) -> Result<bool, LaunchError> {
    match object.get(&LosslessString::from(key)) {
        Some(JsonValue::Bool(value)) => Ok(*value),
        _ => Err(invalid()),
    }
}
fn prepare_directory(path: &Path, create: bool) -> Result<(), LaunchError> {
    if create {
        return private_directory(path);
    }
    match std::fs::symlink_metadata(path) {
        Ok(info) if info.is_dir() => Ok(()),
        _ => Err(invalid()),
    }
}

fn private_directory(path: &Path) -> Result<(), LaunchError> {
    match std::fs::symlink_metadata(path) {
        Ok(info) if info.is_dir() && !info.is_symlink() => (),
        Ok(_) => return Err(invalid()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            if let Some(parent) = path.parent()
                && !parent.try_exists()?
            {
                private_directory(parent)?;
            }
            std::fs::create_dir(path)?;
        }
        Err(error) => return Err(error.into()),
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))?;
        std::fs::File::open(path)?.sync_all()?;
    }
    sync_parent(path)
}
fn sync_parent(path: &Path) -> Result<(), LaunchError> {
    #[cfg(unix)]
    std::fs::File::open(path.parent().ok_or_else(invalid)?)?.sync_all()?;
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}
fn invalid() -> LaunchError {
    LaunchError::Import(ImportError::InvalidState)
}
fn import_error(error: import::Error) -> LaunchError {
    LaunchError::Import(match error {
        import::Error::SourceBusy | import::Error::SourceChanged => ImportError::SourceBusy,
        import::Error::JournalMode => ImportError::JournalMode,
        _ => ImportError::InvalidState,
    })
}

#[cfg(test)]
mod tests;
