use ycoding_core::{
    coordination::{self, OwnerInput, Role, Service},
    event_feed::Feed,
};
use ycoding_schema::{
    DomainDecode, LosslessString, Nullable, coordination as c, parse_json, session,
};
use ycoding_store::{
    KeyPart, Metadata, Options, Store,
    native::{self, DatabaseKind},
    project, session as tables, tuple_key,
};

fn key(id: &str) -> Vec<u8> {
    tuple_key(&[KeyPart::String(&id.into())])
}
fn row(id: &str) -> tables::Session {
    tables::Session {
        id: id.into(),
        project_id: "prj_coord".into(),
        workspace_id: None,
        parent_id: None,
        fork_session_id: None,
        fork_message_id: None,
        fork_seq: None,
        directory: "/synthetic".into(),
        path: None,
        title: id.into(),
        cost: 0.0,
        tokens_input: 0,
        tokens_output: 0,
        tokens_reasoning: 0,
        tokens_cache_read: 0,
        tokens_cache_write: 0,
        revert: None,
        permission: None,
        autonomy: None,
        autonomy_revision: 0,
        orchestration_revision: 0,
        agent: None,
        model: None,
        profile_binding: None,
        daybreak: None,
        time_created: 1,
        time_updated: 1,
        time_archived: None,
        time_active: None,
        time_pinned: None,
        time_suspended: None,
        usage_pruned_through: None,
        origin: None,
        scope: "bound".into(),
    }
}
fn fixture() -> (Store, Service, Feed) {
    let store = Store::disposable(
        Options::core(),
        native::catalog(DatabaseKind::Core),
        Metadata::new([31; 16], 1),
    )
    .unwrap();
    store
        .submit(|tx| {
            project::ProjectTable::insert(
                tx,
                &project::Project {
                    id: "prj_coord".into(),
                    worktree: "/synthetic".into(),
                    vcs: None,
                    name: None,
                    icon_url: None,
                    icon_url_override: None,
                    icon_color: None,
                    time_created: 1,
                    time_updated: 1,
                    time_initialized: None,
                    sandboxes: vec![],
                    commands: None,
                },
            )?;
            for id in [
                "ses_master",
                "ses_member",
                "ses_other",
                "ses_supervisor",
                "ses_grandchild",
            ] {
                let mut r = row(id);
                if id == "ses_supervisor" {
                    r.parent_id = Some("ses_master".into());
                }
                if id == "ses_grandchild" {
                    r.parent_id = Some("ses_supervisor".into());
                }
                tables::SessionTable::insert(tx, &r)?;
            }
            Ok(())
        })
        .unwrap()
        .wait()
        .unwrap();
    let feed = Feed::attach(&store.client());
    let service = Service::new(store.client(), feed.clone());
    (store, service, feed)
}
fn input(master: &str, members: &[&str]) -> c::CreateInput {
    c::CreateInput {
        name: "Synthetic".into(),
        master_session_id: session::Id::new(master).unwrap(),
        member_session_ids: members
            .iter()
            .map(|id| session::Id::new(*id).unwrap())
            .collect(),
    }
}
fn update(revision: i64) -> c::UpdateInput {
    c::UpdateInput {
        revision: c::Revision::new(revision).unwrap(),
        name: None,
        master_session_id: None,
        member_session_ids: None,
        settings: None,
    }
}

#[tokio::test]
async fn defaults_replacement_cas_and_restart_are_observable_without_rewriting_rows() {
    let (store, service, feed) = fixture();
    let group = service
        .create(input("ses_master", &["ses_member"]))
        .await
        .unwrap();
    assert!(!group.active);
    assert_eq!(group.paused_reason, None);
    assert_eq!(group.settings.concurrency, Nullable::Null);
    let mut change = update(0);
    change.settings = Some(
        c::GroupSettings::decode(
            &parse_json(r#"{"concurrency":2,"delegatedDecisions":{"categories":["question"]}}"#)
                .unwrap(),
        )
        .unwrap(),
    );
    let changed = service.update(&group.id, change).await.unwrap();
    assert_eq!(changed.revision.get(), 1);
    let mut replacement = update(1);
    replacement.settings = Some(c::GroupSettings {
        concurrency: Nullable::Null,
        delegated_decisions: None,
    });
    service.update(&group.id, replacement).await.unwrap();
    let watermark = feed.watermark();
    assert_eq!(
        service
            .update(&group.id, update(1))
            .await
            .unwrap_err()
            .reason(),
        Some("Coordination.ConflictError")
    );
    assert_eq!(feed.watermark(), watermark);
    let saved = store
        .snapshot()
        .unwrap()
        .get::<ycoding_store::coordination::GroupTable>(&key(group
            .id
            .as_lossless()
            .as_str()
            .unwrap()))
        .unwrap()
        .unwrap();
    service.activate(&group.id).unwrap();
    assert!(service.get(&group.id).unwrap().active);
    service.pause(&group.id).unwrap();
    assert_eq!(
        service.get(&group.id).unwrap().paused_reason,
        Some(c::PausedReason::Interrupted)
    );
    let restarted = Service::new(store.client(), feed);
    assert_eq!(
        restarted.get(&group.id).unwrap().paused_reason,
        Some(c::PausedReason::Interrupted)
    );
    assert!(!restarted.get(&group.id).unwrap().active);
    assert_eq!(
        store
            .snapshot()
            .unwrap()
            .get::<ycoding_store::coordination::GroupTable>(&key(group
                .id
                .as_lossless()
                .as_str()
                .unwrap()))
            .unwrap(),
        Some(saved)
    );
}

#[tokio::test]
async fn subagent_launches_are_blocked_only_while_their_project_is_inactive() {
    let (_store, service, _feed) = fixture();
    let group = service
        .create(input("ses_master", &["ses_member"]))
        .await
        .unwrap();
    let block = |id: &str| {
        coordination::runtime::subagent_launch_block(&service, &session::Id::new(id).unwrap())
    };
    for id in ["ses_master", "ses_member"] {
        assert_eq!(
            block(id).as_deref(),
            Some(coordination::runtime::INACTIVE_MESSAGE)
        );
    }
    assert_eq!(block("ses_outside"), None);
    service.activate(&group.id).unwrap();
    for id in ["ses_master", "ses_member", "ses_outside"] {
        assert_eq!(block(id), None);
    }
    service.pause(&group.id).unwrap();
    assert_eq!(
        block("ses_member").as_deref(),
        Some(coordination::runtime::INACTIVE_MESSAGE)
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn pausing_by_session_requires_the_master_and_persists_without_a_run() {
    let (store, service, feed) = fixture();
    let group = service
        .create(input("ses_master", &["ses_member"]))
        .await
        .unwrap();
    service.activate(&group.id).unwrap();

    for id in ["ses_member", "ses_supervisor", "ses_other"] {
        service
            .pause_master(&session::Id::new(id).unwrap())
            .unwrap();
        assert!(service.get(&group.id).unwrap().active);
    }

    service.pause_master(&group.master_session_id).unwrap();
    assert!(!service.get(&group.id).unwrap().active);
    let reopened = Service::new(store.client(), feed);
    let paused = reopened.get(&group.id).unwrap();
    assert!(!paused.active);
    assert_eq!(paused.paused_reason, Some(c::PausedReason::Interrupted));
    reopened.activate(&group.id).unwrap();
    let active = reopened.get(&group.id).unwrap();
    assert!(active.active);
    assert_eq!(active.paused_reason, None);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn competing_updates_append_one_changed_event_and_feed_only_after_commit() {
    let (store, service, feed) = fixture();
    let group = service.create(input("ses_master", &[])).await.unwrap();
    let watermark = feed.watermark();
    let start = tokio::sync::Barrier::new(2);
    let (a, b) = tokio::join!(
        async {
            start.wait().await;
            service.update(&group.id, update(0)).await
        },
        async {
            start.wait().await;
            service.update(&group.id, update(0)).await
        }
    );
    assert_eq!(usize::from(a.is_ok()) + usize::from(b.is_ok()), 1);
    assert_eq!(service.get(&group.id).unwrap().revision.get(), 1);
    assert_eq!(feed.watermark(), watermark + 2);
    let prefix = key(group.id.as_lossless().as_str().unwrap());
    let events = store
        .snapshot()
        .unwrap()
        .index_range::<tables::EventTable>(
            "event_aggregate_seq_idx",
            ycoding_store::IndexQuery {
                lower: std::ops::Bound::Unbounded,
                upper: std::ops::Bound::Unbounded,
                prefix: Some(&prefix),
                order: ycoding_store::IndexOrder::Ascending,
                after: None,
                limit: 16,
            },
        )
        .unwrap();
    assert_eq!(events.len(), 2);
    assert_eq!(
        events[1].record.type_.as_str(),
        Some("coordination.group.changed.1")
    );
}

#[tokio::test]
async fn ownership_is_exact_and_release_revokes_supervisor_not_executor_inheritance() {
    let (store, service, _) = fixture();
    let group = service
        .create(input("ses_master", &["ses_member"]))
        .await
        .unwrap();
    let master = session::Id::new("ses_master").unwrap();
    let supervisor = session::Id::new("ses_supervisor").unwrap();
    let member = session::Id::new("ses_member").unwrap();
    let grandchild = session::Id::new("ses_grandchild").unwrap();
    service
        .set_owner(
            &group.id,
            OwnerInput {
                session_id: member.clone(),
                owner_session_id: Some(supervisor.clone()),
                reason: None,
            },
        )
        .await
        .unwrap();
    assert_eq!(
        service.access_of(&supervisor).unwrap().unwrap().role,
        Role::Supervisor
    );
    assert_eq!(
        service.access_of(&grandchild).unwrap().unwrap().role,
        Role::Executor
    );
    assert_eq!(service.get(&group.id).unwrap().revision.get(), 0);
    let id = group.id.clone();
    let (owner, target) = (supervisor.clone(), member.clone());
    store
        .submit(move |tx| coordination::authority::authorize_member_in(tx, &owner, &target, &id))
        .unwrap()
        .wait()
        .unwrap();
    let id = group.id.clone();
    let target = member.clone();
    assert!(
        store
            .submit(move |tx| coordination::authority::authorize_member_in(
                tx,
                &grandchild,
                &target,
                &id
            ))
            .unwrap()
            .wait()
            .is_err()
    );
    service
        .set_owner(
            &group.id,
            OwnerInput {
                session_id: member.clone(),
                owner_session_id: None,
                reason: Some(c::ReleaseReason::Released),
            },
        )
        .await
        .unwrap();
    assert_eq!(
        service.access_of(&supervisor).unwrap().unwrap().role,
        Role::Executor
    );
    let id = group.id.clone();
    let target = member.clone();
    assert!(
        store
            .submit(move |tx| coordination::authority::authorize_member_in(
                tx,
                &supervisor,
                &target,
                &id
            ))
            .unwrap()
            .wait()
            .is_err()
    );
    let id = group.id;
    store
        .submit(move |tx| coordination::authority::authorize_member_in(tx, &master, &member, &id))
        .unwrap()
        .wait()
        .unwrap();
}

#[tokio::test]
async fn archived_retention_is_not_new_admission_and_foreign_directory_projects_are_allowed() {
    let (store, service, _) = fixture();
    store
        .submit(|tx| {
            let mut other = row("ses_member");
            other.directory = "/another".into();
            tables::SessionTable::put(tx, &other)
        })
        .unwrap()
        .wait()
        .unwrap();
    let group = service
        .create(input("ses_master", &["ses_member"]))
        .await
        .unwrap();
    store
        .submit(|tx| {
            let mut archived = row("ses_member");
            archived.time_archived = Some(3);
            tables::SessionTable::put(tx, &archived)
        })
        .unwrap()
        .wait()
        .unwrap();
    assert_eq!(service.get(&group.id).unwrap().member_session_ids.len(), 1);
    service.activate(&group.id).unwrap();
    let other = session::Id::new("ses_other").unwrap();
    let added = service
        .add_member(&group.id, other.clone(), None, true)
        .await
        .unwrap();
    assert!(added.active);
    assert_eq!(added.master_session_id, group.master_session_id);
    assert!(added.member_session_ids.contains(&other));
    assert!(
        added
            .member_session_ids
            .contains(&group.member_session_ids[0])
    );
    let mut replacement = update(1);
    replacement.member_session_ids = Some(group.member_session_ids.clone());
    service.update(&group.id, replacement).await.unwrap();
    let mut replacement = update(2);
    replacement.member_session_ids = Some(added.member_session_ids);
    assert!(service.update(&group.id, replacement).await.unwrap().active);
    for id in ["ses_master", "ses_other"] {
        let session = store
            .snapshot()
            .unwrap()
            .get::<tables::SessionTable>(&key(id))
            .unwrap()
            .unwrap();
        assert!(session.parent_id.is_none() && session.time_archived.is_none());
    }
    service.delete(&group.id).await.unwrap();
    assert!(
        store
            .snapshot()
            .unwrap()
            .get::<tables::SessionTable>(&key("ses_member"))
            .unwrap()
            .is_some()
    );
}

#[test]
fn role_instruction_revocation_is_explicit() {
    let master = coordination::instructions::initial(Role::Master, true);
    let revoked = coordination::instructions::changed(&master, Role::Executor, false);
    assert!(revoked.as_str().unwrap().contains("no longer applies"));
    assert!(revoked.as_str().unwrap().contains("executor"));
    let released = coordination::instructions::changed(&master, Role::Executor, true);
    assert!(released.as_str().unwrap().contains("no longer applies"));
    assert!(
        released
            .as_str()
            .unwrap()
            .contains("Project role: Master's subagent. You make no Project changes")
    );
    assert!(
        coordination::instructions::removed()
            .as_str()
            .unwrap()
            .contains("Disregard")
    );
}

#[tokio::test]
async fn coordination_instruction_release_text_matches_every_role_and_revocation() {
    use ycoding_core::instructions::Observation;
    let digest = |text: &LosslessString| {
        ring::digest::digest(&ring::digest::SHA256, text.to_utf8().unwrap().as_bytes())
            .as_ref()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()
    };
    let cases = [
        (
            Role::Master,
            false,
            "6644dd91dd46c73fe608230d99d441f3481c76be06aef6fa82fbe09ea55f4c6e",
        ),
        (
            Role::Master,
            true,
            "6644dd91dd46c73fe608230d99d441f3481c76be06aef6fa82fbe09ea55f4c6e",
        ),
        (
            Role::Supervisor,
            false,
            "2a4b52dd4547c084c87b9075a5ab34216a36429685c8349402eb4f8c74263037",
        ),
        (
            Role::Supervisor,
            true,
            "2a4b52dd4547c084c87b9075a5ab34216a36429685c8349402eb4f8c74263037",
        ),
        (
            Role::Executor,
            false,
            "1e2512b1b6bfcbd0f5645a76ef5f53077415c6b14af0dfaf1de868b827323720",
        ),
        (
            Role::Executor,
            true,
            "3a0a9b4b59b0ded0661266ec9965b4a35f278a7afb7cfa29a1840291acf3d65f",
        ),
    ];
    let master = coordination::instructions::initial(Role::Master, false);
    for (role, coordinating, expected) in cases {
        let source = coordination::instructions::source(role, coordinating);
        let Observation::Value(value) = (source.read)().await.unwrap() else {
            panic!()
        };
        let initial = (source.initial)(&value).unwrap();
        assert_eq!(digest(&initial), expected, "{role:?}, {coordinating}");
        assert_eq!((source.changed)(&value, &value).unwrap(), initial);
        if role == Role::Executor {
            let previous = ycoding_schema::JsonValue::String(master.clone());
            let expected = if coordinating {
                "c041987d38cfa740ce9e90c29299b41eaa18739ac350226615b89c0276e3d410"
            } else {
                "31f6a7cb37b6d532d3f23f933c548ab1244c713d4f30b1a47fb9adfdf4500bf7"
            };
            assert_eq!(
                digest(&(source.changed)(&previous, &value).unwrap()),
                expected
            );
        }
        assert_eq!(
            digest(&(source.removed.as_ref().unwrap())(&value).unwrap()),
            "4f028f721afa1d5f93762294ffe477e63c075a6fca47a4a0ffa99732a12d4c49"
        );
    }
}

fn once(value: &LosslessString, text: &str) {
    assert_eq!(
        (text, value.as_str().unwrap().split(text).count()),
        (text, 2)
    );
}

#[test]
fn member_assignments_and_executor_guidance_scale_disjoint_lanes_to_the_work() {
    for role in [Role::Master, Role::Supervisor, Role::Executor] {
        let value = coordination::instructions::initial(role, false);
        for clause in [
            "Scale executor subagent fanout from 0..5 across genuinely disjoint file and check lanes",
            "Keep small or coupled work in one Session",
            "Never introduce ceremony, handoffs, slots, or resource-limitation throttling; run independent builds, typechecks, and selected checks directly in parallel.",
        ] {
            once(&value, clause);
        }
        let text = value.as_str().unwrap();
        assert!(text.contains("one writer per file"));
        for stale in [
            "require five subagents",
            "run five subagents",
            "at most one heavy build",
        ] {
            assert!(!text.contains(stale), "{stale}");
        }
    }
}

#[test]
fn every_role_honors_explicit_main_agent_versus_subagent_model_and_profile_splits() {
    let split = "Honor explicit main-agent versus subagent provider, model, variant, and profile splits: keep the main Session on its designated model and profile, switch active direct children and launch subagents on their designated subagent model and profile, and substitute no other profile.";
    for role in [Role::Master, Role::Supervisor, Role::Executor] {
        let value = coordination::instructions::initial(role, false);
        once(&value, split);
        assert!(
            value
                .as_str()
                .unwrap()
                .contains("Scale executor subagent fanout from 0..5 across genuinely disjoint file and check lanes")
        );
    }
    assert!(
        !coordination::instructions::initial(Role::Executor, true)
            .as_str()
            .unwrap()
            .contains("provider, model, variant, and profile splits")
    );
}

#[test]
fn coordination_guidance_preserves_owner_routing_native_gates_and_complete_delivery() {
    for role in [Role::Master, Role::Supervisor] {
        let value = coordination::instructions::initial(role, false);
        for clause in [
            "When the coordinator is instructed to do project work, delegate it.",
            "As Master, decompose the user's work into independent scopes without waiting to be asked and delegate each scope (including single-member work) to the appropriate supervisor/owner, using `assign` to establish or transfer supervisor ownership.",
            "The supervising owner resolves the target repository's folder, its canonical checkout or a designated managed worktree, before enrollment. Create each repository member with `directory` placement at that folder, never at the Project's folder unless it is the same repository.",
            "verify that its Location is the target repository's folder: its canonical checkout or one of its managed worktrees. Never place a member at the Project's folder unless that folder is the same repository.",
            "Reserve `~/.local/share/ycoding/tasks/` for scratch files, logs, and evidence; never use it or any subdirectory of it as a Project member Location, in any case.",
            "Pass exactly one placement: `directory` with an absolute or home-relative path for an explicit folder, such as the target repository's canonical checkout, an existing managed worktree or a non-Git Project folder; `projectID` for a repository Project's canonical checkout; or `name` with an explicit `repository` for a new managed worktree.",
            "The Master performs the required native `project create` with the resolved placement and `ownerSessionID`, without a `prompt`.",
            "Settle routine member requests through `project answer` within recorded authority in every autonomy mode, Manual included.",
            "Decline an unsafe request when the native control permits it.",
            "Deny rules and permission ceilings still hold",
            "preserve Session and Project histories intact without deleting history as cleanup",
            "unfinished member work or pending family requests stay open with their recorded owner until settled",
            "Start ready work immediately as soon as its inputs are final, without slots, handoffs, ceremony, or resource-limitation waits.",
            "Never attribute a one-lane pause or your own scheduling to the human, and never hold members on ceremony, handoffs, slots, or resource-limitation waits.",
        ] {
            once(&value, clause);
        }
        for stale in [
            "launch an owner subagent for each",
            "Select the existing Project for the work",
        ] {
            assert!(!value.as_str().unwrap().contains(stale), "{stale}");
        }
    }
    for role in [Role::Master, Role::Supervisor, Role::Executor] {
        let value = coordination::instructions::initial(role, false);
        for clause in [
            "evidence directly as command + exit code + pass/fail counts + commit or diff stat.",
            "Never create REPORT.md, HANDOFF.md, RECEIPT.md, RECEIPT.json, owner-handoff.md or SHA-256 manifest artifacts unless the user explicitly requests a file artifact.",
            "Never follow up solely to request a report file or restate receipts.",
            "Reject unrequested synthetic viewport/theme combinatoric matrices.",
            "consolidated selected checks → single commit → linear rebase onto the latest target head → ff-only merge → safe non-force worktree removal, without ceremony, handoffs, or slots.",
            "automatically rebase disjoint target advances without target-hash questions, and escalate overlapping file conflicts or failing checks.",
            "These instructions authorize no integration action by themselves",
        ] {
            once(&value, clause);
        }
        for stale in [
            "Serialize heavy builds",
            "within bounded memory",
            "intermediate handoff approvals",
        ] {
            assert!(!value.as_str().unwrap().contains(stale), "{stale}");
        }
    }
    let master = coordination::instructions::initial(Role::Master, false);
    assert!(
        master
            .as_str()
            .unwrap()
            .split("\n\n")
            .next()
            .unwrap()
            .contains("Assign and transfer supervisor ownership")
    );
    let supervisor = coordination::instructions::initial(Role::Supervisor, false);
    assert!(
        supervisor
            .as_str()
            .unwrap()
            .split("\n\n")
            .next()
            .unwrap()
            .contains("you cannot call the `project` tool's Master-only create, attach, assign (including transfers), release, or remove operations.")
    );
}

#[test]
fn project_owners_and_executors_recover_within_their_roles_before_escalating_unresolved_work() {
    for role in [Role::Master, Role::Supervisor, Role::Executor] {
        let value = coordination::instructions::initial(role, false);
        for rule in [
            "Obey the user's explicit directives and never argue with the user; state a verified technical risk plainly once if needed, then execute the chosen direction.",
            "Work fast, reliably, and proactively toward the user's goal: decide reversible local choices from evidence and exhaust compliant local diagnosis and recovery on errors, conflicts, and failing checks before escalating.",
            "Use live evidence and permitted tools to settle routine choices within your authority.",
            "Keep independent authorized work moving while an affected lane waits.",
            "Report a blocker only after reasonable recovery, naming the blocked action and target, verified evidence, and the decision or input needed.",
            "Honor explicit pauses and cancellations.",
            "Preserve model, provider, profile, tool, toolchain and filesystem limits, protect secrets, and stay within authorized side effects.",
            "Honor permission rules, denies, ceilings, guardrails and hard reviews.",
            "Use native controls for required approvals; never bypass a refusal or treat silence as consent.",
            "Never replay an uncertain action.",
        ] {
            once(&value, rule);
        }
        let recovery = if role == Role::Executor {
            "Resolve recoverable conflicts and failing checks before escalating. Drive the assignment to verified completion without waiting for status nudges or extra approvals."
        } else {
            "Have member owners resolve recoverable conflicts and failing checks before escalating. Drive assignments to verified completion without status nudges or extra approvals."
        };
        once(&value, recovery);
        let text = value.as_str().unwrap();
        assert!(
            text.find(recovery).unwrap()
                < text
                    .find("and escalate overlapping file conflicts or failing checks.")
                    .unwrap(),
            "{role:?}"
        );
    }
}

#[test]
fn coordination_routes_member_lifecycle_through_the_owner_and_excludes_standalone_storage() {
    let master = coordination::instructions::initial(Role::Master, false);
    for text in [
        "Use `assign` only to establish or transfer ownership to a live supervisor subagent the Master launched; keep read-only oversight, escalations and integration review at the Master.",
        "A supervisor cannot call the `project` tool's Master-only create, attach, assign (including transfers), release, or remove operations; within authorized routes, a supervisor reuses a suitable owned member when available and steers, updates, or acts on owned member Sessions via `send`, `model`, `answer`, `inspect`, `escalate`, `interrupt`, and `list`.",
        "Sessions with `scope: standalone` are internal restricted storage, never Project members.",
    ] {
        once(&master, text);
    }
    assert!(
        !master
            .as_str()
            .unwrap()
            .contains("member Sessions are standalone root Sessions")
    );
    let prefix = |role| {
        let value = coordination::instructions::initial(role, false)
            .to_utf8()
            .unwrap();
        value[..value.find("Coordinate and supervise only").unwrap()].to_owned()
    };
    assert!(prefix(Role::Master).contains("Route Project work through recorded owners"));
    assert!(!prefix(Role::Supervisor).contains("`attach`"));
    assert!(
        !coordination::instructions::initial(Role::Executor, false)
            .as_str()
            .unwrap()
            .contains("`attach`")
    );
}

struct Controls;
impl coordination::runtime::Decisions for Controls {
    fn settings(&self) -> coordination::runtime::Future<'_, c::Settings> {
        Box::pin(async {
            Ok(c::Settings {
                enabled: true,
                categories: vec![c::RequestKind::Permission],
                actions: None,
                resources: None,
                expires_at: None,
            })
        })
    }
    fn pending(
        &self,
        input: coordination::runtime::PendingInput,
    ) -> coordination::runtime::Future<'_, Vec<coordination::runtime::Pending>> {
        Box::pin(async move {
            use coordination::runtime::{Delegation, Pending, RequestDetail};
            if input.target_session_id.as_lossless().as_str() != Some("ses_member") {
                return Ok(vec![]);
            }
            Ok(vec![Pending {
                summary: c::PendingRequest {
                    kind: c::RequestKind::Permission,
                    request_id: "per_native".into(),
                    fingerprint: "fingerprint".into(),
                    summary: "shell: synthetic-resource".into(),
                    request_session_id: None,
                },
                detail: RequestDetail::Permission {
                    request_id: "per_native".into(),
                    fingerprint: "fingerprint".into(),
                    action: "shell".into(),
                    resources: vec!["synthetic-resource".into()],
                    delegation: Delegation::Routine,
                    coordination_escalation: None,
                    request_session_id: None,
                },
            }])
        })
    }
    fn evaluate(
        &self,
        _input: coordination::runtime::EvaluateInput,
    ) -> coordination::runtime::Future<'_, coordination::runtime::DecisionResult> {
        Box::pin(async {
            Err(coordination::Error::refused(
                "settlement is outside this projection fixture",
            ))
        })
    }
    fn escalate(
        &self,
        _input: coordination::runtime::DecisionEscalateInput,
    ) -> coordination::runtime::Future<'_, coordination::runtime::DecisionEscalateResult> {
        Box::pin(async {
            Err(coordination::Error::refused(
                "settlement is outside this projection fixture",
            ))
        })
    }
}
struct NoWake(std::sync::Arc<std::sync::atomic::AtomicUsize>);
impl ycoding_core::session::execution::Locations for NoWake {
    fn get(
        &self,
        _session: &ycoding_schema::session::Info,
    ) -> Result<
        std::sync::Arc<dyn ycoding_core::session::execution::Runner>,
        ycoding_core::session::run_coordinator::Error,
    > {
        self.0.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        Err(ycoding_core::session::run_coordinator::Error::Runner(
            ycoding_schema::session_error::Error {
                r#type: "unknown".into(),
                message: "paused delivery must not invoke a runner".into(),
            },
        ))
    }
}
fn member_event(store: &Store, id: &str, kind: &str, created: i64) -> tables::Event {
    use ycoding_schema::ObjectEncoder;
    let request = tables::NewEvent {
        id: id.into(),
        aggregate_id: "ses_member".into(),
        created,
        type_: kind.into(),
        data: ObjectEncoder::new()
            .field("sessionID", &session::Id::new("ses_member").unwrap())
            .finish(),
    };
    store
        .submit(move |tx| {
            let tables::Append::Appended(event) = tables::append(tx, &request, None)? else {
                return Err(ycoding_store::Error::Rejected("expected fixture event"));
            };
            Ok(event)
        })
        .unwrap()
        .wait()
        .unwrap()
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn runtime_projects_controls_revokes_owner_authority_and_replays_without_waking() {
    use coordination::runtime::{InspectInput, Options, ReleaseInput, Runtime};
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };
    use ycoding_core::{
        event_feed::Payload,
        job,
        session::{execution::Execution, store::Service as SessionStore},
    };
    let (store, coordination, _feed) = fixture();
    member_event(
        &store,
        "evt_before_membership",
        "session.execution.started.1",
        1,
    );
    let group = coordination
        .create(input("ses_master", &["ses_member"]))
        .await
        .unwrap();
    let sessions = SessionStore::new(store.client());
    let jobs = job::Jobs::new();
    let wakes = Arc::new(AtomicUsize::new(0));
    let execution = Execution::install(
        sessions.clone(),
        Arc::new(NoWake(wakes.clone())),
        jobs.clone(),
        None,
    )
    .unwrap();
    let runtime = Runtime::new(Options {
        coordination: coordination.clone(),
        sessions: sessions.clone(),
        execution,
        decisions: Arc::new(Controls),
        jobs,
        validate_model: Arc::new(|_, _| {
            Box::pin(async {
                Err(coordination::Error::refused(
                    "model validation is outside this projection fixture",
                ))
            })
        }),
        model_services: Arc::new(|_| {
            Box::pin(async {
                Err(coordination::Error::refused(
                    "model switching is outside this projection fixture",
                ))
            })
        }),
        creator: None,
    });
    let master = session::Id::new("ses_master").unwrap();
    let member = session::Id::new("ses_member").unwrap();
    let owner = session::Id::new("ses_supervisor").unwrap();
    let child = session::Id::new("ses_grandchild").unwrap();
    let info = runtime.get(&group.id).await.unwrap();
    assert_eq!(info.master.state, c::MemberState::Idle);
    assert_eq!(info.members[0].state, c::MemberState::Waiting);
    assert_eq!(info.members[0].pending.len(), 1);
    assert!(runtime.settings().await.unwrap().enabled);
    let inspect = || InspectInput {
        session_id: member.clone(),
        request_id: "per_native".into(),
    };
    assert!(runtime.inspect(&master, inspect()).await.is_ok());
    assert!(runtime.inspect(&child, inspect()).await.is_err());
    assert!(runtime.roster(&member).await.is_err());
    coordination
        .set_owner(
            &group.id,
            OwnerInput {
                session_id: member.clone(),
                owner_session_id: Some(owner.clone()),
                reason: None,
            },
        )
        .await
        .unwrap();
    assert!(runtime.inspect(&owner, inspect()).await.is_ok());
    assert!(runtime.inspect(&child, inspect()).await.is_err());
    assert!(
        runtime
            .release(
                &owner,
                ReleaseInput {
                    session_id: member.clone(),
                    reason: c::ReleaseReason::Released,
                },
            )
            .await
            .is_err(),
        "only the Master releases member ownership"
    );
    runtime
        .release(
            &master,
            ReleaseInput {
                session_id: member.clone(),
                reason: c::ReleaseReason::Released,
            },
        )
        .await
        .unwrap();
    assert!(runtime.inspect(&owner, inspect()).await.is_err());
    assert!(
        runtime.get(&group.id).await.unwrap().members[0]
            .owner
            .is_none()
    );
    let started = member_event(
        &store,
        "evt_runtime_started",
        "session.execution.started.1",
        chrono::Utc::now().timestamp_millis(),
    );
    runtime
        .handle(&Payload::Durable(started.clone()))
        .await
        .unwrap();
    runtime.handle(&Payload::Durable(started)).await.unwrap();
    assert_eq!(
        sessions.pending_list(&master).unwrap().len(),
        0,
        "unowned routine state is held, not delivered to the Master"
    );
    member_event(
        &store,
        "evt_runtime_progress",
        "session.step.ended.1",
        chrono::Utc::now().timestamp_millis(),
    );
    runtime.recover().await.unwrap();
    runtime.recover().await.unwrap();
    let notices = sessions.pending_list(&master).unwrap();
    assert_eq!(
        notices.len(),
        1,
        "startup hands the surviving pending request to the Master once"
    );
    assert!(
        notices
            .iter()
            .all(|notice| notice.type_.as_str() == Some("synthetic"))
    );
    let ycoding_schema::JsonValue::Object(data) = &notices[0].data else {
        panic!("notice data must be an object")
    };
    let Some(ycoding_schema::JsonValue::Object(metadata)) = data.get(&"metadata".into()) else {
        panic!("notice metadata must be an object")
    };
    assert_eq!(
        metadata
            .get(&"source".into())
            .and_then(|value| match value {
                ycoding_schema::JsonValue::String(text) => text.as_str(),
                _ => None,
            }),
        Some("project_escalation")
    );
    execution.await_idle(&master).await;
    assert_eq!(wakes.load(Ordering::SeqCst), 0);
    assert!(execution.active().is_empty());
    let mut removed = update(0);
    removed.member_session_ids = Some(vec![]);
    coordination.update(&group.id, removed).await.unwrap();
    member_event(
        &store,
        "evt_after_removal",
        "session.step.ended.1",
        chrono::Utc::now().timestamp_millis(),
    );
    runtime.recover().await.unwrap();
    assert_eq!(sessions.pending_list(&master).unwrap().len(), 1);
    execution.shutdown().await.unwrap();
}
#[test]
fn coordinators_delegate_all_project_work_without_direct_master_defaults() {
    let rule = "When the coordinator is instructed to do project work, delegate it. The master coordinates and delegates to the appropriate supervisor/owner; that supervisor creates, updates, or steers suitable member sessions, and those members execute, verify, and deliver. The master does not do project work or directly create, steer, update, or manage member sessions.";
    for role in [Role::Master, Role::Supervisor] {
        let value = coordination::instructions::initial(role, false);
        once(&value, rule);
        for stale in [
            "Default to direct Master",
            "more than three long-running parallel members",
            "Directly manage Sessions owned by the Master",
            "give each scope its own member Session through `create`",
            "Create members or attach",
            "manage directly owned Sessions",
            "As Master, use `create`",
            "As Master, use `attach`",
            "Only the Master attaches Sessions",
            "only the Master uses `release`",
            "Only the Master removes a Project member",
            "optional `ownerSessionID`",
            "Send member messages yourself.",
            "Supervisors cannot create, attach, assign, transfer, release, or remove Project members.",
        ] {
            assert!(
                !value.as_str().unwrap().contains(stale),
                "{role:?}: {stale}"
            );
        }
    }
    for coordinating in [false, true] {
        assert!(
            !coordination::instructions::initial(Role::Executor, coordinating)
                .as_str()
                .unwrap()
                .contains(rule)
        );
    }
}

#[test]
fn project_roles_inherit_the_base_swarm_rule_without_separate_coordination_text() {
    use std::{collections::BTreeMap, path::Path};
    use ycoding_core::resources::{agent, config::Roots};
    let roots = Roots::runtime(
        Path::new("/home/fixture"),
        Path::new("/tmp"),
        &BTreeMap::new(),
    )
    .unwrap();
    let catalog =
        agent::builtin::catalog(&roots, ycoding_schema::session_scope::Scope::Bound).unwrap();
    let system = |id: &str| {
        catalog
            .iter()
            .find(|agent| agent.id == id.into())
            .and_then(|agent| agent.system.as_ref())
            .unwrap()
            .to_utf8()
            .unwrap()
    };
    let rule = "Default to full native Swarm execution for every Session, whether Project Master, Project member or standalone, and treat single-lane execution as the exception for indivisible or tightly coupled work.";
    let sessions = [
        ("normal", "god", None),
        ("master", "god", Some(Role::Master)),
        ("member", "zeus", Some(Role::Executor)),
    ];
    for (name, id, role) in sessions {
        let mut text = system(id);
        if let Some(role) = role {
            let injected = coordination::instructions::initial(role, false);
            let injected = injected.as_str().unwrap();
            for separate in [
                "swarm",
                "Launch every ready",
                "never launch filler",
                "native subagents and run them concurrently",
                "coordination.subagent.request.blocked",
            ] {
                assert!(!injected.contains(separate), "{name}: {separate}");
            }
            text.push_str("\n\n");
            text.push_str(injected);
        }
        assert_eq!(text.matches(rule).count(), 1, "{name}");
        assert!(
            text.find("Work agentically:").unwrap() < text.find(rule).unwrap(),
            "{name}"
        );
    }
}
