use super::{provider, request::Image};
use crate::{
    Error,
    llm::{Media, MediaData, Message, Part, Role, ToolResultValue},
    media,
};
use std::{
    collections::{BTreeMap, VecDeque},
    future::Future,
    path::{Component, Path, PathBuf},
    pin::Pin,
    sync::Mutex,
};
use ycoding_schema::{LosslessString, llm::ToolContent};

pub const MAX_INPUT_BYTES: usize = 20 * 1024 * 1024;
pub const MAX_STAGED_BYTES: usize = 50 * 1024 * 1024;

pub(crate) fn size_refusal(bytes: usize) -> Option<String> {
    (bytes > MAX_STAGED_BYTES).then(|| {
        format!("Generated image is {bytes} bytes, above the {MAX_STAGED_BYTES} byte limit")
    })
}
pub const STAGED_TTL_MS: u64 = 600_000;
pub const SAVE_TOOL: &str = "cursor_image_save";
pub const PERMISSION_DENIED: &str = "CursorImagePermissionDenied:";
#[derive(Clone, Debug)]
pub struct Environment {
    pub project_dir: PathBuf,
    pub workspace: PathBuf,
    pub directory: PathBuf,
}
#[derive(Clone, Debug)]
pub struct PathObservation {
    pub target: PathBuf,
    pub project_root: PathBuf,
    pub workspace_root: PathBuf,
    pub directory_root: PathBuf,
}
#[derive(Clone, Debug)]
pub struct ResolvedImage {
    pub data: Vec<u8>,
    pub mime: Option<String>,
    pub filename: Option<String>,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PermissionKind {
    ExternalDirectory,
    Edit,
}
#[derive(Clone, Debug)]
pub enum PermissionDecision {
    Approved,
    Denied(String),
}
#[derive(Debug)]
pub struct Permission {
    pub kind: PermissionKind,
    pub path: PathBuf,
    pub pattern: String,
    pub always: Vec<String>,
    pub session_id: LosslessString,
    pub mime: LosslessString,
    pub bytes: usize,
}
pub struct ApprovedWrite {
    path: PathBuf,
    data: Vec<u8>,
}
impl ApprovedWrite {
    pub fn path(&self) -> &Path {
        &self.path
    }
    pub fn data(&self) -> &[u8] {
        &self.data
    }
}
pub trait Host: Send + Sync {
    fn resolve_image<'a>(
        &'a self,
        source: &'a str,
        limit: usize,
    ) -> Pin<Box<dyn Future<Output = Result<ResolvedImage, Error>> + Send + 'a>>;
    fn observe_path<'a>(
        &'a self,
        target: &'a Path,
        environment: &'a Environment,
    ) -> Pin<Box<dyn Future<Output = Result<PathObservation, Error>> + Send + 'a>>;
    fn permission<'a>(
        &'a self,
        request: &'a Permission,
    ) -> Pin<Box<dyn Future<Output = Result<PermissionDecision, Error>> + Send + 'a>>;
    fn write_image<'a>(
        &'a self,
        approved: ApprovedWrite,
    ) -> Pin<Box<dyn Future<Output = Result<(), Error>> + Send + 'a>>;
}
pub struct StagedImage {
    pub path: PathBuf,
    pub environment: Environment,
    pub mime: LosslessString,
    pub data: Vec<u8>,
    pub session_id: LosslessString,
}
#[derive(Clone, Debug)]
pub struct SaveReceipt {
    pub path: PathBuf,
    pub bytes: usize,
}
struct Entry {
    id: LosslessString,
    image: StagedImage,
    created: u64,
}
struct State {
    pending: VecDeque<Entry>,
    receipts: BTreeMap<LosslessString, (u64, SaveReceipt)>,
}
pub struct Stage {
    state: Mutex<State>,
}
impl Default for Stage {
    fn default() -> Self {
        Self::new()
    }
}
impl Stage {
    pub fn new() -> Self {
        Self {
            state: Mutex::new(State {
                pending: VecDeque::new(),
                receipts: BTreeMap::new(),
            }),
        }
    }
    pub fn stage(&self, image: StagedImage, now: u64) -> Result<LosslessString, Error> {
        if let Some(message) = size_refusal(image.data.len()) {
            return Err(Error::invalid(message));
        }
        let mut state = self
            .state
            .lock()
            .map_err(|_| Error::transport("Cursor image staging lock failed", "client"))?;
        state
            .pending
            .retain(|entry| now.saturating_sub(entry.created) <= STAGED_TTL_MS);
        state
            .receipts
            .retain(|_, (created, _)| now.saturating_sub(*created) <= STAGED_TTL_MS);
        while state.pending.len() >= 8 {
            state.pending.pop_front();
        }
        let id: LosslessString = format!(
            "cursor-image-{}",
            provider::uuid()?
                .to_utf8()
                .map_err(|_| Error::invalid("Cursor image identity is invalid"))?
        )
        .into();
        state.pending.push_back(Entry {
            id: id.clone(),
            image,
            created: now,
        });
        Ok(id)
    }
    pub fn discard(&self, id: &LosslessString) -> Result<(), Error> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| Error::transport("Cursor image staging lock failed", "client"))?;
        state.pending.retain(|entry| &entry.id != id);
        state.receipts.remove(id);
        Ok(())
    }
    pub fn receipt(&self, id: &LosslessString, now: u64) -> Result<Option<SaveReceipt>, Error> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| Error::transport("Cursor image staging lock failed", "client"))?;
        Ok(state
            .receipts
            .remove(id)
            .filter(|(created, _)| now.saturating_sub(*created) <= STAGED_TTL_MS)
            .map(|(_, receipt)| receipt))
    }
    pub async fn save(
        &self,
        id: &LosslessString,
        host: &dyn Host,
        now: u64,
    ) -> Result<SaveReceipt, Error> {
        let entry = {
            let mut state = self
                .state
                .lock()
                .map_err(|_| Error::transport("Cursor image staging lock failed", "client"))?;
            let index = state.pending.iter().position(|entry| &entry.id == id).ok_or_else(|| Error::invalid("No pending Cursor image matches that id. It may have already been saved or expired."))?;
            state
                .pending
                .remove(index)
                .ok_or_else(|| Error::output("Cursor staged image disappeared"))?
        };
        if now.saturating_sub(entry.created) > STAGED_TTL_MS {
            return Err(Error::invalid(
                "No pending Cursor image matches that id. It may have already been saved or expired.",
            ));
        }
        let observation = host
            .observe_path(&entry.image.path, &entry.image.environment)
            .await?;
        if !observation.target.is_absolute()
            || ![&observation.project_root, &observation.workspace_root]
                .iter()
                .any(|root| root.is_absolute() && inside(root, &observation.target))
        {
            return Err(Error::invalid(
                "Refusing to save the generated image: target path resolves outside the workspace and project folder.",
            ));
        }
        let bytes = entry.image.data.len();
        let external = ![&observation.workspace_root, &observation.directory_root]
            .iter()
            .any(|root| {
                root.as_path() != Path::new("/")
                    && (observation.target == **root || inside(root, &observation.target))
            });
        let parent = observation
            .target
            .parent()
            .ok_or_else(|| Error::invalid("Cursor image target has no parent directory"))?;
        let edit_pattern = relative(&observation.workspace_root, &observation.target)?;
        for kind in [
            external.then_some(PermissionKind::ExternalDirectory),
            Some(PermissionKind::Edit),
        ]
        .into_iter()
        .flatten()
        {
            let request = Permission {
                kind,
                path: observation.target.clone(),
                pattern: if kind == PermissionKind::ExternalDirectory {
                    parent.join("*").to_string_lossy().replace('\\', "/")
                } else {
                    edit_pattern.clone()
                },
                always: if kind == PermissionKind::ExternalDirectory {
                    vec![parent.join("*").to_string_lossy().replace('\\', "/")]
                } else {
                    vec!["*".into()]
                },
                session_id: entry.image.session_id.clone(),
                mime: entry.image.mime.clone(),
                bytes,
            };
            match host.permission(&request).await {
                Ok(PermissionDecision::Approved) => {}
                Ok(PermissionDecision::Denied(reason)) => {
                    return Err(Error::invalid(format!("{PERMISSION_DENIED} {reason}")));
                }
                Err(error) => {
                    return Err(Error::invalid(format!(
                        "{PERMISSION_DENIED} {}",
                        error.message
                    )));
                }
            }
        }
        let receipt = SaveReceipt {
            path: observation.target.clone(),
            bytes,
        };
        host.write_image(ApprovedWrite {
            path: observation.target,
            data: entry.image.data,
        })
        .await?;
        self.state
            .lock()
            .map_err(|_| Error::transport("Cursor image staging lock failed", "client"))?
            .receipts
            .insert(id.clone(), (now, receipt.clone()));
        Ok(receipt)
    }
}

pub(crate) fn validate_user(messages: &[Message], supports: bool) -> Result<(), Error> {
    if let Some(user) = messages
        .iter()
        .rev()
        .find(|message| message.role == Role::User)
    {
        for part in &user.content {
            if let Part::Media(media) = part {
                if !media
                    .mime
                    .as_str()
                    .is_some_and(|mime| mime.starts_with("image/"))
                {
                    return Err(Error::invalid("Cursor supports image attachments only"));
                }
                if !supports {
                    return Err(Error::invalid("Cursor model does not support image input"));
                }
                if let MediaData::Bytes(bytes) = &media.data
                    && bytes.len() > MAX_INPUT_BYTES
                {
                    return Err(Error::invalid(
                        "Cursor image attachments exceed the 20 MiB limit",
                    ));
                }
            }
        }
    }
    Ok(())
}
pub(crate) async fn extract(
    messages: &[Message],
    supports: bool,
    seen: &VecDeque<[u8; 32]>,
    host: Option<&dyn Host>,
) -> Result<(Vec<Image>, Vec<[u8; 32]>), Error> {
    validate_user(messages, supports)?;
    let newest = messages
        .iter()
        .rposition(|message| message.role == Role::User);
    let mut images = Vec::new();
    let mut hashes = Vec::new();
    let mut this_step = Vec::new();
    let mut total = 0;
    if let Some(index) = newest {
        for part in &messages[index].content {
            if let Part::Media(media) = part {
                let image = decode(media, MAX_INPUT_BYTES - total, images.len() + 1, host).await?;
                total += image.data.len();
                this_step.push(hash(&image.data));
                images.push(image);
            }
        }
    }
    if !supports {
        return Ok((images, hashes));
    }
    for (index, message) in messages.iter().enumerate() {
        if Some(index) == newest {
            continue;
        }
        for part in &message.content {
            let candidates = match part {
                Part::Media(media) if matches!(message.role, Role::User | Role::Assistant) => {
                    vec![media.clone()]
                }
                Part::ToolResult(result) if message.role == Role::Tool => match &result.result {
                    ToolResultValue::Content(content) => content
                        .iter()
                        .filter_map(|content| {
                            if let ToolContent::File(file) = content {
                                Some(Media {
                                    mime: file.mime.clone(),
                                    data: MediaData::Encoded(file.uri.clone()),
                                    filename: file.name.clone(),
                                })
                            } else {
                                None
                            }
                        })
                        .collect(),
                    _ => Vec::new(),
                },
                _ => Vec::new(),
            };
            for media in candidates.into_iter().filter(|media| {
                media
                    .mime
                    .as_str()
                    .is_some_and(|mime| mime.starts_with("image/"))
            }) {
                let image = decode(&media, MAX_INPUT_BYTES, images.len() + 1, host).await?;
                let fingerprint = hash(&image.data);
                if seen.contains(&fingerprint) || this_step.contains(&fingerprint) {
                    continue;
                }
                if image.data.len() > MAX_INPUT_BYTES - total {
                    return Err(Error::invalid(
                        "Cursor image attachments exceed the 20 MiB limit",
                    ));
                }
                total += image.data.len();
                hashes.push(fingerprint);
                this_step.push(fingerprint);
                images.push(image);
            }
        }
    }
    Ok((images, hashes))
}
async fn decode(
    part: &Media,
    limit: usize,
    index: usize,
    host: Option<&dyn Host>,
) -> Result<Image, Error> {
    let resolved = match &part.data {
        MediaData::Bytes(bytes) => ResolvedImage {
            data: bytes.clone(),
            mime: None,
            filename: None,
        },
        MediaData::Encoded(value) => {
            let value = value
                .as_str()
                .ok_or_else(|| Error::invalid("Cursor image data must be Unicode text"))?;
            if let Some(data) = value.strip_prefix("data:") {
                let (metadata, body) = data.split_once(',').ok_or_else(|| {
                    Error::invalid("Cursor image data URL must be base64 encoded")
                })?;
                let metadata = metadata.strip_suffix(";base64").ok_or_else(|| {
                    Error::invalid("Cursor image data URL must be base64 encoded")
                })?;
                ResolvedImage {
                    data: base64(body)?,
                    mime: metadata
                        .split(';')
                        .next()
                        .filter(|mime| !mime.is_empty())
                        .map(str::to_owned),
                    filename: None,
                }
            } else if value.starts_with("http://")
                || value.starts_with("https://")
                || value.starts_with("file:")
            {
                host.ok_or_else(|| {
                    Error::invalid("Cursor URL images require the Location-owned image resolver")
                })?
                .resolve_image(value, limit)
                .await?
            } else {
                ResolvedImage {
                    data: base64(value)?,
                    mime: None,
                    filename: None,
                }
            }
        }
    };
    if resolved.data.len() > limit {
        return Err(Error::invalid(
            "Cursor image attachments exceed the 20 MiB limit",
        ));
    }
    let declared = part
        .mime
        .as_str()
        .ok_or_else(|| Error::invalid("Cursor image media type is invalid"))?;
    let mime = if declared == "image/*" {
        resolved
            .mime
            .as_deref()
            .filter(|mime| mime.starts_with("image/"))
            .or_else(|| infer(&resolved.data))
            .ok_or_else(|| Error::invalid("Cursor could not determine the image media type"))?
    } else {
        declared
    };
    if !mime.starts_with("image/") || mime == "image/*" {
        return Err(Error::invalid(
            "Cursor could not determine the image media type",
        ));
    }
    let filename = part
        .filename
        .as_ref()
        .filter(|name| !name.is_empty())
        .map(|name| basename(name.as_str().unwrap_or("")))
        .or(resolved.filename)
        .unwrap_or_else(|| format!("image-{index}"));
    Ok(Image {
        uuid: provider::uuid()?,
        filename: Some(filename.into()),
        mime_type: mime.into(),
        data: resolved.data,
    })
}
pub(crate) fn base64(value: &str) -> Result<Vec<u8>, Error> {
    let mut value = value
        .chars()
        .filter(|ch| !ch.is_whitespace() && *ch != '\u{feff}')
        .map(|ch| match ch {
            '-' => '+',
            '_' => '/',
            _ => ch,
        })
        .collect::<String>();
    let padding = value.bytes().rev().take_while(|byte| *byte == b'=').count();
    if padding > 2
        || value[..value.len() - padding]
            .bytes()
            .any(|byte| !byte.is_ascii_alphanumeric() && byte != b'+' && byte != b'/')
    {
        return Err(Error::invalid("Cursor received invalid base64 image data"));
    }
    while !value.len().is_multiple_of(4) {
        value.push('=');
    }
    let data = media::decode(&value)
        .map_err(|_| Error::invalid("Cursor received invalid base64 image data"))?;
    if data.is_empty() {
        return Err(Error::invalid("Cursor received an empty image"));
    }
    Ok(data)
}
pub(crate) fn map_target(target: &str, environment: &Environment) -> Result<PathBuf, Error> {
    if !environment.project_dir.is_absolute()
        || !environment.workspace.is_absolute()
        || !environment.directory.is_absolute()
    {
        return Err(Error::invalid(
            "Cursor image environment requires explicit absolute roots",
        ));
    }
    let fallback = normalize(
        &environment
            .project_dir
            .join("assets")
            .join(if target.is_empty() {
                "generated-image.png".into()
            } else {
                basename(target)
            }),
    );
    if target.is_empty() {
        return Ok(fallback);
    }
    let target = Path::new(target);
    let target = normalize(&if target.is_absolute() {
        target.to_path_buf()
    } else {
        environment.project_dir.join(target)
    });
    Ok(
        if inside(&environment.project_dir, &target) || inside(&environment.workspace, &target) {
            target
        } else {
            fallback
        },
    )
}
pub(crate) fn mime_for_path(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        _ => "image/png",
    }
}
fn basename(path: &str) -> String {
    path.trim_end_matches('/')
        .rsplit('/')
        .next()
        .unwrap_or("")
        .to_owned()
}
fn normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            component => out.push(component.as_os_str()),
        }
    }
    out
}
fn inside(root: &Path, target: &Path) -> bool {
    target != root && target.starts_with(root)
}
fn relative(root: &Path, target: &Path) -> Result<String, Error> {
    if !root.is_absolute() || !target.is_absolute() {
        return Err(Error::invalid(
            "Cursor canonical path observations must be absolute",
        ));
    }
    let root = root.components().collect::<Vec<_>>();
    let target = target.components().collect::<Vec<_>>();
    let common = root
        .iter()
        .zip(&target)
        .take_while(|(left, right)| left == right)
        .count();
    let mut relative = PathBuf::new();
    for _ in common..root.len() {
        relative.push("..");
    }
    for component in &target[common..] {
        relative.push(component.as_os_str());
    }
    Ok(relative.to_string_lossy().into_owned())
}
fn hash(bytes: &[u8]) -> [u8; 32] {
    let mut hash = [0; 32];
    hash.copy_from_slice(ring::digest::digest(&ring::digest::SHA256, bytes).as_ref());
    hash
}
fn infer(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(&[137, 80, 78, 71, 13, 10, 26, 10]) {
        return Some("image/png");
    }
    if bytes.starts_with(&[255, 216, 255]) {
        return Some("image/jpeg");
    }
    if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        return Some("image/gif");
    }
    if bytes.len() >= 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP" {
        return Some("image/webp");
    }
    None
}
pub(crate) fn supports(id: &LosslessString, models: &[super::models::Info]) -> bool {
    models
        .iter()
        .find(|model| &model.id == id)
        .and_then(|model| model.supports_images)
        .unwrap_or_else(|| {
            matches!(
                id.as_str(),
                Some(
                    "claude-fable-5"
                        | "claude-fable-5-1"
                        | "claude-haiku-4-5"
                        | "claude-opus-4-5"
                        | "claude-opus-4-6"
                        | "claude-opus-4-7"
                        | "claude-opus-4-8"
                        | "claude-opus-5"
                        | "claude-opus-5-5"
                        | "claude-sonnet-4"
                        | "claude-sonnet-4-5"
                        | "claude-sonnet-4-6"
                        | "claude-sonnet-5"
                        | "composer-2.5"
                        | "gemini-2.5-flash"
                        | "gemini-3-flash"
                        | "gemini-3.1-pro"
                        | "gemini-3.5-flash"
                        | "gemini-3.6-flash"
                        | "gemini-3.7-flash"
                        | "gemini-3.8-flash"
                        | "gpt-5-mini"
                        | "gpt-5.1"
                        | "gpt-5.2"
                        | "gpt-5.3-codex"
                        | "gpt-5.4"
                        | "gpt-5.4-mini"
                        | "gpt-5.4-nano"
                        | "gpt-5.5"
                        | "gpt-5.6-luna"
                        | "gpt-5.6-sol"
                        | "gpt-5.6-terra"
                        | "kimi-k2.7-code"
                        | "kimi-k3"
                        | "muse-spark-1.3"
                )
            )
        })
}
