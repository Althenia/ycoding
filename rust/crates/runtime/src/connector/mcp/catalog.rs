use super::json::{object, string};
use std::sync::LazyLock;
use ycoding_core::ycoding_schema::JsonValue;
use ycoding_protocol::{OPERATIONS, domain_json, v5};

pub struct Tool {
    pub name: &'static str,
    pub operation: Option<&'static str>,
    pub mutation: bool,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum Rule {
    Prefix(&'static str, usize),
    Session,
    Shell,
    Nonblank,
    Required,
    Absent,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum Scope {
    Session,
    Form,
    OptionalSession,
    Workspace,
    Machine,
    Global,
}

pub(super) struct Spec {
    pub tool: Tool,
    pub description: &'static str,
    pub rules: &'static [(&'static str, Rule)],
    pub scope: Scope,
    pub descriptor: Option<&'static v5::OperationDescriptor>,
    pub schema: JsonValue,
}

pub(super) const DIRECTORY: &str = "session_create_in_directory";
const MESSAGE: Rule = Rule::Prefix("msg_", 128);

type Row = (
    &'static str,
    Option<&'static str>,
    &'static str,
    &'static [(&'static str, Rule)],
);

const ROWS: &[Row] = &[
    (
        "local_app_register",
        Some("local.app.register"),
        "Register a Session-owned loopback HTTP application with explicit routes and methods.",
        &[],
    ),
    (
        "local_app_list",
        Some("local.app.list"),
        "List safe application registration metadata for the authorized Session and client.",
        &[],
    ),
    (
        "local_app_revoke",
        Some("local.app.revoke"),
        "Revoke a local application registration and cancel its active requests.",
        &[],
    ),
    (
        "local_app_open",
        Some("local.app.open"),
        "Open a registered application through a configured trusted preview issuer.",
        &[],
    ),
    (
        "local_app_status",
        Some("local.app.status"),
        "Read application preview status without extending its access.",
        &[],
    ),
    (
        "local_app_http",
        Some("local.app.http"),
        "Send a bounded HTTP request to a registered route and method; binary bodies use base64.",
        &[],
    ),
    (
        "artifact_demo_preview",
        Some("artifact.demo.preview"),
        "Test this client's MCP Apps support with fixed List/Cards variants and an isolated-frame probe; generated HTML is not accepted.",
        &[],
    ),
    (
        "artifact_demo_export",
        Some("artifact.demo.export"),
        "Export the fixed original-byte PNG resource with integrity metadata. The host must fetch it and create its native attachment.",
        &[],
    ),
    (
        "provider_auth_list",
        Some("provider.auth.list"),
        "List provider connection methods for a Session or advertised workspace target.",
        &[],
    ),
    (
        "provider_auth_key",
        Some("provider.auth.key"),
        "Store a provider API key for the target's Location. Send only a key the user supplied.",
        &[
            ("payload.label", Rule::Nonblank),
            ("payload.key", Rule::Nonblank),
        ],
    ),
    (
        "provider_auth_begin",
        Some("provider.auth.begin"),
        "Begin a provider connection attempt for the target and return its next step.",
        &[("payload.label", Rule::Nonblank)],
    ),
    (
        "provider_auth_status",
        Some("provider.auth.status"),
        "Read the state of a provider connection attempt.",
        &[("payload.attemptID", Rule::Prefix("con_", 128))],
    ),
    (
        "provider_auth_complete",
        Some("provider.auth.complete"),
        "Complete a provider connection attempt with the authorization code the user obtained.",
        &[
            ("payload.attemptID", Rule::Prefix("con_", 128)),
            ("payload.code", Rule::Nonblank),
        ],
    ),
    (
        "provider_auth_cancel",
        Some("provider.auth.cancel"),
        "Cancel a pending provider connection attempt.",
        &[("payload.attemptID", Rule::Prefix("con_", 128))],
    ),
    (
        "workspace_list",
        Some("workspace.list"),
        "List the recorded workspaces on this machine.",
        &[],
    ),
    (
        "session_list",
        Some("session.list"),
        "Page through the backend's Sessions. Pass the returned cursor to continue.",
        &[],
    ),
    (
        "session_active",
        Some("session.active"),
        "List the backend's active Sessions.",
        &[],
    ),
    (
        "session_get",
        Some("session.get"),
        "Read one Session's record.",
        &[],
    ),
    (
        "session_messages",
        Some("session.messages"),
        "Read a Session's projected messages.",
        &[],
    ),
    (
        "session_captured_changes_list",
        Some("session.capturedChanges.list"),
        "Page through a Session's captured file changes.",
        &[],
    ),
    (
        "session_compaction_list",
        Some("session.compaction.list"),
        "List a Session's compaction checkpoints.",
        &[],
    ),
    (
        "session_compact",
        Some("session.compact"),
        "Compact a Session's context.",
        &[("payload.id", Rule::Prefix("cmp_", 128))],
    ),
    (
        "session_snapshot",
        Some("session.snapshot"),
        "Read a Session snapshot with its newest messages. Pass before to page older history.",
        &[],
    ),
    (
        "session_pending_list",
        Some("session.pending.list"),
        "List a Session's admitted inputs that have not been promoted yet.",
        &[],
    ),
    (
        "session_attachment_read",
        Some("session.attachment.read"),
        "Read one Session attachment by digest; its bytes return as base64.",
        &[],
    ),
    (
        "session_todo_list",
        Some("session.todo.list"),
        "Read a Session's todo list.",
        &[],
    ),
    (
        "session_subagent_list",
        Some("session.subagent.list"),
        "Page through a Session's subagents.",
        &[],
    ),
    (
        "session_pin",
        Some("session.pin"),
        "Pin a managed child Session.",
        &[],
    ),
    (
        "session_unpin",
        Some("session.unpin"),
        "Unpin a managed child Session.",
        &[],
    ),
    (
        "session_subagent_cancel",
        Some("session.subagent.cancel"),
        "Cancel a running subagent of a Session.",
        &[("params.childID", Rule::Session)],
    ),
    (
        "session_subagent_answer",
        Some("session.subagent.answer"),
        "Answer a subagent's pending question. Send only an answer the user authorized.",
        &[
            ("params.childID", Rule::Session),
            ("params.questionID", Rule::Prefix("qst_", 128)),
        ],
    ),
    (
        "session_team_economics",
        Some("session.team.economics"),
        "Read cost and token economics for a root Session and listed children.",
        &[],
    ),
    (
        "session_team_shell_list",
        Some("session.team.shell.list"),
        "List shells of a Session family.",
        &[],
    ),
    (
        "session_team_shell_kill",
        Some("session.team.shell.kill"),
        "Kill a running shell of a Session family.",
        &[("payload.shellID", Rule::Shell)],
    ),
    (
        "session_side_chat_list",
        Some("session.side-chat.list"),
        "List a Session's side chats.",
        &[],
    ),
    (
        "session_side_chat_create",
        Some("session.side-chat.create"),
        "Create a side chat for a Session with a client-generated Session ID.",
        &[("payload.id", Rule::Session)],
    ),
    (
        "session_family_activity",
        Some("session.family.activity"),
        "Read current activity for a root Session and listed children.",
        &[],
    ),
    (
        "session_log",
        Some("session.log"),
        "Read a Session's durable event log from an optional cursor to its current end.",
        &[("query.follow", Rule::Absent)],
    ),
    (
        "session_prompt",
        Some("session.prompt"),
        "Send a prompt to a Session. Use a fresh message ID; reuse it only to retry the same prompt in the same Session.",
        &[("payload.id", Rule::Required), ("payload.id", MESSAGE)],
    ),
    (
        "session_interrupt",
        Some("session.interrupt"),
        "Interrupt a Session's execution and wait until it is idle.",
        &[],
    ),
    (
        "session_prediction",
        Some("session.prediction"),
        "Predict the user's next prompt for a Session.",
        &[],
    ),
    (
        "session_prompt_generate",
        Some("session.promptGenerate"),
        "Draft a prompt for a Session from an intent.",
        &[("payload.intent", Rule::Nonblank)],
    ),
    (
        "session_permission_list",
        Some("session.permission.list"),
        "List a Session family's pending permission requests.",
        &[],
    ),
    (
        "session_permission_reply",
        Some("session.permission.reply"),
        "Answer a pending permission request: once approves it, always persists the approval, reject refuses. Send only the decision the user authorized.",
        &[("params.requestID", Rule::Prefix("per_", 128))],
    ),
    (
        "session_guardrail_status",
        Some("session.guardrail.status"),
        "Read a Session's guardrail review status.",
        &[],
    ),
    (
        "session_guardrail_request_list",
        Some("session.guardrail.request.list"),
        "List a Session family's pending guardrail reviews.",
        &[],
    ),
    (
        "session_guardrail_reply",
        Some("session.guardrail.request.reply"),
        "Answer a pending guardrail review: once approves this action, always persists a directory-scoped approval, reject refuses. Send only the decision the user authorized.",
        &[("params.requestID", Rule::Prefix("grq_", 128))],
    ),
    (
        "session_review_list",
        Some("session.review.list"),
        "List the open review items of a Session's family, including deferred ones.",
        &[],
    ),
    (
        "session_review_decide",
        Some("session.review.decide"),
        "Decide an open review item. Send only the decision the user authorized.",
        &[("params.itemID", Rule::Prefix("rvw_", 128))],
    ),
    (
        "session_form_list",
        Some("session.form.list"),
        "List a Session's pending forms and questions.",
        &[],
    ),
    (
        "session_form_reply",
        Some("session.form.reply"),
        "Answer a pending form or question. Send only an answer the user authorized.",
        &[("params.formID", Rule::Prefix("frm_", 64))],
    ),
    (
        "session_form_cancel",
        Some("session.form.cancel"),
        "Cancel a pending form or question.",
        &[("params.formID", Rule::Prefix("frm_", 64))],
    ),
    (
        "session_shell_output",
        Some("shell.output"),
        "Read a page of a Session shell's output. Pass the returned cursor to continue.",
        &[("params.id", Rule::Shell)],
    ),
    (
        "session_autonomy_get",
        Some("session.autonomy.get"),
        "Read a Session's autonomy settings.",
        &[],
    ),
    (
        "session_autonomy_set",
        Some("session.autonomy.set"),
        "Change a Session's autonomy: YOLO 0 asks first, 1 auto-approves tool permissions, 2 also auto-approves ordinary guardrail reviews; sleep and autoAnswer are separate settings. Grants standing authority; send only what the user authorized.",
        &[],
    ),
    (
        "session_goal_set",
        Some("session.autonomy.set"),
        "Set a Session's goal and optionally its no-progress budget of at least 1. The Session then continues toward the goal.",
        &[],
    ),
    (
        "session_goal_stop",
        Some("session.autonomy.set"),
        "Stop a Session's goal.",
        &[],
    ),
    (
        "session_create",
        Some("session.create"),
        "Create a root Session in a recorded workspace from workspace_list. Supply a client-generated Session ID and retry an uncertain create with the same ID and workspace.",
        &[
            ("payload.id", Rule::Required),
            ("payload.id", Rule::Session),
            ("payload.parentID", Rule::Absent),
        ],
    ),
    (
        "session_status",
        Some("session.status"),
        "Read which root Sessions are running, need attention, failed, or were lost.",
        &[],
    ),
    (
        "session_catalog",
        Some("catalog.get"),
        "List the agents, models, commands, skills, references and resources available to a Session.",
        &[],
    ),
    (
        "workspace_catalog",
        Some("catalog.get"),
        "List the agents, models, commands, skills, references and resources available in a workspace.",
        &[],
    ),
    (
        "session_file_find",
        Some("fs.find"),
        "Find files by name at a Session's Location.",
        &[],
    ),
    (
        "workspace_file_find",
        Some("fs.find"),
        "Find files by name in a workspace.",
        &[],
    ),
    (
        "session_switch_model",
        Some("session.switchModel"),
        "Switch a Session's model.",
        &[],
    ),
    (
        "session_switch_agent",
        Some("session.switchAgent"),
        "Switch a Session's agent.",
        &[],
    ),
    (
        "session_command",
        Some("session.command"),
        "Run a slash command in a Session.",
        &[("payload.id", MESSAGE)],
    ),
    (
        "session_skill",
        Some("session.skill"),
        "Load a skill into a Session.",
        &[("payload.id", MESSAGE), ("payload.skill", Rule::Nonblank)],
    ),
    (
        "usage_providers",
        Some("providerUsage.list"),
        "Read provider quota and usage status. Pass refresh to re-read it from the providers.",
        &[],
    ),
    (
        "usage_summary",
        Some("usage.get"),
        "Read the backend's usage summary.",
        &[],
    ),
    (
        "usage_report",
        Some("usage.report"),
        "Read a backend usage report grouped by the chosen dimension.",
        &[],
    ),
    (
        "session_usage_report",
        Some("session.usageReport"),
        "Read a usage report for one Session's tree grouped by the chosen dimension.",
        &[],
    ),
    (
        "session_prompt_costs",
        Some("session.promptCosts"),
        "Read the cost of prompts of a Session by prompt message ID.",
        &[],
    ),
    (
        "session_task_costs",
        Some("session.taskCosts"),
        "Read the cost of task Sessions of a Session's tree by Session ID.",
        &[],
    ),
    (
        "usage_forecast",
        Some("providerUsage.forecast"),
        "Read a usage forecast: localScope backend takes no sessionID; location takes the sessionID whose Location it covers.",
        &[],
    ),
    (
        "incident_report",
        Some("incident.report"),
        "Read the backend's model incident report grouped by model or agent.",
        &[],
    ),
    (
        "incident_recent",
        Some("incident.recent"),
        "Read recent incidents of one model.",
        &[],
    ),
    (
        "incident_guidance",
        Some("incident.guidance.get"),
        "Read the guardrail guidance derived for a model at a Session's Location.",
        &[],
    ),
    (
        "machine_keep_awake_get",
        Some("keepAwake.get"),
        "Read whether this machine is held awake for running Sessions.",
        &[],
    ),
    (
        "machine_keep_awake_set",
        Some("keepAwake.set"),
        "Turn this machine's keep-awake preference on or off.",
        &[],
    ),
    (
        DIRECTORY,
        None,
        "Create a root Session in an existing directory strictly below the machine owner's home directory. Supply a client-generated Session ID and retry an uncertain create with the same ID and directory.",
        &[],
    ),
];

static SPECS: LazyLock<Vec<Spec>> = LazyLock::new(|| ROWS.iter().map(build).collect());
static TOOLS: LazyLock<Vec<Tool>> = LazyLock::new(|| {
    SPECS
        .iter()
        .map(|spec| Tool {
            name: spec.tool.name,
            operation: spec.tool.operation,
            mutation: spec.tool.mutation,
        })
        .collect()
});

pub fn tools() -> &'static [Tool] {
    TOOLS.as_slice()
}

pub(super) fn specs() -> &'static [Spec] {
    SPECS.as_slice()
}

pub(super) fn spec(name: &str) -> Option<&'static Spec> {
    SPECS.iter().find(|spec| spec.tool.name == name)
}

fn build(row: &Row) -> Spec {
    let (name, operation, description, rules) = *row;
    let descriptor = operation.map(|operation| {
        OPERATIONS
            .iter()
            .find(|descriptor| descriptor.diagnostic_name == operation)
            .expect("Relay MCP tool names a generated operation")
    });
    let scope = descriptor.map_or(Scope::Machine, |descriptor| scope(name, descriptor));
    let mut spec = Spec {
        tool: Tool {
            name,
            operation,
            mutation: descriptor
                .is_none_or(|descriptor| descriptor.mutation == v5::MutationClass::Mutation as i32),
        },
        description,
        rules,
        scope,
        descriptor,
        schema: JsonValue::Null,
    };
    spec.schema = match operation.filter(|operation| operation.starts_with("local.app.")) {
        Some(operation) => super::super::local_apps::tool_schema(operation),
        None => arguments(&spec),
    };
    spec
}

fn scope(name: &str, descriptor: &v5::OperationDescriptor) -> Scope {
    let relay = descriptor
        .role_scopes
        .iter()
        .find(|entry| entry.role == v5::PeerRole::Relay as i32)
        .map_or_else(|| vec![descriptor.scope], |entry| entry.scopes.clone());
    let has = |kind: v5::ScopeKind| relay.contains(&(kind as i32));
    if has(v5::ScopeKind::Workspace) && (name.starts_with("workspace_") || name == "session_create")
    {
        return Scope::Workspace;
    }
    if has(v5::ScopeKind::Session) && has(v5::ScopeKind::Machine) {
        return Scope::OptionalSession;
    }
    if has(v5::ScopeKind::Form) {
        return Scope::Form;
    }
    if has(v5::ScopeKind::Session) {
        return Scope::Session;
    }
    if has(v5::ScopeKind::Global) {
        return Scope::Global;
    }
    Scope::Machine
}

pub(super) fn injected(spec: &Spec) -> Option<&'static str> {
    if !matches!(
        spec.scope,
        Scope::Session | Scope::Form | Scope::OptionalSession
    ) {
        return None;
    }
    let params = domain_json::message(&spec.descriptor?.request_type)?
        .fields
        .iter()
        .find(|field| field.name == "params")?;
    let params = domain_json::message(params.target)?;
    ["sessionID", "parentID"]
        .into_iter()
        .find(|name| params.fields.iter().any(|field| field.name == *name))
}

pub(super) fn defaulted(spec: &Spec) -> Vec<&'static str> {
    spec.descriptor
        .and_then(|descriptor| domain_json::message(&descriptor.request_type))
        .map(|request| {
            request
                .fields
                .iter()
                .filter(|field| field.name != "params" && field.required && defaultable(field))
                .map(|field| field.name)
                .collect()
        })
        .unwrap_or_default()
}

fn defaultable(field: &domain_json::Field) -> bool {
    field.kind == 11
        && domain_json::message(field.target).is_some_and(|message| {
            message.oneofs.is_empty()
                && !matches!(message.fields, [only] if only.repeated)
                && message.fields.iter().all(|item| !item.required)
        })
}

fn arguments(spec: &Spec) -> JsonValue {
    let session = pattern("ses", 128, true);
    let mut properties = Vec::new();
    let mut required = Vec::new();
    match spec.scope {
        Scope::Session | Scope::Form => {
            properties.push(("sessionID", session));
            required.push("sessionID");
        }
        Scope::OptionalSession => properties.push(("sessionID", session)),
        Scope::Workspace => {
            properties.push((
                "workspace",
                object([
                    ("type", string("string")),
                    ("minLength", JsonValue::Number(1.0)),
                    ("maxLength", JsonValue::Number(256.0)),
                ]),
            ));
            required.push("workspace");
        }
        Scope::Machine | Scope::Global => {}
    }
    if let Some((schema, needed)) = input(spec) {
        properties.push(("input", schema));
        if needed {
            required.push("input");
        }
    }
    record(properties, required)
}

fn input(spec: &Spec) -> Option<(JsonValue, bool)> {
    if spec.tool.name == DIRECTORY {
        let model = domain_json::message("ycoding.v5.session_create_Request_payload")
            .and_then(|payload| payload.fields.iter().find(|field| field.name == "model"))
            .map(|field| message_schema(field.target, "", spec, &mut Vec::new()))
            .unwrap_or(JsonValue::Object(Default::default()));
        return Some((
            record(
                vec![
                    ("id", pattern("ses", 128, true)),
                    ("directory", text_schema(4096)),
                    ("agent", text_schema(128)),
                    ("model", model),
                ],
                vec!["id", "directory"],
            ),
            true,
        ));
    }
    match spec.tool.name {
        "session_goal_stop" => return None,
        "session_goal_set" => {
            return Some((
                record(
                    vec![(
                        "payload",
                        record(
                            vec![
                                (
                                    "goal",
                                    object([
                                        ("type", string("string")),
                                        ("minLength", JsonValue::Number(1.0)),
                                    ]),
                                ),
                                (
                                    "maxNoProgress",
                                    object([
                                        ("type", string("integer")),
                                        ("minimum", JsonValue::Number(1.0)),
                                        ("maximum", JsonValue::Number(9_007_199_254_740_991.0)),
                                    ]),
                                ),
                            ],
                            vec!["goal"],
                        ),
                    )],
                    vec!["payload"],
                ),
                true,
            ));
        }
        _ => {}
    }
    let request = domain_json::message(&spec.descriptor?.request_type)?;
    let skip = injected(spec);
    let mut properties = Vec::new();
    let mut required = Vec::new();
    for field in request.fields {
        let (schema, needed) = if field.name == "params" {
            let params = domain_json::message(field.target)?;
            let remaining = params
                .fields
                .iter()
                .filter(|item| Some(item.name) != skip)
                .collect::<Vec<_>>();
            if remaining.is_empty() {
                continue;
            }
            let needed = remaining.iter().any(|item| item.required);
            (
                record(
                    remaining
                        .into_iter()
                        .map(|item| {
                            (
                                item.name,
                                field_schema(item, "params", spec, &mut Vec::new()),
                            )
                        })
                        .collect(),
                    params
                        .fields
                        .iter()
                        .filter(|item| item.required && Some(item.name) != skip)
                        .map(|item| item.name)
                        .collect(),
                ),
                needed,
            )
        } else {
            (
                message_schema(field.target, field.name, spec, &mut Vec::new()),
                field.required && !defaultable(field),
            )
        };
        if needed {
            required.push(field.name);
        }
        properties.push((field.name, schema));
    }
    if properties.is_empty() {
        return None;
    }
    let needed = !required.is_empty();
    Some((record(properties, required), needed))
}

fn message_schema(name: &str, path: &str, spec: &Spec, stack: &mut Vec<String>) -> JsonValue {
    if name == "ycoding.v5.LosslessString" {
        return object([("type", string("string"))]);
    }
    if name == "ycoding.v5.Value" || stack.iter().any(|item| item == name) {
        return JsonValue::Object(Default::default());
    }
    let Some(message) = domain_json::message(name) else {
        return JsonValue::Object(Default::default());
    };
    stack.push(name.to_owned());
    let schema = if let [field] = message.fields
        && field.repeated
    {
        if field.name == "entries" && field.kind == 11 {
            let value = domain_json::message(field.target)
                .and_then(|entry| entry.fields.iter().find(|item| item.name == "value"))
                .map(|item| field_schema(item, path, spec, stack))
                .unwrap_or(JsonValue::Object(Default::default()));
            object([("type", string("object")), ("additionalProperties", value)])
        } else {
            object([
                ("type", string("array")),
                ("items", scalar_schema(field, path, spec, stack)),
            ])
        }
    } else if message.oneofs.len() == 1 && message.fields.iter().all(|field| field.oneof.is_some())
    {
        JsonValue::Object({
            let mut union = ycoding_core::ycoding_schema::JsonObject::new();
            union.insert(
                "anyOf".into(),
                JsonValue::Array(
                    message
                        .fields
                        .iter()
                        .map(|field| {
                            if field.name == "clear" {
                                return object([("type", string("null"))]);
                            }
                            if let Some(literal) = field.literal {
                                return object([(
                                    "const",
                                    ycoding_core::ycoding_schema::parse_json(literal)
                                        .unwrap_or(JsonValue::Null),
                                )]);
                            }
                            scalar_schema(field, path, spec, stack)
                        })
                        .collect(),
                ),
            );
            union
        })
    } else {
        record(
            message
                .fields
                .iter()
                .filter(|field| field.name != "location" && !absent(spec, &join(path, field.name)))
                .map(|field| (field.name, field_schema(field, path, spec, stack)))
                .collect(),
            message
                .fields
                .iter()
                .filter(|field| {
                    (field.required || required(spec, &join(path, field.name)))
                        && field.name != "location"
                })
                .map(|field| field.name)
                .collect(),
        )
    };
    stack.pop();
    schema
}

fn field_schema(
    field: &domain_json::Field,
    path: &str,
    spec: &Spec,
    stack: &mut Vec<String>,
) -> JsonValue {
    let item = scalar_schema(field, path, spec, stack);
    if field.repeated {
        return object([("type", string("array")), ("items", item)]);
    }
    item
}

fn scalar_schema(
    field: &domain_json::Field,
    path: &str,
    spec: &Spec,
    stack: &mut Vec<String>,
) -> JsonValue {
    let path = join(path, field.name);
    if let Some(rule) = spec
        .rules
        .iter()
        .filter(|(target, _)| *target == path)
        .map(|(_, rule)| *rule)
        .find(|rule| !matches!(rule, Rule::Required | Rule::Absent))
    {
        return match rule {
            Rule::Prefix(prefix, max) => pattern(prefix, max, false),
            Rule::Session => pattern("ses", 128, true),
            Rule::Shell => object([
                ("type", string("string")),
                ("minLength", JsonValue::Number(1.0)),
                ("maxLength", JsonValue::Number(128.0)),
                ("pattern", string("^sh_[A-Za-z0-9]+$")),
            ]),
            _ => object([
                ("type", string("string")),
                ("minLength", JsonValue::Number(1.0)),
                ("pattern", string("^[\\s\\S]*\\S[\\s\\S]*$")),
            ]),
        };
    }
    match field.kind {
        11 => message_schema(field.target, &path, spec, stack),
        14 => {
            let values = domain_json::enumeration(field.target)
                .map(|item| {
                    item.values
                        .iter()
                        .map(|value| string(item.text(value)))
                        .collect()
                })
                .unwrap_or_default();
            object([
                ("type", string("string")),
                ("enum", JsonValue::Array(values)),
            ])
        }
        9 => object([("type", string("string"))]),
        8 => object([("type", string("boolean"))]),
        1 => object([("type", string("number"))]),
        4 | 13 => object([
            ("type", string("integer")),
            ("minimum", JsonValue::Number(0.0)),
            ("maximum", JsonValue::Number(9_007_199_254_740_991.0)),
        ]),
        3 | 5 => object([
            ("type", string("integer")),
            ("minimum", JsonValue::Number(-9_007_199_254_740_991.0)),
            ("maximum", JsonValue::Number(9_007_199_254_740_991.0)),
        ]),
        _ => JsonValue::Object(Default::default()),
    }
}

fn join(path: &str, name: &str) -> String {
    if path.is_empty() {
        return name.to_owned();
    }
    format!("{path}.{name}")
}

fn absent(spec: &Spec, path: &str) -> bool {
    spec.rules
        .iter()
        .any(|(target, rule)| *target == path && *rule == Rule::Absent)
}

fn required(spec: &Spec, path: &str) -> bool {
    spec.rules
        .iter()
        .any(|(target, rule)| *target == path && *rule == Rule::Required)
}

fn pattern(prefix: &str, max: usize, session: bool) -> JsonValue {
    object([
        ("type", string("string")),
        ("minLength", JsonValue::Number(1.0)),
        ("maxLength", JsonValue::Number(max as f64)),
        (
            "pattern",
            string(&if session {
                "^ses[A-Za-z0-9_-]+$".to_owned()
            } else {
                format!("^{prefix}[A-Za-z0-9_-]+$")
            }),
        ),
    ])
}

fn text_schema(max: u32) -> JsonValue {
    object([
        ("type", string("string")),
        ("minLength", JsonValue::Number(1.0)),
        ("maxLength", JsonValue::Number(f64::from(max))),
    ])
}

fn record(properties: Vec<(&str, JsonValue)>, required: Vec<&str>) -> JsonValue {
    let mut schema = ycoding_core::ycoding_schema::JsonObject::new();
    schema.insert("type".into(), string("object"));
    let mut fields = ycoding_core::ycoding_schema::JsonObject::new();
    for (name, value) in properties {
        fields.insert(name.into(), value);
    }
    schema.insert("properties".into(), JsonValue::Object(fields));
    if !required.is_empty() {
        schema.insert(
            "required".into(),
            JsonValue::Array(required.into_iter().map(string).collect()),
        );
    }
    schema.insert("additionalProperties".into(), JsonValue::Bool(false));
    JsonValue::Object(schema)
}

pub(super) fn listing() -> JsonValue {
    JsonValue::Array(
        specs()
            .iter()
            .map(|spec| {
                let tool = object([
                    ("name", string(spec.tool.name)),
                    ("description", string(spec.description)),
                    ("inputSchema", spec.schema.clone()),
                    (
                        "annotations",
                        object([
                            ("readOnlyHint", JsonValue::Bool(!spec.tool.mutation)),
                            (
                                "destructiveHint",
                                JsonValue::Bool(if spec.tool.name.starts_with("local_app_") {
                                    matches!(
                                        spec.tool.operation,
                                        Some("local.app.revoke" | "local.app.http")
                                    )
                                } else {
                                    spec.tool.mutation
                                }),
                            ),
                            (
                                "idempotentHint",
                                JsonValue::Bool(if spec.tool.name.starts_with("local_app_") {
                                    matches!(
                                        spec.tool.operation,
                                        Some(
                                            "local.app.list"
                                                | "local.app.status"
                                                | "local.app.revoke"
                                        )
                                    )
                                } else {
                                    !spec.tool.mutation
                                }),
                            ),
                            ("openWorldHint", JsonValue::Bool(false)),
                        ]),
                    ),
                ]);
                if let Some(descriptor) = spec
                    .descriptor
                    .filter(|descriptor| descriptor.diagnostic_name.starts_with("artifact.demo."))
                {
                    let tool = super::json::extend(
                        tool,
                        vec![(
                            "outputSchema",
                            message_schema(&descriptor.result_type, "", spec, &mut Vec::new()),
                        )],
                    );
                    if spec.tool.name == "artifact_demo_preview" {
                        return super::json::extend(
                            tool,
                            vec![(
                                "_meta",
                                object([(
                                    "ui",
                                    object([("resourceUri", string(super::resources::HTML_URI))]),
                                )]),
                            )],
                        );
                    }
                    return tool;
                }
                if spec.tool.name == "local_app_open" {
                    return super::json::extend(
                        tool,
                        vec![(
                            "_meta",
                            object([(
                                "ui",
                                object([(
                                    "resourceUri",
                                    string(super::super::local_apps::PREVIEW_URI),
                                )]),
                            )]),
                        )],
                    );
                }
                tool
            })
            .collect(),
    )
}
