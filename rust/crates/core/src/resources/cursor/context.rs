use serde_json::Value;
use std::{
    collections::BTreeSet,
    path::{Component, Path, PathBuf},
};
use ycoding_ai::{
    Error,
    cursor::protobuf::{write_bytes, write_varint},
    llm::ToolDefinition,
};

const CONFIG_FILE_NAMES: [&str; 2] = ["ycoding.json", "ycoding.jsonc"];
const LAYOUT_SKIP: [&str; 7] = [
    "node_modules",
    ".git",
    "dist",
    "build",
    ".next",
    "coverage",
    ".turbo",
];
const CATALOG_MARKER: &str = "Available agent types and the tools they have access to:";
const INLINE_MARKER: &str = "Available subagents:";
const GENERIC_SUBAGENTS: [&str; 5] = [
    "generalPurpose",
    "general-purpose",
    "general_purpose",
    "general",
    "unspecified",
];

#[derive(Clone, Debug)]
pub struct Environment {
    pub global_config_dir: PathBuf,
    pub cache_dir: PathBuf,
    pub home: PathBuf,
    pub project_discovery_disabled: bool,
}
impl Environment {
    pub fn project_discovery_disabled_in_process() -> bool {
        [
            "YCODING_CONFIG_PROJECT_DISABLE",
            "YCODING_DISABLE_PROJECT_CONFIG",
        ]
        .iter()
        .any(|name| matches!(std::env::var(name).as_deref(), Ok("true" | "1")))
    }
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Config {
    pub instructions: Vec<String>,
    pub plugins: Vec<String>,
    pub mcp_servers: Vec<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Rule {
    pub full_path: String,
    pub content: String,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Skill {
    pub full_path: String,
    pub name: String,
    pub description: String,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Plugin {
    pub id: String,
    pub source: &'static str,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Layout {
    pub abs_path: String,
    pub children_dirs: Vec<Layout>,
    pub children_files: Vec<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Agent {
    pub name: String,
    pub description: Option<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Subagents {
    pub agents: Vec<Agent>,
    pub complete: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Context {
    pub workspace: String,
    pub project_folder: String,
    pub rules: Vec<Rule>,
    pub layout: Layout,
    pub skills: Vec<Skill>,
    pub subagents: Subagents,
    pub hooks_additional_context: Option<String>,
    pub known_mcp_servers: Vec<String>,
}

pub fn project_config_dirs(workspace: &Path, environment: &Environment) -> Vec<PathBuf> {
    if environment.project_discovery_disabled {
        return Vec::new();
    }
    let mut dirs = workspace
        .ancestors()
        .map(|directory| directory.join(".ycoding"))
        .collect::<Vec<_>>();
    dirs.reverse();
    dirs
}

pub fn load_config(workspace: &Path, environment: &Environment) -> Config {
    let project = project_config_dirs(workspace, environment)
        .iter()
        .flat_map(|directory| directory.parent().map(Path::to_path_buf))
        .chain(project_config_dirs(workspace, environment))
        .map(|directory| read_config(&directory))
        .fold(Config::default(), merge);
    merge(read_config(&environment.global_config_dir), project)
}

pub fn build(workspace: &Path, tools: &[ToolDefinition], environment: &Environment) -> Context {
    let config = load_config(workspace, environment);
    let worktree = git_worktree(workspace);
    let project_folder = project_dir(&environment.cache_dir, workspace);
    let plugins = plugins(workspace, &config, environment);
    Context {
        workspace: workspace.to_string_lossy().into_owned(),
        project_folder: project_folder.to_string_lossy().into_owned(),
        rules: rules(workspace, &worktree, &config, environment),
        layout: layout(workspace, 0),
        skills: skills(workspace, &worktree, environment),
        subagents: host_subagents(tools),
        hooks_additional_context: (!plugins.is_empty()).then(|| {
            plugins
                .iter()
                .map(|plugin| format!("ycoding-plugin:{}:{}", plugin.source, plugin.id))
                .collect::<Vec<_>>()
                .join("\n")
        }),
        known_mcp_servers: config.mcp_servers,
    }
}

pub fn host_subagents(tools: &[ToolDefinition]) -> Subagents {
    let Some(executor) = tools
        .iter()
        .find(|tool| tool.name.as_str() == Some("task"))
        .or_else(|| {
            tools
                .iter()
                .find(|tool| tool.name.as_str() == Some("subagent"))
        })
    else {
        return Subagents {
            agents: Vec::new(),
            complete: true,
        };
    };
    let description =
        String::from_utf16_lossy(&executor.description.code_units().collect::<Vec<_>>());
    let (found, described) = described_agents(&description);
    let enumerated = enum_values(&executor.input_schema, None);
    let names = if enumerated.is_empty() {
        described.iter().map(|agent| agent.name.clone()).collect()
    } else {
        enumerated.clone()
    };
    Subagents {
        agents: names
            .into_iter()
            .map(|name| Agent {
                description: described
                    .iter()
                    .find(|agent| agent.name == name)
                    .and_then(|agent| agent.description.clone()),
                name,
            })
            .collect(),
        complete: !enumerated.is_empty() || found,
    }
}

pub fn resolve_subagent(requested: &str, catalog: &Subagents) -> Option<String> {
    let available = |name: &str| catalog.agents.iter().any(|agent| agent.name == name);
    let generic = GENERIC_SUBAGENTS.contains(&requested);
    if !generic && available(requested) {
        return Some(requested.to_owned());
    }
    let candidates: &[&str] = if generic {
        &["general"]
    } else if matches!(requested, "cursor-guide" | "cursor_guide") {
        &["scout", "explore", "general"]
    } else if matches!(
        requested,
        "explore" | "bugbot" | "security-review" | "security_review"
    ) {
        &["explore", "general"]
    } else {
        &["general"]
    };
    candidates
        .iter()
        .find(|candidate| available(candidate))
        .map(|candidate| (*candidate).to_owned())
}

impl Context {
    pub fn encode(&self) -> Result<Vec<u8>, Error> {
        let mut out = Vec::new();
        for rule in &self.rules {
            let mut message = Vec::new();
            string(&mut message, 1, &rule.full_path)?;
            string(&mut message, 2, &rule.content)?;
            write_bytes(&mut out, 2, &message)?;
        }
        write_bytes(&mut out, 4, &self.encode_env()?)?;
        write_bytes(&mut out, 13, &encode_layout(&self.layout)?)?;
        write_varint(&mut out, 17, 0)?;
        for agent in &self.subagents.agents {
            let mut message = Vec::new();
            string(&mut message, 1, "")?;
            string(&mut message, 2, &agent.name)?;
            string(
                &mut message,
                3,
                agent
                    .description
                    .as_deref()
                    .unwrap_or("Host-configured subagent."),
            )?;
            string(
                &mut message,
                6,
                &format!(
                    "Delegate to the host-configured {} subagent; its host instructions and tools apply.",
                    agent.name
                ),
            )?;
            write_bytes(&mut out, 22, &message)?;
        }
        let mut files = Vec::new();
        write_varint(&mut files, 1, 1)?;
        string(&mut files, 2, &self.project_folder)?;
        write_bytes(&mut out, 23, &files)?;
        write_varint(&mut out, 24, 0)?;
        if let Some(hooks) = &self.hooks_additional_context {
            string(&mut out, 25, hooks)?;
        }
        for skill in &self.skills {
            let mut message = Vec::new();
            string(&mut message, 1, &skill.full_path)?;
            string(&mut message, 3, &skill.description)?;
            write_bytes(&mut out, 29, &message)?;
        }
        let mut meta = Vec::new();
        write_varint(&mut meta, 1, 1)?;
        write_bytes(&mut out, 34, &meta)?;
        write_varint(&mut out, 36, 1)?;
        for field in [39, 40, 44] {
            write_varint(&mut out, field, 1)?;
        }
        write_varint(&mut out, 42, u64::from(self.subagents.complete))?;
        write_varint(&mut out, 43, 0)?;
        Ok(out)
    }

    fn encode_env(&self) -> Result<Vec<u8>, Error> {
        let mut env = Vec::new();
        string(&mut env, 1, std::env::consts::OS)?;
        string(&mut env, 2, &self.workspace)?;
        string(
            &mut env,
            3,
            &std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".into()),
        )?;
        write_varint(&mut env, 5, 0)?;
        string(&mut env, 7, &format!("{}/terminals", self.project_folder))?;
        string(
            &mut env,
            10,
            &std::env::var("TZ").unwrap_or_else(|_| "UTC".into()),
        )?;
        string(&mut env, 11, &self.project_folder)?;
        string(
            &mut env,
            12,
            &format!("{}/agent-transcripts", self.project_folder),
        )?;
        write_varint(&mut env, 14, 0)?;
        string(&mut env, 21, &self.workspace)?;
        Ok(env)
    }
}

fn encode_layout(node: &Layout) -> Result<Vec<u8>, Error> {
    let mut out = Vec::new();
    string(&mut out, 1, &node.abs_path)?;
    for child in &node.children_dirs {
        write_bytes(&mut out, 2, &encode_layout(child)?)?;
    }
    for name in &node.children_files {
        let mut file = Vec::new();
        string(&mut file, 1, name)?;
        write_bytes(&mut out, 3, &file)?;
    }
    write_varint(&mut out, 6, node.children_files.len() as u64)?;
    Ok(out)
}

fn string(out: &mut Vec<u8>, field: u32, text: &str) -> Result<(), Error> {
    write_bytes(out, field, text.as_bytes())
}

fn read_config(directory: &Path) -> Config {
    CONFIG_FILE_NAMES
        .iter()
        .filter_map(|name| std::fs::read_to_string(directory.join(name)).ok())
        .filter_map(|text| serde_json::from_str::<Value>(&strip_jsonc(&text)).ok())
        .filter_map(|value| {
            let object = value.as_object()?;
            Some(Config {
                instructions: strings(object.get("instructions")),
                plugins: object
                    .get("plugins")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .filter_map(|entry| match entry {
                        Value::String(id) => Some(id.clone()),
                        other => other.get("package")?.as_str().map(str::to_owned),
                    })
                    .collect(),
                mcp_servers: object
                    .get("mcp")
                    .and_then(|mcp| mcp.get("servers"))
                    .and_then(Value::as_object)
                    .map(|servers| servers.keys().cloned().collect())
                    .unwrap_or_default(),
            })
        })
        .fold(Config::default(), merge)
}

fn strings(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|item| item.as_str().map(str::to_owned))
        .collect()
}

fn merge(mut base: Config, overlay: Config) -> Config {
    base.instructions.extend(overlay.instructions);
    for plugin in overlay.plugins {
        if !base.plugins.contains(&plugin) {
            base.plugins.push(plugin);
        }
    }
    for server in overlay.mcp_servers {
        if !base.mcp_servers.contains(&server) {
            base.mcp_servers.push(server);
        }
    }
    base
}

fn strip_jsonc(text: &str) -> String {
    let characters = text.chars().collect::<Vec<_>>();
    let mut out = String::with_capacity(text.len());
    let mut index = 0;
    while index < characters.len() {
        let current = characters[index];
        let next = characters.get(index + 1).copied();
        if current == '"' {
            out.push(current);
            index += 1;
            while index < characters.len() {
                out.push(characters[index]);
                if characters[index] == '\\' {
                    index += 1;
                    if let Some(escaped) = characters.get(index) {
                        out.push(*escaped);
                    }
                } else if characters[index] == '"' {
                    break;
                }
                index += 1;
            }
            index += 1;
        } else if current == '/' && next == Some('/') {
            while index < characters.len() && characters[index] != '\n' {
                index += 1;
            }
        } else if current == '/' && next == Some('*') {
            index += 2;
            while index + 1 < characters.len()
                && !(characters[index] == '*' && characters[index + 1] == '/')
            {
                index += 1;
            }
            index += 2;
        } else {
            out.push(current);
            index += 1;
        }
    }
    let characters = out.chars().collect::<Vec<_>>();
    let mut result = String::with_capacity(out.len());
    let mut quoted = false;
    for (index, current) in characters.iter().enumerate() {
        if *current == '"' && (index == 0 || characters[index - 1] != '\\') {
            quoted = !quoted;
        }
        if !quoted
            && *current == ','
            && characters[index + 1..]
                .iter()
                .find(|next| !next.is_whitespace())
                .is_some_and(|next| matches!(next, ']' | '}'))
        {
            continue;
        }
        result.push(*current);
    }
    result
}

fn git_worktree(start: &Path) -> PathBuf {
    start
        .ancestors()
        .find(|directory| directory.join(".git").exists())
        .unwrap_or(start)
        .to_path_buf()
}

fn rules(
    workspace: &Path,
    worktree: &Path,
    config: &Config,
    environment: &Environment,
) -> Vec<Rule> {
    let mut found = Vec::<Rule>::new();
    let mut add = |file: PathBuf| {
        let resolved = file.to_string_lossy().into_owned();
        if found.iter().any(|rule| rule.full_path == resolved) {
            return;
        }
        if let Ok(content) = std::fs::read_to_string(&file)
            && !content.trim().is_empty()
        {
            found.push(Rule {
                full_path: resolved,
                content,
            });
        }
    };
    if !environment.project_discovery_disabled
        && let Some(hit) = ["AGENTS.md", "CLAUDE.md", "CONTEXT.md"]
            .iter()
            .find_map(|name| find_up(name, workspace, worktree))
    {
        add(hit);
    }
    add(environment.global_config_dir.join("AGENTS.md"));
    add(environment.home.join(".claude").join("CLAUDE.md"));
    for instruction in &config.instructions {
        if instruction.starts_with("http://")
            || instruction.starts_with("https://")
            || instruction.contains('*')
        {
            continue;
        }
        let expanded = instruction.strip_prefix("~/").map_or_else(
            || PathBuf::from(instruction),
            |rest| environment.home.join(rest),
        );
        add(if expanded.is_absolute() {
            expanded
        } else {
            workspace.join(expanded)
        });
    }
    found
}

fn find_up(name: &str, start: &Path, stop: &Path) -> Option<PathBuf> {
    for directory in start.ancestors() {
        let candidate = directory.join(name);
        if candidate.exists() {
            return Some(candidate);
        }
        if directory == stop {
            return None;
        }
    }
    None
}

fn skills(workspace: &Path, worktree: &Path, environment: &Environment) -> Vec<Skill> {
    let mut found = Vec::<Skill>::new();
    for directory in project_config_dirs(workspace, environment) {
        let relative = relative_to(workspace, &directory).join("skills");
        walk_ancestors(workspace, &relative, worktree, &mut found);
    }
    scan_skills(&environment.global_config_dir.join("skills"), &mut found);
    if !environment.project_discovery_disabled {
        walk_ancestors(workspace, Path::new(".claude/skills"), worktree, &mut found);
        walk_ancestors(workspace, Path::new(".agents/skills"), worktree, &mut found);
    }
    scan_skills(&environment.home.join(".claude").join("skills"), &mut found);
    scan_skills(&environment.home.join(".agents").join("skills"), &mut found);
    found
}

fn relative_to(from: &Path, to: &Path) -> PathBuf {
    let from = from.components().collect::<Vec<_>>();
    let to = to.components().collect::<Vec<_>>();
    let shared = from.iter().zip(&to).take_while(|(a, b)| a == b).count();
    from[shared..]
        .iter()
        .map(|_| Component::ParentDir)
        .chain(to[shared..].iter().copied())
        .collect()
}

fn normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::ParentDir => {
                if !out.pop() {
                    out.push("..");
                }
            }
            Component::CurDir => {}
            other => out.push(other),
        }
    }
    out
}

fn walk_ancestors(start: &Path, relative: &Path, stop: &Path, found: &mut Vec<Skill>) {
    for directory in start.ancestors() {
        scan_skills(&normalize(&directory.join(relative)), found);
        if directory == stop {
            return;
        }
    }
}

fn scan_skills(root: &Path, found: &mut Vec<Skill>) {
    let Ok(entries) = std::fs::read_dir(root) else {
        return;
    };
    let mut names = entries
        .filter_map(|entry| entry.ok()?.file_name().into_string().ok())
        .collect::<Vec<_>>();
    names.sort();
    for name in names {
        let file = root.join(&name).join("SKILL.md");
        let Ok(raw) = std::fs::read_to_string(&file) else {
            continue;
        };
        let (declared, description) = frontmatter(&raw);
        let skill = Skill {
            full_path: file.to_string_lossy().into_owned(),
            name: declared.filter(|name| !name.is_empty()).unwrap_or(name),
            description: description.unwrap_or_default(),
        };
        if !found.iter().any(|existing| existing.name == skill.name) {
            found.push(skill);
        }
    }
}

fn frontmatter(raw: &str) -> (Option<String>, Option<String>) {
    let Some(rest) = raw.strip_prefix("---") else {
        return (None, None);
    };
    let Some(end) = rest.find("\n---") else {
        return (None, None);
    };
    let (mut name, mut description) = (None, None);
    for line in rest[..end].trim().lines() {
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        if !key.chars().all(|c| c.is_alphanumeric() || c == '_') || key.is_empty() {
            continue;
        }
        let mut value = value.trim();
        if value.len() >= 2
            && ((value.starts_with('"') && value.ends_with('"'))
                || (value.starts_with('\'') && value.ends_with('\'')))
        {
            value = &value[1..value.len() - 1];
        }
        match key {
            "name" => name = Some(value.to_owned()),
            "description" => description = Some(value.to_owned()),
            _ => {}
        }
    }
    (name, description)
}

fn plugins(workspace: &Path, config: &Config, environment: &Environment) -> Vec<Plugin> {
    let mut found = Vec::<Plugin>::new();
    let mut seen = BTreeSet::new();
    for id in config
        .plugins
        .iter()
        .filter(|id| !id.is_empty() && !id.starts_with('-'))
    {
        if seen.insert(id.clone()) {
            found.push(Plugin {
                id: id.clone(),
                source: "npm",
            });
        }
    }
    let directories = project_config_dirs(workspace, environment)
        .into_iter()
        .chain(std::iter::once(environment.global_config_dir.clone()));
    for directory in directories {
        for name in ["plugin", "plugins"] {
            let Ok(entries) = std::fs::read_dir(directory.join(name)) else {
                continue;
            };
            let mut files = entries
                .filter_map(|entry| entry.ok()?.file_name().into_string().ok())
                .collect::<Vec<_>>();
            files.sort();
            for file in files {
                let Some(id) = ["mjs", "mts", "js", "ts"]
                    .iter()
                    .find_map(|extension| file.strip_suffix(&format!(".{extension}")))
                else {
                    continue;
                };
                if seen.insert(id.to_owned()) {
                    found.push(Plugin {
                        id: id.to_owned(),
                        source: "local",
                    });
                }
            }
        }
    }
    found
}

fn layout(directory: &Path, depth: usize) -> Layout {
    let mut node = Layout {
        abs_path: directory.to_string_lossy().into_owned(),
        children_dirs: Vec::new(),
        children_files: Vec::new(),
    };
    if depth >= 2 {
        return node;
    }
    let Ok(entries) = std::fs::read_dir(directory) else {
        return node;
    };
    let mut names = entries
        .filter_map(|entry| entry.ok()?.file_name().into_string().ok())
        .collect::<Vec<_>>();
    names.sort();
    let mut count = 0;
    for name in names {
        if count >= 80 {
            break;
        }
        if (name.starts_with('.') && !matches!(name.as_str(), ".ycoding" | ".claude" | ".agents"))
            || LAYOUT_SKIP.contains(&name.as_str())
        {
            continue;
        }
        let path = directory.join(&name);
        let Ok(metadata) = std::fs::metadata(&path) else {
            continue;
        };
        count += 1;
        if metadata.is_dir() {
            node.children_dirs.push(layout(&path, depth + 1));
        } else {
            node.children_files.push(name);
        }
    }
    node
}

fn project_dir(cache_dir: &Path, workspace: &Path) -> PathBuf {
    let slug = workspace
        .to_string_lossy()
        .replace(|c: char| !c.is_ascii_alphanumeric(), "-")
        .split('-')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("-");
    let directory = cache_dir.join("projects").join(slug);
    let text = directory.to_string_lossy().into_owned();
    if text.len() <= 92 {
        return directory;
    }
    let hash = ring::digest::digest(&ring::digest::SHA256, text.as_bytes())
        .as_ref()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    let mut cut = text.len().min(84);
    while !text.is_char_boundary(cut) {
        cut -= 1;
    }
    PathBuf::from(format!("{}-{}", &text[..cut], &hash[..7]))
}

fn described_agents(description: &str) -> (bool, Vec<Agent>) {
    if let Some(marker) = description.find(CATALOG_MARKER) {
        let mut agents = Vec::new();
        let mut started = false;
        for line in description[marker + CATALOG_MARKER.len()..].lines() {
            let entry = line
                .trim_start()
                .strip_prefix('-')
                .filter(|rest| rest.starts_with(char::is_whitespace))
                .and_then(|rest| rest.trim_start().split_once(':'));
            let Some((name, text)) = entry else {
                if started && !line.trim().is_empty() {
                    break;
                }
                continue;
            };
            started = true;
            let name = name.trim().trim_matches('`');
            if name.is_empty() {
                continue;
            }
            agents.push(Agent {
                name: name.to_owned(),
                description: Some(text.trim().to_owned()).filter(|text| !text.is_empty()),
            });
        }
        return (true, agents);
    }
    let Some(at) = description.find(INLINE_MARKER) else {
        return (false, Vec::new());
    };
    let rest = &description[at + INLINE_MARKER.len()..];
    let mut hits = Vec::<(usize, usize, String)>::new();
    let bytes = rest.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'-'
            && let Some(white) = rest[index + 1..].find(|c: char| !c.is_whitespace())
            && white > 0
        {
            let start = index + 1 + white;
            let name_length = rest[start..]
                .find(|c: char| !(c.is_ascii_alphanumeric() || c == '_' || c == '-'))
                .unwrap_or(rest.len() - start);
            if name_length > 0 && rest[start + name_length..].starts_with(':') {
                let after = start + name_length + 1;
                let skipped = rest[after..]
                    .find(|c: char| !c.is_whitespace())
                    .unwrap_or(rest.len() - after);
                hits.push((
                    index,
                    after + skipped,
                    rest[start..start + name_length].to_owned(),
                ));
                index = after + skipped;
                continue;
            }
        }
        index += 1;
    }
    let agents = hits
        .iter()
        .enumerate()
        .map(|(position, (_, start, name))| {
            let end = hits.get(position + 1).map_or(rest.len(), |next| next.0);
            Agent {
                name: name.clone(),
                description: Some(rest[*start..end].trim().to_owned())
                    .filter(|text| !text.is_empty()),
            }
        })
        .collect::<Vec<_>>();
    (!agents.is_empty(), agents)
}

fn enum_values(schema: &ycoding_schema::JsonValue, property: Option<&str>) -> Vec<String> {
    use ycoding_schema::JsonValue;
    let mut out = Vec::new();
    match schema {
        JsonValue::Array(items) => {
            for item in items {
                for value in enum_values(item, property) {
                    if !out.contains(&value) {
                        out.push(value);
                    }
                }
            }
        }
        JsonValue::Object(object) => {
            if matches!(property, Some("subagent_type" | "agent"))
                && let Some(JsonValue::Array(items)) = object.get(&"enum".into())
            {
                for item in items {
                    if let JsonValue::String(text) = item
                        && let Some(text) = text.as_str().filter(|text| !text.is_empty())
                        && !out.iter().any(|value| value == text)
                    {
                        out.push(text.to_owned());
                    }
                }
            }
            for (key, child) in object.iter() {
                let key = key.to_utf8().unwrap_or_default();
                for value in enum_values(child, Some(&key)) {
                    if !out.contains(&value) {
                        out.push(value);
                    }
                }
            }
        }
        _ => {}
    }
    out
}
