use crate::resources::discovery::{Diagnostic, Error, absolute, io, read_text};
use ring::rand::{SecureRandom, SystemRandom};
use std::{
    fs,
    path::{Path, PathBuf},
    time::Duration,
};
use url::Url;
use ycoding_schema::{JsonValue, LosslessString, ObjectDecoder, parse_json};
pub struct Pull {
    pub directories: Vec<PathBuf>,
    pub diagnostics: Vec<Diagnostic>,
}
#[derive(Clone)]
struct Plan {
    root: PathBuf,
    name: String,
    version: Option<String>,
    files: Vec<(String, PathBuf, String)>,
}
struct IndexSkill {
    name: String,
    version: Option<String>,
    files: Vec<String>,
}
pub async fn pull(url: &str, cache: &Path) -> Result<Pull, Error> {
    let base = if url.ends_with('/') {
        url.to_string()
    } else {
        format!("{url}/")
    };
    let source = Url::parse(&base).map_err(|_| Error::Rejected("Invalid skill source URL"))?;
    let index = source
        .join("index.json")
        .map_err(|_| Error::Rejected("Invalid skill source URL"))?;
    let http = reqwest::Client::builder()
        .retry(reqwest::retry::never())
        .build()
        .map_err(|_| Error::Rejected("Could not initialize skill HTTP client"))?;
    let index = match get(&http, index.as_str(), true)
        .await
        .and_then(|bytes| {
            parse_json(&String::from_utf8_lossy(&bytes))
                .map_err(|_| Error::Rejected("Invalid skill index JSON"))
        })
        .and_then(|v| decode_index(&v))
    {
        Ok(index) => index,
        Err(e) => {
            return Ok(Pull {
                directories: Vec::new(),
                diagnostics: vec![Diagnostic {
                    path: "index.json".into(),
                    reason: "unavailable".into(),
                    message: e.to_string(),
                }],
            });
        }
    };
    let key = ring::digest::digest(&ring::digest::SHA1_FOR_LEGACY_USE_ONLY, base.as_bytes())
        .as_ref()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<String>();
    let source_root = absolute(&cache.join("skills").join(key))?;
    let plans = index
        .into_iter()
        .filter_map(|skill| {
            if !safe_segment(&skill.name)
                || !skill
                    .files
                    .iter()
                    .any(|file| file == "SKILL.md" || file == &format!("{}.md", skill.name))
            {
                return None;
            }
            let root = absolute(&source_root.join(&skill.name)).ok()?;
            if root == source_root || !root.starts_with(&source_root) {
                return None;
            }
            let mut skill_url = source.clone();
            skill_url
                .path_segments_mut()
                .ok()?
                .pop_if_empty()
                .push(&skill.name)
                .push("");
            let files = skill
                .files
                .into_iter()
                .map(|file| {
                    if !safe_relative(&file) {
                        return None;
                    }
                    let resource = skill_url.join(&file).ok()?;
                    if resource.origin() != source.origin() {
                        return None;
                    }
                    let destination = absolute(&root.join(&file)).ok()?;
                    if destination == root || !destination.starts_with(&root) {
                        return None;
                    }
                    Some((resource.to_string(), destination, file))
                })
                .collect::<Option<Vec<_>>>()?;
            Some(Plan {
                root,
                name: skill.name,
                version: skill.version,
                files,
            })
        })
        .collect::<Vec<_>>();
    let mut result = Pull {
        directories: Vec::new(),
        diagnostics: Vec::new(),
    };
    for chunk in plans.chunks(4) {
        let settled = tokio::join!(
            optional_load(&http, chunk.first()),
            optional_load(&http, chunk.get(1)),
            optional_load(&http, chunk.get(2)),
            optional_load(&http, chunk.get(3))
        );
        for loaded in [settled.0, settled.1, settled.2, settled.3] {
            let Some(mut loaded) = loaded? else {
                continue;
            };
            result.directories.append(&mut loaded.directories);
            result.diagnostics.append(&mut loaded.diagnostics);
        }
    }
    Ok(result)
}
fn decode_index(value: &JsonValue) -> Result<Vec<IndexSkill>, Error> {
    let path = ycoding_schema::JsonPath::default();
    let o = ObjectDecoder::new(value, &path)?;
    let skills: Vec<JsonValue> = o.field("skills")?;
    skills
        .iter()
        .map(|v| {
            let o = ObjectDecoder::new(v, &path)?;
            let name: LosslessString = o.field("name")?;
            let version: Option<LosslessString> = o.optional("version")?;
            let files: Vec<LosslessString> = o.field("files")?;
            Ok(IndexSkill {
                name: name
                    .to_utf8()
                    .map_err(|_| Error::Rejected("Skill names must be valid Unicode"))?,
                version: version
                    .map(|v| {
                        v.to_utf8()
                            .map_err(|_| Error::Rejected("Skill versions must be valid Unicode"))
                    })
                    .transpose()?,
                files: files
                    .iter()
                    .map(|v| {
                        v.to_utf8()
                            .map_err(|_| Error::Rejected("Skill filenames must be valid Unicode"))
                    })
                    .collect::<Result<Vec<_>, _>>()?,
            })
        })
        .collect()
}
async fn optional_load(http: &reqwest::Client, plan: Option<&Plan>) -> Result<Option<Pull>, Error> {
    match plan {
        Some(plan) => load(http, plan.clone()).await.map(Some),
        None => Ok(None),
    }
}
fn safe_segment(value: &str) -> bool {
    !value.is_empty() && value != "." && value != ".." && !value.contains(['/', '\\', '\0'])
}
fn safe_relative(value: &str) -> bool {
    !value.is_empty()
        && !value.contains(['\\', '\0', '?', '#'])
        && Url::parse(value).is_err()
        && !value.starts_with('/')
        && value
            .split('/')
            .all(|s| decoded_segment(s).is_some_and(|s| safe_segment(&s)))
}
fn decoded_segment(value: &str) -> Option<String> {
    let bytes = value.as_bytes();
    let mut output = Vec::new();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] != b'%' {
            output.push(bytes[index]);
            index += 1;
            continue;
        }
        let high = char::from(*bytes.get(index + 1)?).to_digit(16)?;
        let low = char::from(*bytes.get(index + 2)?).to_digit(16)?;
        output.push((high * 16 + low) as u8);
        index += 3;
    }
    String::from_utf8(output).ok()
}
async fn load(http: &reqwest::Client, plan: Plan) -> Result<Pull, Error> {
    let version_file = plan.root.join(".ycoding-version");
    let current = read_text(&version_file)?;
    let refresh = plan
        .version
        .as_ref()
        .is_some_and(|v| current.as_ref() != Some(v));
    let mut diagnostics = Vec::new();
    if !refresh {
        let files = plan
            .files
            .iter()
            .map(|(url, path, _)| (url.clone(), path.clone()))
            .collect::<Vec<_>>();
        diagnostics.extend(download_files(http, &files, false).await?.diagnostics);
    } else {
        let mut token = [0u8; 16];
        SystemRandom::new()
            .fill(&mut token)
            .map_err(|_| Error::Rejected("Could not create skill staging identity"))?;
        let token = token.iter().map(|b| format!("{b:02x}")).collect::<String>();
        let staging = PathBuf::from(format!("{}.tmp-{token}", plan.root.display()));
        let backup = PathBuf::from(format!("{}.old-{token}", plan.root.display()));
        let files = plan
            .files
            .iter()
            .map(|(url, _, file)| (url.clone(), staging.join(file)))
            .collect::<Vec<_>>();
        let downloaded = download_files(http, &files, true).await?;
        diagnostics.extend(downloaded.diagnostics);
        let published = || -> Result<(), Error> {
            if !diagnostics.is_empty() {
                return Ok(());
            }
            for (path, bytes) in downloaded.content {
                let parent = path
                    .parent()
                    .ok_or_else(|| Error::InvalidPath(path.clone()))?;
                fs::create_dir_all(parent).map_err(|e| io(parent, e))?;
                fs::write(&path, bytes).map_err(|e| io(&path, e))?;
            }
            fs::write(
                staging.join(".ycoding-version"),
                plan.version.as_ref().expect("refresh requires a version"),
            )
            .map_err(|e| io(&staging, e))?;
            let cached = plan.root.try_exists().map_err(|e| io(&plan.root, e))?;
            if cached {
                fs::rename(&plan.root, &backup).map_err(|e| io(&plan.root, e))?;
            }
            if let Err(cause) = fs::rename(&staging, &plan.root) {
                if cached {
                    fs::rename(&backup, &plan.root).map_err(|e| io(&backup, e))?;
                }
                return Err(io(&staging, cause));
            }
            if cached {
                remove(&backup)?;
            }
            Ok(())
        };
        let published = published();
        let cleaned = remove(&staging);
        published?;
        cleaned?;
    }
    let exists = plan
        .root
        .join("SKILL.md")
        .try_exists()
        .map_err(|e| io(&plan.root, e))?
        || plan
            .root
            .join(format!("{}.md", plan.name))
            .try_exists()
            .map_err(|e| io(&plan.root, e))?;
    Ok(Pull {
        directories: if exists { vec![plan.root] } else { Vec::new() },
        diagnostics,
    })
}
fn remove(path: &Path) -> Result<(), Error> {
    match fs::remove_dir_all(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(io(path, e)),
    }
}
struct Downloaded {
    content: Vec<(PathBuf, Vec<u8>)>,
    diagnostics: Vec<Diagnostic>,
}
async fn download_files(
    http: &reqwest::Client,
    files: &[(String, PathBuf)],
    buffered: bool,
) -> Result<Downloaded, Error> {
    let mut downloaded = Downloaded {
        content: Vec::new(),
        diagnostics: Vec::new(),
    };
    for chunk in files.chunks(8) {
        let settled = tokio::join!(
            fetch_file(http, chunk.first()),
            fetch_file(http, chunk.get(1)),
            fetch_file(http, chunk.get(2)),
            fetch_file(http, chunk.get(3)),
            fetch_file(http, chunk.get(4)),
            fetch_file(http, chunk.get(5)),
            fetch_file(http, chunk.get(6)),
            fetch_file(http, chunk.get(7))
        );
        for (i, file) in [
            settled.0, settled.1, settled.2, settled.3, settled.4, settled.5, settled.6, settled.7,
        ]
        .into_iter()
        .enumerate()
        {
            let loaded = match file {
                Ok(Some((path, bytes))) if buffered => {
                    downloaded.content.push((path, bytes));
                    Ok(())
                }
                Ok(Some((path, bytes))) => {
                    let parent = path
                        .parent()
                        .ok_or_else(|| Error::InvalidPath(path.clone()))?;
                    fs::create_dir_all(parent)
                        .map_err(|e| io(parent, e))
                        .and_then(|_| fs::write(&path, bytes).map_err(|e| io(&path, e)))
                }
                Ok(None) => Ok(()),
                Err(e) => Err(e),
            };
            if let Err(e) = loaded {
                downloaded.diagnostics.push(Diagnostic {
                    path: chunk.get(i).map_or_else(
                        || "skill resource".into(),
                        |(_, path)| path.display().to_string(),
                    ),
                    reason: "unavailable".into(),
                    message: e.to_string(),
                });
            }
        }
    }
    Ok(downloaded)
}
async fn fetch_file(
    http: &reqwest::Client,
    file: Option<&(String, PathBuf)>,
) -> Result<Option<(PathBuf, Vec<u8>)>, Error> {
    let Some((url, path)) = file else {
        return Ok(None);
    };
    if path.try_exists().map_err(|e| io(path, e))? {
        return Ok(None);
    }
    Ok(Some((path.clone(), get(http, url, false).await?)))
}
async fn get(http: &reqwest::Client, url: &str, json: bool) -> Result<Vec<u8>, Error> {
    for attempt in 0..3 {
        let request = http.get(url);
        let request = if json {
            request.header(reqwest::header::ACCEPT, "application/json")
        } else {
            request
        };
        let response = request.send().await;
        let retry = match response {
            Ok(response) if response.status().is_success() => match response.bytes().await {
                Ok(bytes) => return Ok(bytes.to_vec()),
                Err(_) => true,
            },
            Ok(response) => {
                response.status().is_server_error()
                    || [408, 429].contains(&response.status().as_u16())
            }
            Err(_) => true,
        };
        if !retry || attempt == 2 {
            return Err(Error::Rejected("Failed to download skill resource"));
        }
        let mut random = [0u8; 1];
        SystemRandom::new()
            .fill(&mut random)
            .map_err(|_| Error::Rejected("Could not schedule skill retry"))?;
        let jitter = 0.8 + f64::from(random[0]) / 255.0 * 0.4;
        tokio::time::sleep(Duration::from_secs_f64(
            0.2 * f64::from(1 << attempt) * jitter,
        ))
        .await;
    }
    unreachable!("the final attempt returns")
}
