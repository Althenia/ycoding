use ycoding_core::process::guardrails::{
    CustomLayer, Paths, classify, outside_targets, semantic_resources,
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
