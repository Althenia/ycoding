use ycoding_core::process::guardrails::{
    CustomLayer, OutsideTarget, Paths, classify, outside_targets, semantic_resources,
    shell_file_targets,
};
use ycoding_core::tools::policy::Effect;
use ycoding_schema::{LosslessString, guardrail, schema::Int};

fn paths() -> Paths {
    Paths {
        workdir: "/workspace/project".into(),
        project: "/workspace/project".into(),
        home: "/home/operator".into(),
        tmpdir: Some("/scratch/temp".into()),
        trusted_paths: vec![],
    }
}

#[test]
fn hard_reviews_and_catastrophic_denies_are_distinct() {
    for (command, id) in [
        ("rm -rf .", "standard.review.project-deletion"),
        ("rm -rf ..", "standard.review.project-deletion"),
        ("rm -rf ~/notes", "standard.review.home-child"),
        ("git reset --hard", "standard.review.git-destructive"),
        ("git push origin main --force", "standard.review.force-push"),
        ("drop table users", "standard.review.database-destructive"),
    ] {
        let result = classify("shell", &[command.into()], &paths(), &[]);
        assert_eq!(result.effect, Effect::Ask, "{command}");
        assert!(result.hard_review, "{command}");
        assert_eq!(result.rule_ids, vec![LosslessString::from(id)], "{command}");
    }
    for command in [
        "rm -rf /",
        "rm -rf ~",
        "rm -rf /home/other",
        "rm -rf /usr",
        "mkfs.ext4 /dev/sda",
        "dd if=x of=/dev/disk1",
        ":(){ :|:& };:",
    ] {
        assert_eq!(
            classify("shell", &[command.into()], &paths(), &[]).effect,
            Effect::Deny,
            "{command}"
        );
    }
}

#[test]
fn git_rules_do_not_borrow_flags_from_other_commands_or_heredoc_text() {
    let reviewed = [
        "git push -u origin feature 2>&1 | tail -3; rm -f \"$TMPDIR/body.md\"",
        "git push origin main && grep -f patterns.txt log",
        "git push origin main\nrm -f notes.txt",
        "git restore src/a.rs; echo --worktree",
        "cat > \"$TMPDIR/body.md\" <<'EOF'\n## Summary\nUse git push for the branch, then rm -f the draft.\nEOF\ngit push -u origin feature && gh pr create --fill; rm -f \"$TMPDIR/body.md\"",
        "cat <<'EOF' > notes.md\ngit push --force origin main\ngit branch -D feature\nEOF",
    ]
    .into_iter()
    .filter_map(|command| {
        let result = classify("shell", &[command.into()], &paths(), &[]);
        (result.effect != Effect::Allow || result.hard_review || !result.rule_ids.is_empty())
            .then_some((command, result))
    })
    .collect::<Vec<_>>();
    assert!(reviewed.is_empty(), "{reviewed:#?}");
}

#[test]
fn git_operations_in_compounds_and_shell_heredocs_require_hard_review() {
    for (command, id) in [
        (
            "rm -f notes.txt; git push --force-with-lease origin main",
            "standard.review.force-push",
        ),
        (
            "cd src && git push -f origin main",
            "standard.review.force-push",
        ),
        (
            "bash <<'EOF'\ngit push origin main --force\nEOF",
            "standard.review.force-push",
        ),
        (
            "echo start | git branch -D feature",
            "standard.review.git-destructive",
        ),
        (
            "cat <<'EOF' | sh\ngit branch -D feature\nEOF",
            "standard.review.git-destructive",
        ),
        (
            "echo start; git restore src/a.rs --worktree",
            "standard.review.git-destructive",
        ),
    ] {
        let result = classify("shell", &[command.into()], &paths(), &[]);
        assert_eq!(result.effect, Effect::Ask, "{command}");
        assert!(result.hard_review, "{command}");
        assert_eq!(result.rule_ids, vec![LosslessString::from(id)], "{command}");
    }
}

#[test]
fn destructive_sql_in_heredocs_requires_hard_review() {
    for command in [
        "psql <<'SQL'\nDROP TABLE users;\nSQL",
        "sqlite3 local.db <<'SQL'\nTRUNCATE TABLE users;\nSQL",
        "cat <<'SQL' > query.sql\nDROP DATABASE production;\nSQL",
    ] {
        let result = classify("shell", &[command.into()], &paths(), &[]);
        assert_eq!(result.effect, Effect::Ask, "{command}");
        assert!(result.hard_review, "{command}");
        assert_eq!(
            result.rule_ids,
            vec![LosslessString::from("standard.review.database-destructive")],
            "{command}"
        );
    }
}

#[test]
fn shell_workdir_branches_and_temporary_operands_preserve_hard_reviews() {
    for command in [
        "cd /workspace; rm -rf project",
        "cd /tmp || rm -rf .",
        "cd /tmp; rm -rf .",
        "rm -rf /tmp .",
    ] {
        assert!(
            classify("shell", &[command.into()], &paths(), &[]).hard_review,
            "{command}"
        );
    }
    for command in [
        "cd /tmp && rm -rf .",
        "rm -rf /tmp /private/tmp /scratch/temp",
        "rm -rf $TMPDIR",
        "rm -rf ${TMPDIR}",
    ] {
        assert!(
            !classify("shell", &[command.into()], &paths(), &[]).hard_review,
            "{command}"
        );
    }
    assert_eq!(
        semantic_resources("shell", &["rm -rf /tmp; git reset --hard".into()], &paths()),
        vec![LosslessString::from("git reset --hard")]
    );
    assert!(
        semantic_resources(
            "shell",
            &["cat README.md | head -20; git status --short".into()],
            &paths()
        )
        .is_empty()
    );
    assert_eq!(
        semantic_resources("shell", &["git -c core.pager=sh log".into()], &paths()).len(),
        1
    );
}

#[test]
fn outside_targets_distinguish_directories_from_file_boundaries() {
    let targets = outside_targets("shell", &"cd /other && touch file".into(), &paths());
    assert!(
        targets
            .iter()
            .any(|item| item.path == LosslessString::from("/other") && item.directory)
    );
    assert!(
        targets
            .iter()
            .any(|item| item.path == LosslessString::from("/other/file") && !item.directory)
    );
    assert!(outside_targets("shell", &"cat /other/file".into(), &paths()).is_empty());
    assert_eq!(
        outside_targets("file_mutation", &"/other/file".into(), &paths()).len(),
        1
    );
}

fn custom(decision: guardrail::RuleDecision) -> CustomLayer {
    CustomLayer {
        rules: vec![guardrail::Rule {
            id: "custom".into(),
            source: guardrail::RuleSource::Custom,
            decision,
            actions: vec!["*".into()],
            resources: vec!["*".into()],
            reason: "review".into(),
            priority: Int::new(0).unwrap(),
        }],
        invalid_files: vec![],
    }
}

#[test]
fn custom_allow_and_invalid_layers_cannot_weaken_hard_reviews() {
    assert!(
        classify(
            "shell",
            &["rm -rf .".into()],
            &paths(),
            &[custom(guardrail::RuleDecision::Allow)]
        )
        .hard_review
    );
    assert_eq!(
        classify(
            "shell",
            &["rm -rf /".into()],
            &paths(),
            &[custom(guardrail::RuleDecision::Allow)]
        )
        .effect,
        Effect::Deny
    );
    assert_eq!(
        classify(
            "file_mutation",
            &["/other/file".into()],
            &paths(),
            &[custom(guardrail::RuleDecision::Allow)]
        )
        .effect,
        Effect::Allow
    );
    assert!(
        classify(
            "file_mutation",
            &["file".into()],
            &paths(),
            &[
                custom(guardrail::RuleDecision::Allow),
                custom(guardrail::RuleDecision::HardReview)
            ]
        )
        .hard_review
    );
    let invalid = CustomLayer {
        rules: vec![],
        invalid_files: vec!["bad.md".into()],
    };
    assert_eq!(
        classify(
            "file_mutation",
            &["file".into()],
            &paths(),
            std::slice::from_ref(&invalid)
        )
        .effect,
        Effect::Ask
    );
    assert_eq!(
        classify("read", &["file".into()], &paths(), &[invalid]).effect,
        Effect::Allow
    );
}

#[test]
fn empty_tmpdir_does_not_make_the_project_a_temporary_deletion_exemption() {
    let mut paths = paths();
    paths.tmpdir = Some("".into());
    assert!(classify("shell", &["rm -rf .".into()], &paths, &[]).hard_review);
}

fn match_paths() -> Paths {
    Paths {
        workdir: "/workspace/project".into(),
        project: "/workspace/project".into(),
        home: "/home/user".into(),
        tmpdir: None,
        trusted_paths: vec![],
    }
}

#[test]
fn home_deletion_stays_denied_around_heredocs_and_redirects() {
    for command in [
        "bash <<'EOF'\nrm -rf ~\nEOF",
        "cat <<'EOF' | sh\nrm -rf ~\nEOF",
        "rm -rf ~>/dev/null",
        "rm -rf ~ 2>&1 | tail -1",
    ] {
        let result = classify("shell", &[command.into()], &match_paths(), &[]);
        assert_eq!(result.effect, Effect::Deny, "{command}");
        assert_eq!(
            result.rule_ids,
            vec![LosslessString::from("standard.catastrophic.rm-user-home")],
            "{command}"
        );
    }
}

#[test]
fn recognized_outside_repository_paths_require_ordinary_review() {
    for (action, resource) in [
        ("file_mutation", "/outside/new.txt"),
        ("file_mutation", "../new.txt"),
        ("shell", "touch /outside/new.txt"),
        ("shell", "touch ../new.txt"),
        ("shell", "cd /outside && task-runner execute"),
        ("shell", "cd ../other; touch file"),
        ("shell", "task-runner --output=/outside/new.txt"),
        ("shell", "printf x > /outside/new.txt"),
        ("shell", "printf x 2>>/outside/new.txt"),
        ("shell", "touch '$HOME/new.txt'"),
        ("shell", "touch '${PWD}/../new.txt'"),
        ("shell", "touch ~/new.txt"),
        ("shell", "rm -f /outside/new.txt"),
        ("shell", "echo x > /outside/file"),
        ("shell", "echo x>/outside/file"),
        ("shell", "echo x &>/outside/file"),
        ("shell", "printf x >>~/outside.log"),
        ("shell", "cp a ~/outside"),
        ("shell", "echo x | tee /outside/file"),
        ("shell", "cat <<'EOF' > /outside/file\nbody\nEOF"),
        ("shell", "bash <<'EOF'\ntouch /outside/file\nEOF"),
        ("shell", "cat <<'EOF' | sh\ntouch /outside/file\nEOF"),
        ("shell", "cat <<EOF > notes.md\n$(touch /outside/file)\nEOF"),
        (
            "shell",
            "cat <<'EOF' > notes.md\nbody\nEOF\ntouch /outside/file",
        ),
        ("shell", "git -C /outside commit -m msg"),
        ("shell", "git checkout -b x /outside/file"),
        ("shell", "curl -o /outside/file https://example.com/a"),
    ] {
        let result = classify(action, &[resource.into()], &match_paths(), &[]);
        assert_eq!(result.effect, Effect::Ask, "{action} {resource}");
        assert!(!result.hard_review, "{action} {resource}");
        assert_eq!(
            result.rule_ids,
            vec![LosslessString::from("standard.review.outside-repo")],
            "{action} {resource}"
        );
    }
}

#[test]
fn repository_temporary_device_executable_text_and_read_only_paths_stay_exempt() {
    for (action, resource) in [
        ("file_mutation", "src/file"),
        ("file_mutation", "/workspace/project/file"),
        ("file_mutation", "/tmp/file"),
        ("shell", "task-runner execute"),
        ("shell", "/usr/bin/env task-runner execute"),
        ("shell", "cd src && touch ../file"),
        (
            "shell",
            "touch /tmp/file /private/tmp/file /var/tmp/file /private/var/tmp/file /var/folders/cache/file",
        ),
        ("shell", "cat /outside/file; git -C /outside status"),
        ("shell", "printf x >/dev/null"),
        ("read", "/outside/file"),
        (
            "shell",
            "cat <<'EOF' > notes.md\nSee /Users/other/repo and ~/elsewhere\nrm -rf ~\nEOF",
        ),
        (
            "shell",
            "cat <<-EOF > notes.md\n\tPlain /outside/text\n\tEOF",
        ),
        (
            "shell",
            "git add -A && git commit -q -m \"fix: handle /outside/path text\" 2>&1 | tail -3",
        ),
        ("shell", "git commit -am \"/abs text\""),
        ("shell", "git commit --message=\"/abs text\""),
        (
            "shell",
            "git commit -m \"$(cat <<'EOF'\nfix: touch /outside/file in docs\nEOF\n)\"",
        ),
        (
            "shell",
            "gh pr create --title \"/abs title\" --body \"See /outside/file\" 2>&1",
        ),
        ("shell", "gh api /repos/owner/repo/pulls > pulls.json"),
        ("shell", "echo /outside/file > notes.txt"),
        ("shell", "printf '%s\\n' /outside/a ~/b > notes.txt"),
        (
            "shell",
            "task-runner fetch https://example.com/outside/path",
        ),
        ("shell", "task-runner run 2>&1 | tail -5"),
        ("shell", "task-runner run &>/dev/null"),
    ] {
        let result = classify(action, &[resource.into()], &match_paths(), &[]);
        assert_eq!(result.effect, Effect::Allow, "{action} {resource}");
        assert!(!result.hard_review, "{action} {resource}");
        assert!(result.rule_ids.is_empty(), "{action} {resource}");
    }
}

#[test]
fn read_only_inspection_and_executed_script_paths_are_not_reviewed() {
    for command in [
        "cd /outside/review/_src && sed -n 270,290p styles/ide.css | grep -n \"grid-area\\|@container\" | cut -c1-240",
        "cd /outside/review || exit 1; git status --short | head -50; ls build 2>&1; ps -p 123 -o pid,etime,command 2>/dev/null | tail -1",
        "cd /workspace/project/crates/core && grep -n \"pub fn\" history.rs | head -60; ls ../../../store/src 2>/dev/null",
        "cd /workspace/project || exit 1; git -C /workspace/project ls-tree -r --name-only main src | grep '/restart'",
        "cd /outside/review; grep -n -i -E \"usage|--screen\" _shared/tools/dev-verify.mjs; pgrep -fl cargo; lsof -nP -iTCP:8754",
        "cd app && node -e \"console.log(1)\" | head -30; grep -n x ../../docs/specs.md | head",
        "task-runner build; cat /outside/notes.md; sed -n 1,5p ~/.zshrc",
        "python3 /home/user/.agents/skills/design/scripts/design_md.py lint DESIGN.md --strict",
        "node /outside/tools/check.mjs --strict",
        "python3 - <<'PY'\nimport re\nassert not re.search(r'/Users/|TODO', open('README.md').read())\nPY",
        "node --input-type=module <<'JS'\nimport {readFileSync} from 'node:fs'\nconsole.log(readFileSync('/outside/notes.md', 'utf8'))\nJS",
        "python3 - <<'PY'\n source.extend(re.findall(r'Endpoint\\.(?:get|post)\\(\\s*[\"\\']([^\"\\']+)',p.read_text()))\nassert set(expand('`notice.{subscribe,list}`'))==set(re.findall(r'\"([^\"]+)\"',notice))\nprint('PASS: 194 local / 68 connector; no private paths')\nPY",
    ] {
        let result = classify("shell", &[command.into()], &match_paths(), &[]);
        assert_eq!(result.effect, Effect::Allow, "{command}");
        assert!(!result.hard_review, "{command}");
        assert!(result.rule_ids.is_empty(), "{command}");
    }
}

#[test]
fn outside_writes_and_execution_stay_reviewed_and_hard_reviews_stay_hard() {
    for command in [
        "cd /outside && sed -i 's/a/b/' file",
        "cd /outside && node build.mjs",
        "cat file > /outside/out; ls",
        "ls; grep x file | tee /outside/out",
        "python3 script.py > /outside/out",
        "python3 /outside/tool.py --write /outside/out",
        "cd /outside && python3 - <<'PY'\nopen('x', 'w').write('y')\nPY",
        "ls; cat $(touch /outside/file)",
        "cd /outside || exit 1; touch file",
    ] {
        let result = classify("shell", &[command.into()], &match_paths(), &[]);
        assert_eq!(result.effect, Effect::Ask, "{command}");
        assert!(!result.hard_review, "{command}");
        assert_eq!(
            result.rule_ids,
            vec![LosslessString::from("standard.review.outside-repo")],
            "{command}"
        );
    }
    for (command, id) in [
        (
            "cd /outside && rm -rf ~/Documents",
            "standard.review.home-child",
        ),
        (
            "cd /outside || exit 1; git reset --hard HEAD",
            "standard.review.git-destructive",
        ),
        (
            "python3 /outside/tool.py; git push --force",
            "standard.review.force-push",
        ),
    ] {
        let result = classify("shell", &[command.into()], &match_paths(), &[]);
        assert_eq!(result.effect, Effect::Ask, "{command}");
        assert!(result.hard_review, "{command}");
        assert_eq!(result.rule_ids, vec![LosslessString::from(id)], "{command}");
    }
}

#[test]
fn api_routes_client_strings_and_in_memory_code_are_not_outside_targets() {
    for command in [
        "ycoding api GET /api/session/outstanding",
        "ycoding api GET /api/provider/openrouter",
        "ycoding api GET '/api/session?limit=25'",
        "ycoding api session.list --param search=inventory --param limit=50",
        "ycoding api session.prompt -d '{\"text\":\"See /outside/file\"}'",
        "ycoding api GET /api/session/outstanding; ycoding api GET /api/session/active; ycoding api GET /api/config | python3 -c 'import sys,json; d=json.load(sys.stdin); print(json.dumps({\"keys\":list(d),\"location\":d.get(\"location\")}))'; readlink /home/user/.local/bin/ycoding",
        "/usr/local/bin/ycoding api GET /api/session/outstanding",
        "curl -s http://localhost:4096/api/session/outstanding",
        "curl -s /api/session/outstanding",
        "curl -s -X POST -H 'content-type: application/json' -d '{\"path\":\"/outside/file\"}' https://example.com/api/session",
        "wget -q https://example.com/api/file",
        "http GET /api/session/outstanding",
        "gh api -X GET /repos/owner/repo --jq .name",
        "python3 script.py --url /api/session/outstanding",
        "python3 script.py --endpoint=/api/session/outstanding",
        "python3 -c \"import urllib.request; print(urllib.request.urlopen('http://localhost/api/session').read())\"",
        "python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get(\"/api/config\"))'",
        "python3 - <<'PY'\nimport requests\nprint(requests.get(\"/api/session\").json())\nPY",
        "python3 -c \"print(open('/outside/notes.md').read())\"",
        "python3 -c \"from pathlib import Path; print(Path('/outside/notes.md').read_text())\"",
        "python3 -c 'print(\"open(\'/outside/out.txt\',\'w\')\")'",
        "python3 - <<'PY'\n# open('/outside/out.txt','w')\nprint(1)\nPY",
        "python3 - <<'PY'\ns = \"\"\"open('/outside/out.txt','w')\"\"\"\nprint(s)\nPY",
        "curl -b session=abc https://example.com/api/session",
        "curl -d @body.json https://example.com/api/session",
        "curl -H 'X-Info: file:///outside/note' https://example.com",
        "curl 'https://example.com/?next=file:///outside/note'",
        "curl --referer 'file:///outside/note' https://example.com",
        "curl -d 'next=file:///outside/note' https://example.com/api/session",
    ] {
        let result = classify("shell", &[command.into()], &match_paths(), &[]);
        assert_eq!(result.effect, Effect::Allow, "{command}");
        assert!(!result.hard_review, "{command}");
        assert!(result.rule_ids.is_empty(), "{command}");
        assert!(
            outside_targets("shell", &command.into(), &match_paths()).is_empty(),
            "{command}"
        );
    }
}

#[test]
fn real_file_targets_in_api_and_interpreter_commands_are_reviewed() {
    for command in [
        "ycoding api GET /api/session/outstanding > /outside/out.json",
        "ycoding api GET /api/session/outstanding; touch /outside/file",
        "curl --output /outside/file /api/session",
        "curl -d @/outside/body.json https://example.com/api/session",
        "curl -d @../outside/body.json https://example.com/api/session",
        "curl -F upload=@/outside/file.bin https://example.com/api/session",
        "curl -b/outside/cookies.txt https://example.com/api/session",
        "curl file:///outside/secret.txt",
        "curl file://localhost/outside/secret.txt",
        "curl --url file:///outside/secret.txt",
        "curl --url=file:///outside/secret.txt",
        "curl -H @/outside/headers.txt https://example.com/api/session",
        "some-tool api GET /api/session/outstanding",
        "tool GET /outside/file",
        "curl -T /outside/upload.bin https://example.com/api/session",
        "wget -O /outside/file https://example.com/api/file",
        "gh api /repos/owner/repo --input /outside/body.json",
        "touch /api/session/outstanding",
        "cp notes.txt /api/outside/file",
        "python3 script.py --output /outside/out",
        "python3 -c \"open('/outside/out.txt','w').write('x')\"",
        "python3 -c \"open('/outside/out.txt', mode='w').write('x')\"",
        "python3 -c \"from pathlib import Path; Path('/outside/out.txt').write_text('x')\"",
        "python3 -c \"import os; os.remove('/outside/out.txt')\"",
        "python3 - <<'PY'\nopen('/outside/out.txt','w').write('x')\nPY",
    ] {
        let result = classify("shell", &[command.into()], &match_paths(), &[]);
        assert_eq!(result.effect, Effect::Ask, "{command}");
        assert!(!result.hard_review, "{command}");
        assert_eq!(
            result.rule_ids,
            vec![LosslessString::from("standard.review.outside-repo")],
            "{command}"
        );
    }
}

#[test]
fn api_shaped_commands_preserve_custom_hard_and_catastrophic_rules() {
    let custom_layer = CustomLayer {
        rules: vec![guardrail::Rule {
            id: "review-api-mutations".into(),
            source: guardrail::RuleSource::Custom,
            decision: guardrail::RuleDecision::HardReview,
            actions: vec!["shell".into()],
            resources: vec!["ycoding api *".into()],
            reason: "review".into(),
            priority: Int::new(0).unwrap(),
        }],
        invalid_files: vec![],
    };
    let result = classify(
        "shell",
        &["ycoding api session.remove -d '{}'".into()],
        &match_paths(),
        &[custom_layer],
    );
    assert_eq!(result.effect, Effect::Ask);
    assert!(result.hard_review);
    assert_eq!(
        result.rule_ids,
        vec![LosslessString::from("review-api-mutations")]
    );

    let catastrophic = classify(
        "shell",
        &[format!("ycoding api GET /api/x; {}", "rm -rf /")
            .as_str()
            .into()],
        &match_paths(),
        &[],
    );
    assert_eq!(catastrophic.effect, Effect::Deny);
    assert_eq!(
        catastrophic.rule_ids,
        vec![LosslessString::from("standard.catastrophic.rm-root")]
    );

    let force_push = classify(
        "shell",
        &["ycoding api GET /api/x; git push --force origin main".into()],
        &match_paths(),
        &[],
    );
    assert_eq!(force_push.effect, Effect::Ask);
    assert!(force_push.hard_review);
    assert_eq!(
        force_push.rule_ids,
        vec![LosslessString::from("standard.review.force-push")]
    );
}

#[test]
fn shell_advisory_targets_include_read_only_file_operands_but_not_routes_or_executables() {
    let p = match_paths();
    let targets = |cmd: &str| -> Vec<String> {
        shell_file_targets(&cmd.into(), &p)
            .into_iter()
            .map(|t| t.to_utf8().unwrap_or_default())
            .collect()
    };
    assert_eq!(
        targets("ycoding api GET /api/session/outstanding"),
        Vec::<String>::new()
    );
    assert_eq!(
        targets("/usr/local/bin/ycoding api GET /api/session/outstanding"),
        Vec::<String>::new()
    );
    assert!(targets("cat /outside/secret.txt").contains(&"/outside/secret.txt".to_string()));
    assert!(
        targets("readlink /home/user/.local/bin/ycoding")
            .contains(&"/home/user/.local/bin/ycoding".to_string())
    );
    assert!(
        targets("curl -o /outside/file https://example.com/api")
            .contains(&"/outside/file".to_string())
    );
    assert!(
        targets("curl -s https://example.com/api > /outside/out")
            .contains(&"/outside/out".to_string())
    );
    assert!(targets("python3 /outside/script.py").contains(&"/outside/script.py".to_string()));
    assert!(targets("python3 -u /outside/script.py").contains(&"/outside/script.py".to_string()));
    assert!(
        targets("python3 -c \"print(open('/outside/notes.md').read())\"")
            .contains(&"/outside/notes.md".to_string())
    );
    assert!(
        targets("python3 -c \"from pathlib import Path; Path('/outside/notes.md').read_text()\"")
            .contains(&"/outside/notes.md".to_string())
    );
    assert!(
        !targets("python3 -c 'print(\"open('/outside/out.txt','w')\")'")
            .contains(&"/outside/out.txt".to_string())
    );
    assert!(
        targets("curl -d @body.json https://example.com/api/session")
            .contains(&"/workspace/project/body.json".to_string())
    );
    assert!(
        targets("curl file:///outside/secret.txt").contains(&"/outside/secret.txt".to_string())
    );
    assert!(targets("curl file:///outside/a%20b.txt").contains(&"/outside/a b.txt".to_string()));
    assert!(
        !targets("curl -H 'X-Info: file:///outside/note' https://example.com")
            .contains(&"/outside/note".to_string())
    );
    assert!(
        !targets("curl 'https://example.com/?next=file:///outside/note'")
            .contains(&"/outside/note".to_string())
    );
    assert!(
        targets("curl -H @/outside/headers.txt https://example.com/api/session")
            .contains(&"/outside/headers.txt".to_string())
    );
    assert_eq!(
        outside_targets("shell", &"python3 /outside/script.py".into(), &p),
        Vec::<OutsideTarget>::new()
    );
}

#[test]
fn sql906_closed_literal_queries_and_bounded_metadata_are_inert() {
    for command in [
        r#"psql -c "SELECT 'DROP TABLE users'""#,
        r#"psql --command="SELECT 'it''s DROP TABLE users'""#,
        r#"mysql --execute="SELECT 'DROP TABLE users'""#,
        r#"sqlite3 db.sqlite "SELECT count(*) FROM audit WHERE query LIKE 'delete from %'""#,
        r#"psql -c "SELECT 1 /* DROP TABLE users */""#,
        r#"psql -c "SELECT 1 -- DROP TABLE users""#,
        r#"psql -c "EXPLAIN SELECT 'DROP TABLE users'; SELECT 'DELETE FROM users'""#,
        r#"sqlite3 db.sqlite 'DELETE FROM "tenant space"."user table" WHERE id = 1'"#,
        r#"psql -c "DELETE FROM ONLY users AS u WHERE u.id = 1""#,
        r#"psql -c "DELETE FROM users u WHERE u.id = 1 RETURNING u.id""#,
        r#"git commit -m "DROP TABLE migration" --allow-empty"#,
        r#"gh api /repos/owner/repo/issues -f title="Fix DROP TABLE issue""#,
        "ls # DELETE FROM users\n",
        r#"echo "DELETE FROM users"; ls"#,
    ] {
        let result = classify("shell", &[command.into()], &paths(), &[]);
        assert_eq!(result.effect, Effect::Allow, "{command}");
        assert!(!result.hard_review, "{command}");
        assert!(result.rule_ids.is_empty(), "{command}");
    }
}

#[test]
fn sql906_destructive_sql_has_no_disposable_or_temporary_exemption() {
    for command in [
        r#"sqlite3 :memory: "DROP TABLE users""#,
        r#"sqlite3 :memory: "TRUNCATE TABLE users""#,
        r#"sqlite3 :memory: "DELETE FROM users""#,
        r#"sqlite3 "" "DROP TABLE users""#,
        r#"sqlite3 /tmp/temporary.db "DROP TABLE users""#,
        r#"sqlite3 ./disposable.db "CREATE TABLE users (id int); DROP TABLE users""#,
        r#"sqlite3 :memory: "ATTACH DATABASE 'live.db' AS live; DELETE FROM live.users""#,
        r#"psql -c "DROP/* migration */TABLE users""#,
        r#"sqlite3 db.sqlite "DELETE FROM users; SELECT 1""#,
        r#"psql -c "DELETE FROM users AS u RETURNING u.id""#,
        r#"psql -c "DELETE FROM users USING (SELECT 1 WHERE true) q""#,
        r#"psql -c "DELETE FROM users /* cleanup */""#,
    ] {
        let result = classify("shell", &[command.into()], &paths(), &[]);
        assert_eq!(result.effect, Effect::Ask, "{command}");
        assert!(result.hard_review, "{command}");
        assert_eq!(
            result.rule_ids,
            vec![LosslessString::from("standard.review.database-destructive")],
            "{command}"
        );
    }
}

#[test]
fn sql906_read_only_exemptions_reject_unproven_or_effectful_contexts() {
    for command in [
        r#"psql -c "SELECT run_sql('DROP TABLE users')""#,
        r#"psql -c "SELECT pg_catalog.count('DROP TABLE users')""#,
        r#"psql -c "SELECT 'DROP TABLE users'" -f startup.sql"#,
        r#"psql -c "SELECT 'DROP TABLE users'" | psql"#,
        r#"psql -c "SELECT 'DROP TABLE users'" > migration.sql"#,
        r#"psql -c "SELECT 'DROP TABLE users' INTO OUTFILE 'migration.sql'""#,
        r#"psql -c "SELECT 'DROP TABLE users' \gexec""#,
        r#"psql -c 'DO $body$ BEGIN EXECUTE $sql$DROP TABLE users$sql$; END $body$'"#,
        r#"psql -c "SELECT 'DROP TABLE users""#,
        r#"mariadb -e "SELECT 1 /*M! ; DROP TABLE users */""#,
        r#"sqlite3 -cmd ".read startup.sql" db.sqlite "SELECT 'DROP TABLE users'""#,
        r#"sqlite3 * "SELECT 'DROP TABLE users'""#,
        r#"printf '\x44ROP TABLE users;' | sqlite3 :memory:"#,
        r#"printf '%b' '\0104ROP TABLE users;' | sqlite3 :memory:"#,
        r#"git commit -m "DROP TABLE note" --config-env=core.editor=SQL_EDITOR"#,
        r#"git rebase --exec="psql -c 'DROP TABLE users'""#,
        r#"gh api /repos/owner/repo/issues -f title="DROP TABLE note" -f query="DROP TABLE users""#,
        r#"gh api /repos/owner/repo/issues -F title="@DROP TABLE payload""#,
        r#"curl --json '{"query":"DROP TABLE users"}' https://example.invalid/sql"#,
        r#"psql -c "DELETE FROM users WHERE run_sql('DROP TABLE users')""#,
    ] {
        let result = classify("shell", &[command.into()], &paths(), &[]);
        assert_eq!(result.effect, Effect::Ask, "{command}");
        assert!(result.hard_review, "{command}");
        assert_eq!(
            result.rule_ids,
            vec![LosslessString::from("standard.review.database-destructive")],
            "{command}"
        );
    }
}

#[test]
fn sql906_database_client_file_operations_retain_outside_review() {
    for command in [
        r#"psql -c '\copy items FROM "/outside/input.csv"'"#,
        r#"psql -c '\copy (SELECT * FROM items) TO "/outside/output.csv"'"#,
        r#"psql -c '\i /outside/input.sql'"#,
        r#"psql -c '\o /outside/output.txt'"#,
        r#"psql --file=/outside/input.sql"#,
        r#"mysql -e "SELECT 1" < /outside/input.sql"#,
        r#"sqlite3 -init /outside/init.sql db.sqlite "SELECT 1""#,
        r#"sqlite3 db.sqlite ".read /outside/input.sql""#,
        r#"sqlite3 db.sqlite ".import --skip 1 /outside/input.csv items""#,
        r#"sqlite3 db.sqlite "ATTACH '/outside/other.db' AS other""#,
        r#"sqlite3 db.sqlite "VACUUM INTO '/outside/copy.db'""#,
        r#"sqlite3 db.sqlite "SELECT readfile('/outside/input.txt')""#,
    ] {
        let result = classify("shell", &[command.into()], &paths(), &[]);
        assert_eq!(result.effect, Effect::Ask, "{command}");
        assert!(!result.hard_review, "{command}");
        assert_eq!(
            result.rule_ids,
            vec![LosslessString::from("standard.review.outside-repo")],
            "{command}"
        );
    }
}

#[test]
fn sql906_server_sql_and_quoted_identifiers_do_not_invent_local_file_targets() {
    for command in [
        r#"psql -c "COPY items FROM '/server/input.csv'""#,
        r#"psql -c 'SELECT "\i /outside/fake.sql"'"#,
        r#"psql -c 'SELECT "\o /outside/fake.sql"'"#,
        "psql -c 'SELECT $$\n\\copy items TO PROGRAM \"/outside/program\"\n$$'",
    ] {
        assert!(
            outside_targets("shell", &command.into(), &paths()).is_empty(),
            "{command}"
        );
    }
    assert_eq!(
        classify(
            "shell",
            &[r#"psql -c "COPY items FROM '/server/input.csv'""#.into()],
            &paths(),
            &[]
        )
        .effect,
        Effect::Allow
    );
}

#[test]
fn sql906_dynamic_and_interpreter_execution_is_uncertain_not_confirmed_sql() {
    for command in [
        r#"bun -e "const text = 'DROP TABLE users'; console.log(text)""#,
        r#"python -c "db.run('DROP TABLE users')""#,
        "python <<'CODE'\ndb.run('DROP TABLE users')\nCODE",
        r#"printf '%s' "$SQL" | env psql"#,
        r#"psql -c '\copy items TO PROGRAM "some-program"'"#,
    ] {
        let result = classify("shell", &[command.into()], &paths(), &[]);
        assert_eq!(result.effect, Effect::Ask, "{command}");
        assert!(result.hard_review, "{command}");
        assert_eq!(
            result.rule_ids,
            vec![LosslessString::from("standard.review.database-destructive")],
            "{command}"
        );
        assert_eq!(
            result.reason,
            Some("Possible destructive database operation; execution is unproven".into()),
            "{command}"
        );
    }
    assert_eq!(
        classify("shell", &[r#"printf '%s' "$SQL""#.into()], &paths(), &[]).effect,
        Effect::Allow
    );
}

#[test]
fn sql906_unknown_sqlite_import_is_reviewed_without_a_fabricated_target() {
    let command: LosslessString =
        r#"sqlite3 db.sqlite ".import --unknown value /outside/input.csv items""#.into();
    let result = classify("shell", std::slice::from_ref(&command), &paths(), &[]);
    assert_eq!(result.effect, Effect::Ask);
    assert!(!result.hard_review);
    assert_eq!(
        result.rule_ids,
        vec![LosslessString::from("standard.review.outside-repo")]
    );
    assert_eq!(
        result.reason,
        Some("SQLite import file target is unproven".into())
    );
    assert!(outside_targets("shell", &command, &paths()).is_empty());
}

#[test]
fn sql906_custom_denies_and_other_hard_rules_keep_their_precedence() {
    let sql = r#"psql -c "DROP TABLE users""#;
    let resources = ["git push --force origin main".into(), sql.into()];
    let result = classify("shell", &resources, &paths(), &[]);
    assert_eq!(
        result.rule_ids,
        vec![LosslessString::from("standard.review.force-push")]
    );
    let denied = classify(
        "shell",
        &[sql.into()],
        &paths(),
        &[custom(guardrail::RuleDecision::Deny)],
    );
    assert_eq!(denied.effect, Effect::Deny);
    assert_eq!(denied.rule_ids, vec![LosslessString::from("custom")]);
    assert!(
        classify(
            "shell",
            &[sql.into()],
            &paths(),
            &[custom(guardrail::RuleDecision::Allow)]
        )
        .hard_review
    );
    assert_eq!(
        classify("shell", &["rm -rf /; ".into(), sql.into()], &paths(), &[]).effect,
        Effect::Deny
    );
}

#[test]
fn search_text_in_read_only_pipelines_is_not_reviewed() {
    for command in [
        r#"rg -n "delete from" packages/core/src/session"#,
        "rg -n 'delete from' packages/core/src/session",
        r#"git grep -n "git reset --hard" -- docs"#,
        r#"git grep -n "git push --force" -- docs"#,
        r#"rg -n "run git reset --hard now" docs"#,
        r#"rg -n "avoid git clean -fd" docs"#,
        "rg -n mkfs packages",
        "rg -n ':(){ :|:& };:' docs",
        r#"rg -n "delete from users$" packages/core/src"#,
        r#"rg -n "drop table.*;$" schema.sql"#,
        r#"LC_ALL=C rg -n "delete from" packages/core/src/session"#,
        r#"/opt/homebrew/bin/rg -n "delete from" packages/core/src/session"#,
        r#"command rg -n "delete from" packages/core/src/session"#,
        r#"command -p grep -n "delete from" packages/core/src/session"#,
        r#"/usr/local/bin/rg -n "delete from" packages/core/src/session"#,
        r#"grep "delete from" < schema.sql"#,
        r#"rg -n "delete from" packages/core/src/session | head -20"#,
    ] {
        let result = classify("shell", &[command.into()], &paths(), &[]);
        assert_eq!(result.effect, Effect::Allow, "{command}");
        assert!(result.rule_ids.is_empty(), "{command}");
    }
}

#[test]
fn search_text_with_an_executable_segment_keeps_protection() {
    for (command, effect, id) in [
        (
            "git reset --hard HEAD",
            Effect::Ask,
            "standard.review.git-destructive",
        ),
        (
            "mkfs.ext4 /dev/sda1",
            Effect::Deny,
            "standard.catastrophic.format-disk",
        ),
        (
            ":(){ :|:& };:",
            Effect::Deny,
            "standard.catastrophic.fork-bomb",
        ),
        (
            "dd if=/dev/zero of=/dev/disk0",
            Effect::Deny,
            "standard.catastrophic.block-device-write",
        ),
        (
            r#"sqlite3 app.db "delete from users""#,
            Effect::Ask,
            "standard.review.database-destructive",
        ),
        (
            r#"echo "delete from users" | sqlite3 app.db"#,
            Effect::Ask,
            "standard.review.database-destructive",
        ),
        (
            r#"rg --pre processor "delete from" packages"#,
            Effect::Ask,
            "standard.review.database-destructive",
        ),
        (
            r#"rg -n "delete from" packages > matches.txt"#,
            Effect::Ask,
            "standard.review.database-destructive",
        ),
        (
            r#"rg -n "delete from $(cat tables.txt)" packages"#,
            Effect::Ask,
            "standard.review.database-destructive",
        ),
        (
            r#"rg -n "delete from" packages | sh"#,
            Effect::Ask,
            "standard.review.database-destructive",
        ),
        (
            r#"git grep -n -O "delete from" -- packages"#,
            Effect::Ask,
            "standard.review.database-destructive",
        ),
        (
            r#"rg -n "delete from" packages; git reset --hard HEAD"#,
            Effect::Ask,
            "standard.review.git-destructive",
        ),
        (
            r#"env LC_ALL=C grep -rn "drop table" packages"#,
            Effect::Ask,
            "standard.review.database-destructive",
        ),
        (
            r#"LD_PRELOAD=/tmp/evil.so rg -n "delete from" packages"#,
            Effect::Ask,
            "standard.review.database-destructive",
        ),
        (
            r#"/tmp/tools/rg -n "delete from" packages"#,
            Effect::Ask,
            "standard.review.database-destructive",
        ),
        (
            "rg -n \"delete from `cat tables.txt`\" packages",
            Effect::Ask,
            "standard.review.database-destructive",
        ),
        (
            "rg -n \"delete from\" packages <<EOF\nusers\nEOF",
            Effect::Ask,
            "standard.review.database-destructive",
        ),
    ] {
        let result = classify("shell", &[command.into()], &paths(), &[]);
        assert_eq!(result.effect, effect, "{command}");
        assert_eq!(result.rule_ids, vec![LosslessString::from(id)], "{command}");
    }
}

#[test]
fn search_literal_dollar_stays_read_only_while_dollar_bracket_is_classified() {
    let command = r#"rg -n "delete from $[x=1] users" packages"#;
    assert_eq!(
        semantic_resources("shell", &[command.into()], &paths()),
        vec![LosslessString::from(command)]
    );
    let result = classify("shell", &[command.into()], &paths(), &[]);
    assert_eq!(result.effect, Effect::Ask, "{command}");
    assert_eq!(
        result.rule_ids,
        vec![LosslessString::from("standard.review.database-destructive")],
        "{command}"
    );
    assert!(
        semantic_resources(
            "shell",
            &[r#"rg -n "delete from users$" packages/core/src"#.into()],
            &paths()
        )
        .is_empty()
    );
}

#[test]
fn search_custom_guardrails_still_classify_a_read_only_search() {
    let layer = CustomLayer {
        rules: vec![guardrail::Rule {
            id: "deny-search-text".into(),
            source: guardrail::RuleSource::Custom,
            decision: guardrail::RuleDecision::Deny,
            actions: vec!["shell".into()],
            resources: vec!["*delete from*".into()],
            reason: "deny-search-text".into(),
            priority: Int::new(0).unwrap(),
        }],
        invalid_files: vec![],
    };
    let result = classify(
        "shell",
        &[r#"rg -n "delete from" packages/core/src/session"#.into()],
        &paths(),
        &[layer],
    );
    assert_eq!(result.effect, Effect::Deny);
    assert!(!result.standard);
    assert_eq!(
        result.rule_ids,
        vec![LosslessString::from("deny-search-text")]
    );
}
