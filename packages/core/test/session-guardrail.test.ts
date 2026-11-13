import { describe, expect, test } from "bun:test"
import { Guardrail } from "@ycoding-ai/schema/guardrail"
import { SessionGuardrailMatch } from "@ycoding-ai/core/session/guardrail-match"
import { SessionGuardrailStandard } from "@ycoding-ai/core/session/guardrail-standard"

const custom = (
  input: Partial<Guardrail.Rule> & Pick<Guardrail.Rule, "id" | "decision" | "actions" | "resources">,
): Guardrail.Rule => ({
  source: "custom",
  reason: input.id,
  priority: 0,
  ...input,
})

const layer = (rules: Guardrail.Ruleset, invalidFiles: ReadonlyArray<string> = []) => ({ rules, invalidFiles })

describe("SessionGuardrailMatch", () => {
  test("a dismissed project-deletion match does not dismiss a separate home-child match on the same target", () => {
    expect(SessionGuardrailMatch.evaluate({
      action: "shell", resources: ["rm -rf ."],
      paths: { workdir: "/home/user/project", project: "/home/user/project", home: "/home/user" },
      dismissedStandardRules: new Set(["standard.review.project-deletion"]),
    })).toMatchObject({ decision: "ask", hardReview: true, ruleIDs: ["standard.review.home-child"] })
  })
  const paths = { workdir: "/workspace/project", project: "/workspace/project", home: "/home/user" }

  test.each([
    'sed -n 59,75p packages/core/src/memory.ts; grep -nE "^  (const|return \\{)|^    (status|list|search|read|write|graph|delete|trash|restore|purge|vacuum)[,:]" packages/core/src/memory.ts | head -30',
    "cat README.md | head -20; git status --short",
    "sed -n '1,10p;20d;$=' file",
    "find . -name '*.ts'; rg --files; sort file; uniq file",
    "git branch --show-current; git worktree list; git remote -v",
    "grep x file > /dev/null 2>&1",
    "cat file >/dev/null; grep x file >>/dev/null; head file 2>/dev/null",
  ])("skips classification for proven read-only shell %s", (command) => {
    expect(SessionGuardrailStandard.semanticResources("shell", [command], paths)).toEqual([])
  })

  test.each([
    "ls docs/design docs/design/proposals docs/design/proposals/* 2>/dev/null | head -50; git check-ignore -v docs/design/proposals/2026-redesign 2>&1; cat .git/info/exclude",
    "git check-ignore -v docs/x 2>&1",
    "git check-ignore --no-index --non-matching --verbose docs/x",
    "printf 'docs/x' | git check-ignore --stdin",
    "git check-attr --all -- docs/x",
    "git check-attr --cached diff -- docs/x",
    "git ls-tree -r --name-only HEAD",
    "git cat-file -p HEAD",
    "git cat-file -t HEAD; git cat-file -s HEAD; git cat-file -e HEAD",
    "git cat-file blob HEAD:README.md",
    "printf 'HEAD' | git cat-file --batch",
    "printf 'HEAD' | git cat-file --batch-check='%(objectname) %(objecttype)'",
    "git rev-list --count HEAD",
    "git rev-list --objects --all",
    "git describe --tags --always HEAD",
    "git name-rev --name-only HEAD",
    "git for-each-ref --sort=-committerdate --format='%(refname:short)' refs/heads",
    "git for-each-ref --shell --format='ref=%(refname)' refs/heads",
    "git show-ref --head --tags",
    "git show-ref --verify --quiet refs/heads/main",
    "git show-ref --exists refs/heads/main",
    "printf 'refs/heads/main' | git show-ref --exclude-existing",
    "git tag",
    "git tag -l 'v*'",
    "git tag --list --sort=-version:refname --format='%(refname:short)'",
    "git tag -n3",
    "git tag --contains HEAD",
    "git tag --points-at=HEAD",
    "git tag -l --sort refname --format '%(objectname)' -- 'v*'",
    "git config --get user.name",
    "git config --get-all remote.origin.url",
    "git config --get-regexp '^remote\\.'",
    "git config --list --show-origin --show-scope --name-only",
    "git config -l",
    "git config --global --get user.name",
    "git config --local --get user.name",
    "git config --system --list",
    "git config --file .git/config --list",
    "git config --file=.git/config --get user.name",
    "git stash list --oneline",
    "git stash show -p",
    "git reflog",
    "git reflog show --oneline HEAD",
    "git reflog --oneline HEAD",
    "git reflog exists refs/heads/main",
    "git shortlog -sn HEAD",
    "git grep -n foo -- docs",
    "git grep -n --cached -e foo",
    "git count-objects -vH",
    "git var -l; git var GIT_EDITOR; git var GIT_PAGER",
  ])("skips classification for bounded Git inspection: %s", (command) => {
    expect(SessionGuardrailStandard.semanticResources("shell", [command], paths)).toEqual([])
  })

  test.each([
    "git -C docs check-ignore -v x",
    "git --no-pager -C docs -C proposals ls-tree HEAD",
    "git -C docs --no-pager log -1",
  ])("accepts Git -C as a path-only global option: %s", (command) => {
    expect(SessionGuardrailStandard.semanticResources("shell", [command], paths)).toEqual([])
  })

  test.each([
    "git -c core.pager=sh log",
    "git -C docs -c core.fsmonitor=sh status",
    "git --no-pager -c alias.inspect=sh inspect",
    "git --config-env=core.pager=PAGER log",
    "git --paginate log",
    "git -p log",
    "git -C",
    "git -C docs add x",
  ])("keeps Git configuration/program overrides and non-inspection -C forms classified: %s", (command) => {
    expect(SessionGuardrailStandard.semanticResources("shell", [command], paths)).toEqual([command])
  })

  test.each([
    "git config user.name x",
    "git config user.name",
    "git config --edit",
    "git config --get user.name --edit",
    "git config --list --add user.name x",
    "git config --unset user.name",
    "git config --replace-all user.name x",
    "git config --rename-section old new",
    "git config --remove-section old",
    "git config --file .git/config user.name x",
    "git config --file --get user.name x",
    "git config --show-origin user.name x",
    "git config --get user.name --unknown",
    "git config --ge user.name",
    "git config --list --get user.name",
    "git tag v1",
    "git tag --sort=refname v1",
    "git tag --format='%(refname)' v1",
    "git tag -- --list v1",
    "git tag -d v1",
    "git tag -l -d v1",
    "git tag --list --create-reflog",
    "git tag --list --edit",
    "git tag -v v1",
    "git tag --list --format='%(signature:grade)'",
    "git tag --list --sort=signature:grade",
    "git stash",
    "git stash pop",
    "git stash push",
    "git stash list --output=out",
    "git stash show --ext-diff",
    "git stash show --textconv",
    "git reflog expire --all",
    "git reflog delete 'HEAD@{0}'",
    "git reflog drop --all",
    "git reflog write refs/heads/main HEAD HEAD message",
    "git reflog --all expire",
    "git reflog show --output=out",
    "git cat-file --filters HEAD:x",
    "git cat-file --filt HEAD:x",
    "git cat-file --batch --filters",
    "git cat-file --textconv HEAD:x",
    "git cat-file --batch-check --text HEAD:x",
    "git grep -O foo",
    "git grep -Osh foo",
    "git grep -nOsh foo",
    "git grep --open-files-in-pager=sh foo",
    "git grep --open=sh foo",
    "git grep --textconv foo",
    "git describe --dirty",
    "git describe --dir=x",
    "git describe --broken",
    "git describe --bro=x",
    "git for-each-ref --format='%(signature:grade)'",
    "git for-each-ref --sort signature:signer",
    "git for-each-ref --format='%(describe)'",
    "git rev-list --show-signature HEAD",
    "git rev-list --format='%G?' HEAD",
    "git shortlog --group='format:%GS' HEAD",
    "git reflog show --show-signature",
    "git stash list --format='%GK'",
    "git check-ignore --help",
  ])("keeps writing, executing and unproven Git forms classified: %s", (command) => {
    expect(SessionGuardrailStandard.semanticResources("shell", [command], paths)).toEqual([command])
  })

  test.each([
    "sed -i 's/x/y/' file", "sed -n 'w out' file", "grep x > out.txt", "cat $(echo f)",
    "find . -delete", "git branch new", "ls | xargs rm", "cat `echo f`", "cat <(echo f)",
    "cat <<EOF", "$CMD file", "sudo cat file", "env cat file", "sh -c 'cat file'",
    "rg --pre processor x", "sort -o out file", "uniq input output", "git diff --output=out",
    "sed -n -e '1p' -e 'w out' file", "find . -fprint out", "jq --run-tests file",
    "git -c core.pager=evil log", "git diff --ext-diff", "sed -n '1e' file", "sort --compress-program=evil file",
    "sort --out=out file", "git diff --out=out", "file --comp file", "file -C -m file",
    "cat2>/dev/null", "git3>&1 status",
    "echo readonly && task-runner execute", "cat file; tee out", "cat file > /dev/null.txt",
  ])("keeps unproven shell commands classified: %s", (command) => {
    expect(SessionGuardrailStandard.semanticResources("shell", [command], paths)).toEqual([command])
  })

  test("hard denies catastrophic shell commands", () => {
    expect(SessionGuardrailMatch.evaluate({ action: "shell", resources: ["rm -rf /"] })).toMatchObject({
      decision: "deny",
      standard: true,
      ruleIDs: ["standard.catastrophic.rm-root"],
    })
  })

  test.each([
    "bash <<'EOF'\nrm -rf ~\nEOF",
    "cat <<'EOF' | sh\nrm -rf ~\nEOF",
    "rm -rf ~>/dev/null",
    "rm -rf ~ 2>&1 | tail -1",
  ])("keeps home deletion denied around heredocs and redirects: %s", (command) => {
    expect(SessionGuardrailMatch.evaluate({ action: "shell", resources: [command], paths })).toMatchObject({
      decision: "deny",
      ruleIDs: ["standard.catastrophic.rm-user-home"],
    })
  })

  test("requires hard approval for destructive Git commands", () => {
    expect(SessionGuardrailMatch.evaluate({ action: "shell", resources: ["git reset --hard HEAD~1"] })).toMatchObject({
      decision: "ask",
      standard: true,
      ruleIDs: ["standard.review.git-destructive"],
      hardReview: true,
    })
  })

  test("desktop window access has no standard review and still honors custom policy", () => {
    const input = { action: "computer", resources: ["macos.bundle_id/app.synthetic/123/4"] }
    expect(SessionGuardrailMatch.evaluate(input)).toMatchObject({ decision: "allow", ruleIDs: [] })
    expect(
      SessionGuardrailMatch.evaluate({
        ...input,
        custom: [layer([custom({ id: "deny-computer", decision: "deny", actions: ["computer"], resources: ["*"] })])],
      }),
    ).toMatchObject({ decision: "deny", ruleIDs: ["deny-computer"] })
  })

  test.each(["browser_owned_open", "browser_profile_mutation"])(
    "%s has no standard review and still honors custom policy",
    (action) => {
      const input = { action, resources: ["https://example.test"] }
      expect(SessionGuardrailMatch.evaluate(input)).toMatchObject({ decision: "allow", ruleIDs: [] })
      expect(
        SessionGuardrailMatch.evaluate({
          ...input,
          custom: [layer([custom({ id: "deny-browser", decision: "deny", actions: [action], resources: ["*"] })])],
        }),
      ).toMatchObject({ decision: "deny", ruleIDs: ["deny-browser"] })
    },
  )

  test("profile reads have no standard review and still honor custom policy", () => {
    const input = { action: "browser_profile_access", resources: ["https://example.test"] }
    expect(SessionGuardrailMatch.evaluate(input)).toMatchObject({ decision: "allow", ruleIDs: [] })
    expect(SessionGuardrailMatch.evaluate({ ...input,
      custom: [layer([custom({ id: "deny-profile-read", decision: "deny", actions: [input.action],
        resources: ["*"] })])],
    })).toMatchObject({ decision: "deny", ruleIDs: ["deny-profile-read"] })
  })

  test.each([
    ["rm -rf .", "current project"],
    ['/bin/rm -fr -- "/workspace/project"', "quoted project path"],
    ["rm --recursive --force /workspace", "project ancestor"],
    ['echo ready && rm -r -f "$PWD"', "compound command"],
  ])("requires hard review for broad deletion via %s (%s)", (command) => {
    expect(SessionGuardrailMatch.evaluate({ action: "shell", resources: [command], paths })).toMatchObject({
      decision: "ask",
      hardReview: true,
      standard: true,
      ruleIDs: ["standard.review.project-deletion"],
    })
  })

  test.each([
    "rm -rf packages/one packages/two",
    "rm -rf /tmp/cache-a /tmp/cache-b /tmp/cache-c",
  ])("allows multiple narrow recursive targets via %s", (command) => {
    expect(SessionGuardrailMatch.evaluate({ action: "shell", resources: [command], paths })).toMatchObject({
      decision: "allow",
      hardReview: false,
      ruleIDs: [],
    })
  })

  test.each([
    "rm -rf /home/user/Documents",
    "rm -rf ~/Documents",
    'rm -rf "$HOME/Documents"',
    "rm -rf ~/Documents ~/Downloads",
  ])("requires hard review for recursive deletion one level below home via %s", (command) => {
    expect(SessionGuardrailMatch.evaluate({ action: "shell", resources: [command], paths })).toMatchObject({
      decision: "ask",
      hardReview: true,
      standard: true,
      ruleIDs: ["standard.review.home-child"],
    })
  })

  test("tracks a supported cd across newline-separated compound commands", () => {
    expect(
      SessionGuardrailMatch.evaluate({
        action: "shell",
        resources: ["cd ..\nrm -rf ."],
        paths: { ...paths, workdir: "/workspace/project/src" },
      }),
    ).toMatchObject({ decision: "ask", hardReview: true, ruleIDs: ["standard.review.project-deletion"] })
  })

  test.each([
    "cd /tmp; rm -rf .",
    "cd /tmp\nrm -rf .",
    "cd /tmp || rm -rf .",
    "cd /tmp | rm -rf .",
    "cd /tmp & rm -rf .",
  ])("keeps the original workdir reachable when a compound cd cannot guarantee relocation for %s", (command) => {
    expect(SessionGuardrailMatch.evaluate({ action: "shell", resources: [command], paths })).toMatchObject({
      decision: "ask",
      hardReview: true,
      ruleIDs: ["standard.review.project-deletion"],
    })
  })

  test("uses the relocated workdir when && guarantees that deletion follows a successful cd", () => {
    expect(
      SessionGuardrailMatch.evaluate({ action: "shell", resources: ["cd /tmp && rm -rf ."], paths }),
    ).toMatchObject({ decision: "allow", hardReview: false })
  })

  test.each([
    "sudo rm --recursive --force /",
    'rm -rf "$HOME"',
    "rm -r -f /home/user",
    "cd && rm -rf .",
    "cd -- && rm -rf .",
  ])("keeps recognized root and home deletion denied for %s", (command) => {
    expect(SessionGuardrailMatch.evaluate({ action: "shell", resources: [command], paths })).toMatchObject({
      decision: "deny",
      hardReview: false,
      standard: true,
      ruleIDs: [command.endsWith(" /") ? "standard.catastrophic.rm-root" : "standard.catastrophic.rm-user-home"],
    })
  })

  test.each([
    "rm -rf /workspace/project/build",
    "rm -f /workspace/project/file.txt",
    "rm -rf src/tmp",
    "rm -- --recursive .",
    "echo rm -rf .",
  ])("allows safe narrow deletion form %s", (command) => {
    expect(SessionGuardrailMatch.evaluate({ action: "shell", resources: [command], paths })).toMatchObject({
      decision: "allow",
      hardReview: false,
    })
  })

  test("keeps catastrophic standard denies unoverrideable", () => {
    const result = SessionGuardrailMatch.evaluate({
      action: "shell",
      resources: ["rm -rf /"],
      custom: [layer([custom({ id: "allow-all", decision: "allow", actions: ["shell"], resources: ["*"] })])],
    })
    expect(result).toMatchObject({
      decision: "deny",
      standard: true,
      ruleIDs: ["standard.catastrophic.rm-root"],
    })
  })

  test("does not let a custom allow weaken standard hard review", () => {
    expect(
      SessionGuardrailMatch.evaluate({
        action: "shell",
        resources: ["rm -rf ."],
        paths,
        custom: [layer([custom({ id: "allow-all", decision: "allow", actions: ["shell"], resources: ["*"] })])],
      }),
    ).toMatchObject({
      decision: "ask",
      hardReview: true,
      standard: true,
      ruleIDs: ["standard.review.project-deletion"],
    })
  })

  test("does not let a custom allow override hard home-child review", () => {
    expect(
      SessionGuardrailMatch.evaluate({
        action: "shell",
        resources: ["rm -rf ~/Documents"],
        paths,
        custom: [layer([custom({ id: "allow-all", decision: "allow", actions: ["shell"], resources: ["*"] })])],
      }),
    ).toMatchObject({
      decision: "ask",
      hardReview: true,
      standard: true,
      ruleIDs: ["standard.review.home-child"],
    })
  })

  test.each(["/tmp", "/private/tmp", "/var/tmp", "/private/var/tmp", "/var/folders/user/cache", "/scratch/temp", "$TMPDIR", "${TMPDIR}"])(
    "exempts ordinary temp deletion at %s without exempting the project ancestor", (root) => {
      expect(SessionGuardrailMatch.evaluate({ action: "shell", resources: [`rm -rf ${root} ${root}/x`],
        paths: { workdir: "/scratch/temp/project", project: "/scratch/temp/project", home: "/scratch", tmpdir: "/scratch/temp" },
      })).toMatchObject(["/scratch/temp", "$TMPDIR", "${TMPDIR}"].includes(root)
        ? { decision: "ask", hardReview: true, ruleIDs: ["standard.review.project-deletion"] }
        : { decision: "allow", hardReview: false, ruleIDs: [] })
    },
  )

  test("evaluates only the project in mixed temp and project deletion", () => {
    expect(SessionGuardrailMatch.evaluate({ action: "shell", resources: ["rm -rf /tmp/a /private/tmp/y ."], paths }))
      .toMatchObject({ decision: "ask", hardReview: true, ruleIDs: ["standard.review.project-deletion"] })
  })

  test.each(["/tmp", "/private/tmp", "/var/tmp", "/private/var/tmp", "/var/folders", "/scratch/temp"])(
    "temp %s retains exact home deletion protection", (root) => {
      expect(SessionGuardrailMatch.evaluate({ action: "shell", resources: [`rm -rf ${root}`],
        paths: { workdir: `${root}/project`, project: `${root}/project`, home: root, tmpdir: "/scratch/temp" },
      })).toMatchObject({ decision: "deny", ruleIDs: ["standard.catastrophic.rm-user-home"] })
    },
  )

  test.each([
    ["rm -rf /tmp/a /var/tmp/b build", ["rm -rf build"]],
    ['rm -rf "/tmp/path with spaces" "build output"', ['rm -rf "build output"']],
    ['rm -rf /tmp/a; env FLAG="two words" task-runner execute', ['env FLAG="two words" task-runner execute']],
    ["cd /tmp && rm -rf .", ["cd /tmp"]],
    ["cd /tmp || rm -rf .", ["cd /tmp || rm -rf ."]],
    ["rm -rf /tmp/a; git status", ["git status"]],
    ["rm -rf /tmp/a && npm publish", ["npm publish"]],
    ["rm -f $TMPDIR/a ${TMPDIR}/b", []],
  ])("sanitizes recognized temp deletion evidence for %s", (command, expected) => {
    expect(SessionGuardrailStandard.semanticResources("shell", [command], { ...paths, tmpdir: "/scratch/temp" })).toEqual(expected)
  })

  test("temp deletion exclusions preserve custom deny and unrelated standard review", () => {
    expect(SessionGuardrailMatch.evaluate({ action: "shell", resources: ["rm -rf /tmp/a; git push --force"], paths }))
      .toMatchObject({ decision: "ask", hardReview: true, ruleIDs: ["standard.review.force-push"] })
    expect(SessionGuardrailMatch.evaluate({ action: "shell", resources: ["rm -rf /tmp/a"], paths,
      custom: [layer([custom({ id: "deny-temp", decision: "deny", actions: ["shell"], resources: ["*"] })])],
    })).toMatchObject({ decision: "deny", ruleIDs: ["deny-temp"] })
  })

  test("temp workdirs do not erase non-path subagent or artifact resources from evidence", () => {
    const temporaryPaths = { ...paths, workdir: "/tmp/project" }
    expect(SessionGuardrailStandard.semanticResources("subagent", ["build"], temporaryPaths)).toEqual(["build"])
    expect(SessionGuardrailStandard.semanticResources("project_artifact_mutation", ["skill/example"], temporaryPaths))
      .toEqual(["skill/example"])
  })

  test.each(["/Users/other", "/home/other", "/Users/other/*"])("denies any user home %s", (target) => {
    expect(SessionGuardrailMatch.evaluate({ action: "shell", resources: [`rm -rf ${target}`], paths }))
      .toMatchObject({ decision: "deny", hardReview: false, ruleIDs: ["standard.catastrophic.rm-user-home"] })
  })

  test.each(["/System", "/Library", "/usr", "/etc", "/bin", "/sbin", "/opt", "/Applications", "/var", "/var/log"])(
    "denies system deletion %s", (target) => {
      expect(SessionGuardrailMatch.evaluate({ action: "shell", resources: [`rm -rf ${target}`], paths }))
        .toMatchObject({ decision: "deny", hardReview: false, ruleIDs: ["standard.catastrophic.rm-system"] })
    },
  )

  test.each([
    ["shell", "git push origin main --force", "force-push"],
    ["shell", "DROP TABLE users", "database-destructive"],
    ["shell", "git branch -D feature", "git-destructive"],
    ["shell", "git clean -fd", "git-destructive"],
  ])("requires hard review for %s %s", (action, resource, id) => {
    expect(SessionGuardrailMatch.evaluate({ action, resources: [resource], paths }))
      .toMatchObject({ decision: "ask", hardReview: true, ruleIDs: [`standard.review.${id}`] })
  })

  test.each([
    "git push -u origin fix/branch 2>&1 | tail -3; rm -f \"$TMPDIR/body.md\"",
    "git push origin main && grep -f patterns.txt log",
    "git push origin main\nrm -f notes.txt",
    "git restore src/a.ts; echo --worktree",
    "cat > \"$TMPDIR/body.md\" <<'EOF'\n## Summary\nUse git push for the branch, then rm -f the draft.\nEOF\ngit push -u origin fix/branch && glab mr create --yes; rm -f \"$TMPDIR/body.md\"",
  ])("does not attribute a later command's flags to git: %s", (command) => {
    expect(SessionGuardrailStandard.match("shell", command)).toBeUndefined()
  })

  test.each([
    'echo "DROP TABLE scratch_items"',
    "printf 'TRUNCATE TABLE scratch_items\\n'",
    'grep -rn "drop table" packages',
    "rg -n 'DROP SCHEMA' .",
    'git log --grep="drop table" --oneline',
    'cat schema.sql | grep -i "drop table"',
    'echo "DROP TABLE a" | grep -c TABLE',
    "ls # drop table users",
    'psql -c "select 1" # DROP TABLE users',
    'grep -n "delete from" a.sql\n# truncate table b',
    "# DROP TABLE users\nls",
    'echo "DROP TABLE a" && psql -c "select 1"',
    'grep "DROP DATABASE" . ; echo done',
    'git commit -m "drop table migration"',
    'git checkout -b drop-table-fix',
    'gh api /repos/owner/repo/issues -f title="Fix drop table issue"',
    "sqlite3 db.sqlite \"SELECT * FROM audit WHERE action = 'DROP TABLE'\"",
    "psql -c \"SELECT 'DROP TABLE users' AS statement\"",
    "sqlite3 db.sqlite \"SELECT count(*) FROM t WHERE query LIKE 'delete from %'\"",
  ])("does not review SQL that is only printed, searched or commented: %s", (command) => {
    expect(SessionGuardrailStandard.match("shell", command)).toBeUndefined()
    expect(SessionGuardrailMatch.evaluate({ action: "shell", resources: [command], paths })).toMatchObject({ decision: "allow" })
  })

  test.each([
    'psql -c "DROP TABLE scratch_items"',
    "mysql -e 'TRUNCATE TABLE t'",
    'sqlite3 db.sqlite "DROP TABLE t"',
    'sqlite3 /tmp/temp.db "DROP TABLE t"',
    'sqlite3 ./disposable.db "DROP TABLE t"',
    'echo "DROP TABLE t" | psql',
    "printf 'DROP TABLE t;' | mysql",
    "cat <<'EOF' | psql\nDROP TABLE t;\nEOF",
    "psql <<'EOF'\nDROP TABLE t;\nEOF",
    'psql -f - <<< "DROP TABLE t"',
    "cat <<'EOF'\nDROP TABLE t\nEOF",
    "bash -c 'echo \"DROP TABLE x\"'",
    `sh -c "psql -c 'DROP TABLE x'"`,
    'echo "$(psql -c \'DROP TABLE x\')"',
    "echo `psql -c 'drop table x'`",
    "python -c \"import db; db.run('DROP TABLE x')\"",
    'bun run -e "db.query(\'DROP TABLE x\')"',
    'node -e "db.query(\'DROP TABLE x\')"',
    'echo hi > out.sql; psql -c "DROP TABLE x"',
    'grep x file && psql -c "DROP TABLE x"',
    'echo "DROP TABLE x" > script.sql',
    'echo "DROP TABLE x" |& psql',
    'echo "DROP TABLE x" & psql',
    'sudo echo "DROP TABLE x"',
    'env PGPASSWORD=x psql -c "DROP TABLE x"',
    'psql -c "select 1 # DROP TABLE x"',
    "bash <<'EOF'\n# note\ndrop table x\nEOF",
    'echo "DROP TABLE x" | tee run.sql | psql',
    "xargs -I{} psql -c {} <<< 'DROP TABLE x'",
    'sqlite3 db.sqlite "DELETE FROM t; SELECT 1"',
    'sqlite3 db.sqlite "CREATE TABLE t (id int); DELETE FROM t; SELECT 1"',
    'sqlite3 :memory: "ATTACH DATABASE \'live.db\' AS live; DROP TABLE live.t"',
    'sqlite3 :memory: "ATTACH \'live.db\' AS live; DELETE FROM live.t"',
    'sqlite3 :memory: "DROP TABLE t; $EXPANSION"',
    'sqlite3 :memory: "DROP TABLE $(cat file)"',
    'git commit -m "drop table" && psql -c "DROP TABLE b"',
    'sqlite3 :memory: "DROP TABLE a"; psql -c "DROP TABLE b"',
    'psql -c "SELECT 1" -c "DROP TABLE t"',
    'mysql -e "SELECT 1" -e "DROP TABLE t"',
    'sqlite3 :memory: ".open prod.db" "DROP TABLE t"',
    'sqlite3 :memory: ".read migration.sql" "DROP TABLE t"',
    'sqlite3 :memory: ".output prod.sql" "DROP TABLE t"',
    'sqlite3 -cmd ".read script.sql" :memory: "DROP TABLE t"',
    'sqlite3 :memory: "DROP TABLE t" | psql',
    'cat migration.sql | sqlite3 :memory: "DROP TABLE t"',
    'psql -c "SELECT dblink_exec(\'conn\', \'DROP TABLE t\')"',
    'sqlite3 db.sqlite "SELECT load_extension(\'ext\'); DROP TABLE t"',
    'curl -H "Content-Type: application/json" -d \'{"query":"DROP TABLE scratch"}\' http://localhost:8080/api/execute',
    'curl -d "DROP TABLE scratch" http://localhost:8080/api/query',
    'sqlite3 :memory: "DROP TABLE t"',
    'sqlite3 :memory: "TRUNCATE TABLE t"',
    'sqlite3 :memory: "DELETE FROM t"',
    'sqlite3 "" "DROP TABLE t"',
    'echo "DROP TABLE t" | sqlite3 :memory:',
    'sqlite3 :memory: "CREATE TABLE t (id int); DROP TABLE t"',
    'git rebase --exec "psql -c \'DROP TABLE users\'"',
    'psql -c "SELECT run_sql(\'DROP TABLE users\')"',
    'psql -c "SELECT \'DROP TABLE\'" -f live.sql',
    'psql --command="DROP TABLE live"',
    'psql -c "EXPLAIN ANALYZE DROP TABLE users"',
    'gh api /repos/owner/repo/issues --raw-field query="DROP TABLE users"',
  ])("still reviews SQL that can execute or is not proven inert: %s", (command) => {
    expect(SessionGuardrailStandard.match("shell", command)).toMatchObject({
      id: "standard.review.database-destructive",
      hardReview: true,
    })
  })

  test.each([
    `psql -c "SELECT 'it''s DROP TABLE users'"`,
    `psql --command="SELECT 'DROP TABLE users'"`,
    `mysql --execute="SELECT 'DROP TABLE users'"`,
    `sqlite3 db.sqlite "SELECT 1 /* DROP TABLE users */"`,
    `psql -c "SELECT 1 -- DROP TABLE users"`,
    `psql -c "/* DROP TABLE users */ SELECT 1"`,
    `psql -c "SELECT 'DROP TABLE a'; SELECT 'DROP TABLE b'"`,
    `psql -c "EXPLAIN SELECT 'DROP TABLE users'"`,
  ])("SQL boundary distinguishes literal data and comments: %s", (command) => {
    expect(SessionGuardrailStandard.match("shell", command)).toBeUndefined()
    expect(SessionGuardrailMatch.evaluate({ action: "shell", resources: [command], paths }))
      .toMatchObject({ decision: "allow", hardReview: false })
  })

  test.each([
    `psql -c "/* harmless */ SELECT 1" -f /outside/input.sql`,
    `mysql -e "/* harmless */ SELECT 1" < /outside/input.sql`,
    `psql -c '\\copy items FROM "/outside/input.csv"'`,
    `psql --command='\\copy items TO "/outside/output.csv"'`,
    `psql -c '\\copy (SELECT * FROM items) TO "/outside/output.csv"'`,
    `psql -c '\\i /outside/input.sql'`,
    `psql -c '\\ir /outside/input.sql'`,
    `psql -c '\\o /outside/output.txt'`,
    `psql -c '\\w /outside/output.sql'`,
    `psql --file=/outside/input.sql`,
    `sqlite3 -init /outside/init.sql db.sqlite "SELECT 1"`,
    `sqlite3 db.sqlite ".read /outside/input.sql"`,
    `sqlite3 db.sqlite ".import --csv /outside/input.csv items"`,
    `sqlite3 db.sqlite ".import --skip 1 /outside/input.csv items"`,
    `sqlite3 db.sqlite ".import --schema main /outside/input.csv items"`,
    `sqlite3 db.sqlite "SELECT 1;\n.read /outside/input.sql"`,
    `sqlite3 db.sqlite "ATTACH '/outside/other.db' AS other"`,
    `sqlite3 db.sqlite "VACUUM INTO '/outside/copy.db'"`,
    `sqlite3 db.sqlite "SELECT readfile('/outside/input.txt')"`,
    `sqlite3 db.sqlite "SELECT writefile('/outside/output.txt', 'x')"`,
  ])("SQL query text does not hide separate outside file targets: %s", (command) => {
    expect(SessionGuardrailMatch.evaluate({ action: "shell", resources: [command], paths }))
      .toMatchObject({ decision: "ask", hardReview: false, ruleIDs: ["standard.review.outside-repo"] })
  })

  test("SQL server-side COPY path is not treated as a local file operand", () => {
    expect(SessionGuardrailMatch.evaluate({ action: "shell", resources: [
      `psql -c "COPY items FROM '/server/input.csv'"`,
    ], paths })).toMatchObject({ decision: "allow" })
  })

  test.each([
    `psql -c "SELECT 'DROP TABLE users'" | psql`,
    `sqlite3 db.sqlite "SELECT 'DROP TABLE users'" | bash`,
    `psql -c "SELECT 'DROP TABLE users'" > migration.sql`,
    `psql -c "SELECT 'DROP TABLE users'" < startup.sql`,
    `psql -c "SELECT 'DROP TABLE users'" -f startup.sql`,
    `psql -c "SELECT 'DROP TABLE users'" --file=startup.sql`,
    `psql -c "SELECT 'DROP TABLE users'" --command="DELETE FROM users; SELECT 1"`,
    `psql --command="SELECT run_sql('DROP TABLE users')"`,
    `mysql --execute="SELECT run_sql('DROP TABLE users')"`,
    `psql -c "SELECT 'DROP TABLE users' INTO OUTFILE 'migration.sql'"`,
    `psql -c "SELECT 'DROP TABLE users' \\gexec"`,
    `psql -c "EXPLAIN ANALYZE SELECT run_sql('DROP TABLE users')"`,
    `psql -c "SELECT 'DROP TABLE users'; DO $$ BEGIN EXECUTE 'DROP TABLE users'; END $$"`,
    `psql -c 'DO $body$ BEGIN EXECUTE $sql$DROP TABLE users$sql$; END $body$'`,
    `psql -c "SELECT 'DROP TABLE users'" -c "SELECT run_sql('DROP TABLE users')"`,
    `psql -c "SELECT 'DROP TABLE users"`,
    `mysql -e "SELECT 'a\\' ; DROP TABLE users; --'"`,
    `sqlite3 db.sqlite "SELECT 'DROP TABLE users'; DELETE FROM users; SELECT 1"`,
    `sqlite3 -cmd ".read startup.sql" db.sqlite "SELECT 'DROP TABLE users'"`,
    `sqlite3 db.sqlite "SELECT 'DROP TABLE users'" ".read startup.sql"`,
    `sqlite3 db.sqlite "SELECT 'DROP TABLE users'" ".output output.sql"`,
    `sqlite3 db.sqlite "SELECT 'DROP TABLE users'" ".open live.db"`,
    `sqlite3 db.sqlite "SELECT 'DROP TABLE users'; ATTACH 'live.db' AS live"`,
    `sqlite3 :memory: "SELECT 'DROP TABLE users'; SELECT writefile('output.sql', 'data')"`,
    `printf '\\x2eopen live.db\\nDROP TABLE users;\\n' | sqlite3 :memory:`,
    `printf '\\056read startup.sql\\nDROP TABLE users;\\n' | sqlite3 :memory:`,
    `printf '\\x2eoutput output.sql\\nDROP TABLE users;\\n' | sqlite3 :memory:`,
    `printf '\\x44ROP TABLE users;' | sqlite3 :memory:`,
    `printf '\\104ROP TABLE users;' | sqlite3 :memory:`,
    `printf '%b' '\\0104ROP TABLE users;' | sqlite3 :memory:`,
    `sqlite3 :memory: "DROP TABLE users" > /dev/null.backup`,
    `sqlite3 :memory: "DROP TABLE users" > /dev/null/output`,
    `sqlite3 file::memory:?cache=shared "DROP TABLE users"`,
    `git rebase --exec="psql -c 'DROP TABLE users'"`,
    `git -c alias.sql="!psql -c 'DROP TABLE users'" sql`,
    `git commit -m "DROP TABLE note" --config-env=core.editor=SQL_EDITOR`,
    `gh api /repos/owner/repo/issues --raw-field=query="DROP TABLE users"`,
    `gh api /repos/owner/repo/issues -F sql="DROP TABLE users"`,
    `gh api /repos/owner/repo/issues --input='{"sql":"DROP TABLE users"}'`,
    `gh api /repos/owner/repo/issues -f title="DROP TABLE note" -f query="DROP TABLE users"`,
    `gh api /sql -f title="DROP TABLE users"`,
    `curl --json '{"query":"DROP TABLE users"}' https://example.invalid/sql`,
    `bun -e "console.log('DROP TABLE users'); db.exec(input)"`,
    `python -c "print('DROP TABLE users'); connection.executescript(payload)"`,
    `sqlite3 db.sqlite "SELECT 'DROP TABLE a'"; psql -c "DROP TABLE b"`,
  ])("SQL boundary retains review for unproven execution context: %s", (command) => {
    expect(SessionGuardrailMatch.evaluate({ action: "shell", resources: [command], paths }))
      .toMatchObject({ decision: "ask", hardReview: true, ruleIDs: ["standard.review.database-destructive"] })
  })

  test.each([
    `printf '%s' "$SQL" | psql`,
    `printf '%b' "$SQL" | sqlite3 :memory:`,
    `printf '%s' "$SQL" | env psql`,
    `printf '%s' "$SQL" | command psql`,
    `psql -c '\\copy items TO PROGRAM "some-program"'`,
    `psql -c 'SELECT $$\\copy items TO PROGRAM "some-program"$$'`,
  ])("SQL boundary retains non-dismissible review for dynamic client input: %s", (command) => {
    expect(SessionGuardrailMatch.evaluate({ action: "shell", resources: [command], paths }))
      .toMatchObject({ decision: "ask", hardReview: true, reason: "Possible destructive database operation; execution is unproven", evidence: { confirmed: false, uncertainExecution: true } })
  })

  test("unknown SQLite import options retain ordinary file-operation review without an invented target", () => {
    expect(SessionGuardrailMatch.evaluate({ action: "shell", resources: [
      `sqlite3 db.sqlite ".import --unknown value /outside/input.csv items"`,
    ], paths })).toMatchObject({ decision: "ask", hardReview: false, ruleIDs: ["standard.review.outside-repo"],
      reason: "SQLite import file target is unproven", evidence: { resolvedTargets: [] } })
  })

  test("multiline SQL dollar text is not interpreted as a psql client file command", () => {
    const command = `psql -c 'SELECT $$\n\\copy items TO PROGRAM "/outside/program"\n$$'`
    expect(SessionGuardrailStandard.outsidePaths("shell", command, paths)).toEqual([])
    expect(SessionGuardrailMatch.evaluate({ action: "shell", resources: [command], paths }))
      .toMatchObject({ decision: "ask", hardReview: true, reason: "Possible destructive database operation; execution is unproven", evidence: { confirmed: false, uncertainExecution: true, resolvedTargets: [] } })
  })

  test.each([
    `psql -c 'SELECT "\\i /outside/fake.sql"'`,
    `psql -c 'SELECT "\\o /outside/fake.sql"'`,
  ])("SQL quoted identifiers do not create client file targets: %s", (command) => {
    expect(SessionGuardrailStandard.outsidePaths("shell", command, paths)).toEqual([])
  })

  test.each([
    [`sqlite3 db.sqlite ".import --unknown value file items"; touch /outside/real`, undefined],
    [`sqlite3 db.sqlite ".import --unknown value file items"`, `touch /outside/real`],
  ])("unknown SQLite import retains independent outside target: %s", (first, second) => {
    expect(SessionGuardrailMatch.evaluate({ action: "shell", resources: second ? [first, second] : [first], paths }))
      .toMatchObject({ decision: "ask", hardReview: false, reason: "SQLite import file target is unproven", evidence: {
        uncertainFilesystem: true, resolvedTargets: ["/outside/real"],
      } })
  })

  test("dynamic printf without a database sink remains ordinary shell work", () => {
    expect(SessionGuardrailStandard.match("shell", `printf '%s' "$SQL"`)).toBeUndefined()
  })

  test.each([
    `sqlite3 * "SELECT 'DROP TABLE users'"`,
    `sqlite3 ~/db.sqlite "SELECT 'DROP TABLE users'"`,
    `gh api /repos/owner/repo/issues -F title="@DROP TABLE payload"`,
    `sqlite3 db.sqlite "DELETE FROM users -- cleanup"`,
    `sqlite3 db.sqlite "DELETE FROM users /* cleanup */"`,
    `sqlite3 db.sqlite 'DELETE FROM "user table"; SELECT 1'`,
    `sqlite3 db.sqlite "DELETE FROM \\"user table\\" -- cleanup"`,
    `sqlite3 db.sqlite 'DELETE FROM [user table]; SELECT 1'`,
  ])("SQL boundary rejects expansion, file input and commented unqualified deletion: %s", (command) => {
    expect(SessionGuardrailMatch.evaluate({ action: "shell", resources: [command], paths }))
      .toMatchObject({ decision: "ask", hardReview: true, ruleIDs: ["standard.review.database-destructive"] })
  })

  test.each([
    `sqlite3 db.sqlite "DELETE FROM users WHERE id = 1"`,
    `sqlite3 db.sqlite "DELETE FROM users /* bounded */ WHERE id = 1"`,
    `sqlite3 db.sqlite 'DELETE FROM "user table" WHERE id = 1'`,
  ])("SQL boundary preserves qualified deletion behavior: %s", (command) => {
    expect(SessionGuardrailStandard.match("shell", command)).toBeUndefined()
  })

  test.each([
    `bun -e "const text = 'DROP TABLE users'; console.log(text)"`,
    `python -c "db.run('DROP TABLE users')"`,
    `python <<'EOF'\ndb.run('DROP TABLE users')\nEOF`,
    `cat <<'TEXT'\nDROP TABLE users\nTEXT\npython <<'CODE'\ndb.run('DROP TABLE users')\nCODE`,
  ])("SQL boundary marks opaque source as non-dismissible uncertainty, not proven execution: %s", (command) => {
    expect(SessionGuardrailMatch.evaluate({ action: "shell", resources: [command], paths }))
      .toMatchObject({ decision: "ask", hardReview: true, reason: "Possible destructive database operation; execution is unproven", evidence: {
        confirmed: false, uncertainExecution: true,
      } })
  })

  test.each([
    `mariadb -e "SELECT 1 /*M! ; DROP TABLE users */"`,
    `sqlite3 db.sqlite "SELECT 'DROP TABLE users'\n.shell psql"`,
  ])("SQL boundary rejects executable comment and line-command syntax: %s", (command) => {
    expect(SessionGuardrailMatch.evaluate({ action: "shell", resources: [command], paths }))
      .toMatchObject({ decision: "ask", hardReview: true, ruleIDs: ["standard.review.database-destructive"] })
  })

  test.each([
    `echo "DROP TABLE note" > notes.sql; psql -c "DROP TABLE users"`,
    `cat <<'EOF'\nDROP TABLE note\nEOF\npsql -c "DROP TABLE users"`,
  ])("SQL boundary reports later confirmed execution instead of an early dismissible mention: %s", (command) => {
    expect(SessionGuardrailMatch.evaluate({ action: "shell", resources: [command], paths }))
      .toMatchObject({ decision: "ask", hardReview: true, evidence: {
        matchedSegment: `psql -c "DROP TABLE users"`, confirmed: true,
      } })
  })

  test.each([
    [[`echo "DROP TABLE note" > notes.sql`, `psql -c "DROP TABLE users"`], true],
    [[`python -c "db.run('DROP TABLE note')"`, `psql -c "DROP TABLE users"`], true],
    [[`echo "DROP TABLE note" > notes.sql`, `python -c "db.run('DROP TABLE users')"`], false],
  ] as const)("SQL request boundary prioritizes non-dismissible evidence across resources: %j", (resources, confirmed) => {
    expect(SessionGuardrailMatch.evaluate({ action: "shell", resources, paths }))
      .toMatchObject({ decision: "ask", hardReview: true, evidence: {
        matchedSegment: resources[1], confirmed, ...(confirmed ? {} : { uncertainExecution: true }),
      } })
  })

  test("SQL request boundary preserves precedence of a different first hard rule", () => {
    expect(SessionGuardrailMatch.evaluate({ action: "shell", resources: [
      "git push --force origin main", `echo "DROP TABLE note" > notes.sql`, `psql -c "DROP TABLE users"`,
    ], paths })).toMatchObject({ ruleIDs: ["standard.review.force-push"], hardReview: true })
  })

  test.each([
    `sqlite3 db.sqlite "DELETE FROM users RETURNING *"`,
    `sqlite3 db.sqlite 'DELETE FROM "tenant space"."user table"; SELECT 1'`,
    `psql -c "DROP /* migration */ TABLE users"`,
    `psql -c "DROP/* migration */TABLE users"`,
  ])("SQL prefilter boundary retains destructive returning, qualified identifiers and comment-separated tokens: %s", (command) => {
    expect(SessionGuardrailMatch.evaluate({ action: "shell", resources: [command], paths }))
      .toMatchObject({ decision: "ask", hardReview: true, ruleIDs: ["standard.review.database-destructive"] })
  })

  test.each([
    `ls # DELETE FROM users\n`,
    `echo "DELETE FROM users"; ls`,
    `printf 'DELETE FROM users'; psql -c "SELECT 1"`,
    `sqlite3 db.sqlite "SELECT 'DROP /* migration */ TABLE users'"`,
    `sqlite3 db.sqlite 'DELETE FROM "tenant space"."user table" WHERE id = 1'`,
  ])("SQL prefilter boundary preserves inert source ranges and qualified deletion: %s", (command) => {
    expect(SessionGuardrailStandard.match("shell", command)).toBeUndefined()
    expect(SessionGuardrailMatch.evaluate({ action: "shell", resources: [command], paths }))
      .toMatchObject({ decision: "allow", hardReview: false })
  })

  test.each([
    `psql -c "DELETE FROM ONLY users"`,
    `psql -c "DELETE FROM users AS u USING teams t RETURNING u.id"`,
    `psql -c 'DELETE FROM "tenant space"."user table" AS "u alias"'`,
    `psql -c "DELETE FROM users USING teams WHEREVER id = 1"`,
    `psql -c "DELETE FROM users USING (SELECT 1 WHERE true) q"`,
    `psql -c "DELETE FROM users WHERE run_sql('DROP TABLE users')"`,
  ])("SQL deletion policy boundary reviews unknown or unqualified suffixes: %s", (command) => {
    expect(SessionGuardrailMatch.evaluate({ action: "shell", resources: [command], paths }))
      .toMatchObject({ decision: "ask", hardReview: true, ruleIDs: ["standard.review.database-destructive"] })
  })

  test.each([
    `psql -c "DELETE FROM ONLY users AS u WHERE u.id = 1"`,
    `psql -c "DELETE FROM users AS u USING teams t WHERE u.id = t.id RETURNING u.id"`,
    `psql -c 'DELETE FROM "tenant space"."user table" AS "u alias" WHERE id = 1'`,
    `psql -c "SELECT 'DELETE FROM users USING teams'"`,
    `psql -c "SELECT 1 /* DELETE FROM users USING teams */"`,
  ])("SQL deletion policy boundary preserves top-level WHERE and inert text: %s", (command) => {
    expect(SessionGuardrailStandard.match("shell", command)).toBeUndefined()
  })

  test.each([
    `psql -c "DELETE FROM users AS u"`,
    `psql -c "DELETE FROM users u RETURNING u.id"`,
    `psql -c 'DELETE FROM "tenant space"."user table" AS u RETURNING u.id'`,
  ])("SQL alias boundary reviews unconditional deletion: %s", (command) => {
    expect(SessionGuardrailMatch.evaluate({ action: "shell", resources: [command], paths }))
      .toMatchObject({ decision: "ask", hardReview: true, ruleIDs: ["standard.review.database-destructive"] })
  })

  test.each([
    `psql -c "DELETE FROM users AS u WHERE u.id = 1"`,
    `psql -c "DELETE FROM users u WHERE u.id = 1 RETURNING u.id"`,
    `psql -c "SELECT 'DELETE FROM users AS u'"`,
  ])("SQL alias boundary preserves bounded and inert cases: %s", (command) => {
    expect(SessionGuardrailStandard.match("shell", command)).toBeUndefined()
  })

  test("reports the executed segment as the verification evidence for a mixed command", () => {
    expect(SessionGuardrailStandard.match("shell", 'echo "DROP TABLE a" && psql -c "DROP TABLE b"')).toMatchObject({
      id: "standard.review.database-destructive",
      evidence: { matchedSegment: 'psql -c "DROP TABLE b"' },
    })
  })

  test("a printed SQL mention does not hide other hard rules in the same command", () => {
    expect(SessionGuardrailStandard.match("shell", 'echo "DROP TABLE a"; git push --force origin main')).toMatchObject({
      id: "standard.review.force-push",
    })
    expect(SessionGuardrailMatch.evaluate({ action: "shell", resources: ['echo "DROP TABLE a"; rm -rf /'], paths }))
      .toMatchObject({ decision: "deny", ruleIDs: ["standard.catastrophic.rm-root"] })
  })

  test.each([
    ["rm -f notes.txt; git push --force-with-lease origin main", "force-push"],
    ["cd repo && git push -f origin main", "force-push"],
    ["bash <<'EOF'\ngit push origin main --force\nEOF", "force-push"],
    ["echo start | git branch -D feature", "git-destructive"],
  ])("still reviews a Git operation inside a compound command: %s", (command, id) => {
    expect(SessionGuardrailStandard.match("shell", command)).toMatchObject({ id: `standard.review.${id}`, hardReview: true })
  })

  test.each([
    ["shell", "npm publish"], ["shell", "terraform apply"], ["shell", "kubectl apply production"],
    ["shell", "chmod 777 file"], ["shell", "ufw disable"], ["mcp_execute", "server command"],
  ])("does not review non-destructive in-repo work: %s %s", (action, resource) => {
    expect(SessionGuardrailMatch.evaluate({ action, resources: [resource], paths }))
      .toMatchObject({ decision: "allow", hardReview: false, ruleIDs: [] })
  })

  test.each([
    ["file_mutation", "/outside/new.txt"], ["file_mutation", "../new.txt"],
    ["shell", "touch /outside/new.txt"], ["shell", "touch ../new.txt"],
    ["shell", "cd /outside && task-runner execute"], ["shell", "cd ../other; touch file"],
    ["shell", "task-runner --output=/outside/new.txt"], ["shell", "printf x > /outside/new.txt"],
    ["shell", "printf x 2>>/outside/new.txt"], ["shell", "touch '$HOME/new.txt'"],
    ["shell", "touch '${PWD}/../new.txt'"], ["shell", "touch ~/new.txt"], ["shell", "rm -f /outside/new.txt"],
    ["shell", "echo x > /outside/file"], ["shell", "echo x>/outside/file"], ["shell", "echo x &>/outside/file"],
    ["shell", "printf x >>~/outside.log"], ["shell", "cp a ~/outside"], ["shell", "echo x | tee /outside/file"],
    ["shell", "cat <<'EOF' > /outside/file\nbody\nEOF"], ["shell", "bash <<'EOF'\ntouch /outside/file\nEOF"],
    ["shell", "cat <<'EOF' | sh\ntouch /outside/file\nEOF"], ["shell", "cat <<EOF > notes.md\n$(touch /outside/file)\nEOF"],
    ["shell", "cat <<'EOF' > notes.md\nbody\nEOF\ntouch /outside/file"],
    ["shell", "git -C /outside commit -m msg"],
    ["shell", "git checkout -b x /outside/file"], ["shell", "curl -o /outside/file https://example.com/a"],
  ])("reviews recognized outside-repo paths: %s %s", (action, resource) => {
    expect(SessionGuardrailMatch.evaluate({ action, resources: [resource], paths }))
      .toMatchObject({ decision: "ask", hardReview: false, ruleIDs: ["standard.review.outside-repo"] })
  })

  test.each([
    ["file_mutation", "src/file"], ["file_mutation", "/workspace/project/file"], ["file_mutation", "/tmp/file"],
    ["shell", "task-runner execute"], ["shell", "/usr/bin/env task-runner execute"],
    ["shell", "cd src && touch ../file"],
    ["shell", "touch /tmp/file /private/tmp/file /var/tmp/file /private/var/tmp/file /var/folders/cache/file"],
    ["shell", "cat /outside/file; git -C /outside status"], ["shell", "printf x >/dev/null"], ["read", "/outside/file"],
    ["shell", "cat <<'EOF' > notes.md\nSee /Users/other/repo and ~/elsewhere\nrm -rf ~\nEOF"],
    ["shell", "cat <<-EOF > notes.md\n\tPlain /outside/text\n\tEOF"],
    ["shell", "git add -A && git commit -q -m \"fix: handle /outside/path text\" 2>&1 | tail -3"],
    ["shell", "git commit -am \"/abs text\""], ["shell", "git commit --message=\"/abs text\""],
    ["shell", "git commit -m \"$(cat <<'EOF'\nfix: touch /outside/file in docs\nEOF\n)\""],
    ["shell", "gh pr create --title \"/abs title\" --body \"See /outside/file\" 2>&1"],
    ["shell", "gh api /repos/owner/repo/pulls > pulls.json"], ["shell", "echo /outside/file > notes.txt"],
    ["shell", "printf '%s\\n' /outside/a ~/b > notes.txt"], ["shell", "task-runner fetch https://example.com/outside/path"],
    ["shell", "task-runner run 2>&1 | tail -5"], ["shell", "task-runner run &>/dev/null"],
  ])("keeps repo, temporary, device, executable and read-only paths exempt: %s %s", (action, resource) => {
    expect(SessionGuardrailMatch.evaluate({ action, resources: [resource], paths }))
      .toMatchObject({ decision: "allow", hardReview: false, ruleIDs: [] })
  })

  test.each([
    "ycoding api GET /api/session/outstanding",
    "ycoding api GET /api/provider/muse",
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
    "python3 -c 'print(\"open('/outside/out.txt','w')\")'",
    "python3 - <<'PY'\n# open('/outside/out.txt','w')\nprint(1)\nPY",
    "python3 - <<'PY'\ns = \"\"\"open('/outside/out.txt','w')\"\"\"\nprint(s)\nPY",
    "curl -b session=abc https://example.com/api/session",
    "curl -d @body.json https://example.com/api/session",
    "curl -H 'X-Info: file:///outside/note' https://example.com",
    "curl 'https://example.com/?next=file:///outside/note'",
    "curl --referer 'file:///outside/note' https://example.com",
    "curl -d 'next=file:///outside/note' https://example.com/api/session",
  ])("does not treat API routes, client strings or in-memory code as outside file targets: %s", (command) => {
    expect(SessionGuardrailMatch.evaluate({ action: "shell", resources: [command], paths }))
      .toMatchObject({ decision: "allow", hardReview: false, ruleIDs: [] })
    expect(SessionGuardrailStandard.outsidePaths("shell", command, paths)).toEqual([])
  })

  test.each([
    "for s in ses_a ses_b; do ycoding api GET /api/session/$s | python3 -c 'import json,sys; print(json.load(sys.stdin)[\"id\"])'; done",
    "gh api /repos/x/y",
    "for run in 1 2; do gh api /repos/x/y/actions/runs/$run --jq .status; done",
  ])("API request path operands are not outside-repository targets: %s", (command) => {
    expect(SessionGuardrailMatch.evaluate({ action: "shell", resources: [command], paths }))
      .toMatchObject({ decision: "allow", hardReview: false, ruleIDs: [] })
    expect(SessionGuardrailStandard.outsidePaths("shell", command, paths)).toEqual([])
  })

  test.each([
    "cat /some/outside/file",
    "git -C /outside/repo log",
    "for f in a b; do cat /outside/notes.md; done",
    "if test -f /outside/notes.md; then head -5 /outside/notes.md; fi",
  ])("read-only commands reading outside the repository are not outside-repository mutations: %s", (command) => {
    expect(SessionGuardrailMatch.evaluate({ action: "shell", resources: [command], paths }))
      .toMatchObject({ decision: "allow", hardReview: false, ruleIDs: [] })
    expect(SessionGuardrailStandard.outsidePaths("shell", command, paths)).toEqual([])
  })

  test.each([
    ["for x in a; do rm -rf /; done", "standard.catastrophic.rm-root"],
    ["if true; then rm -rf ~; fi", "standard.catastrophic.rm-user-home"],
  ])("deletion deny rules fire inside loop and conditional bodies: %s", (command, id) => {
    expect(SessionGuardrailMatch.evaluate({ action: "shell", resources: [command], paths }))
      .toMatchObject({ decision: "deny", ruleIDs: [id] })
  })

  test("an in-repo deletion inside a loop body keeps its ordinary decision", () => {
    expect(SessionGuardrailMatch.evaluate({ action: "shell", resources: ["for f in a b; do rm -f build/$f; done"], paths }))
      .toMatchObject({ decision: "allow", hardReview: false, ruleIDs: [] })
  })

  test.each([
    "for f in a b; do cp notes.md /outside/$f; done",
    "if test -f notes.md; then cp notes.md /outside/copy.md; fi",
  ])("loop and conditional bodies that write outside the repository stay reviewed: %s", (command) => {
    expect(SessionGuardrailMatch.evaluate({ action: "shell", resources: [command], paths }))
      .toMatchObject({ decision: "ask", hardReview: false, ruleIDs: ["standard.review.outside-repo"] })
  })

  test.each([
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
  ])("keeps real file targets in API and interpreter commands reviewed: %s", (command) => {
    expect(SessionGuardrailMatch.evaluate({ action: "shell", resources: [command], paths }))
      .toMatchObject({ decision: "ask", hardReview: false, ruleIDs: ["standard.review.outside-repo"] })
  })

  test("keeps custom, hard and catastrophic rules for API-shaped commands", () => {
    const rules = layer([
      custom({ id: "review-api-mutations", decision: "hard_review", actions: ["shell"], resources: ["ycoding api *"] }),
    ])
    expect(
      SessionGuardrailMatch.evaluate({
        action: "shell",
        resources: ["ycoding api session.remove -d '{}'"],
        paths,
        custom: [rules],
      }),
    ).toMatchObject({ decision: "ask", hardReview: true, ruleIDs: ["review-api-mutations"] })
    expect(SessionGuardrailMatch.evaluate({ action: "shell", resources: ["ycoding api GET /api/x; rm -rf /"], paths }))
      .toMatchObject({ decision: "deny", ruleIDs: ["standard.catastrophic.rm-root"] })
    expect(SessionGuardrailMatch.evaluate({ action: "shell", resources: ["ycoding api GET /api/x; git push --force origin main"], paths }))
      .toMatchObject({ decision: "ask", hardReview: true, ruleIDs: ["standard.review.force-push"] })
  })

  test("shell advisory targets include read-only file operands but not routes or executables", () => {
    expect(SessionGuardrailStandard.shellFileTargets("ycoding api GET /api/session/outstanding", paths)).toEqual([])
    expect(SessionGuardrailStandard.shellFileTargets("/usr/local/bin/ycoding api GET /api/session/outstanding", paths)).toEqual([])
    expect(SessionGuardrailStandard.shellFileTargets("cat /outside/secret.txt", paths)).toContain("/outside/secret.txt")
    expect(SessionGuardrailStandard.shellFileTargets("readlink /home/user/.local/bin/ycoding", paths))
      .toContain("/home/user/.local/bin/ycoding")
    expect(SessionGuardrailStandard.shellFileTargets("curl -o /outside/file https://example.com/api", paths))
      .toContain("/outside/file")
    expect(SessionGuardrailStandard.shellFileTargets("curl -s https://example.com/api > /outside/out", paths))
      .toContain("/outside/out")
    expect(SessionGuardrailStandard.shellFileTargets("python3 /outside/script.py", paths)).toContain("/outside/script.py")
    expect(SessionGuardrailStandard.shellFileTargets("python3 -u /outside/script.py", paths)).toContain("/outside/script.py")
    expect(SessionGuardrailStandard.shellFileTargets("python3 -c \"print(open('/outside/notes.md').read())\"", paths))
      .toContain("/outside/notes.md")
    expect(SessionGuardrailStandard.shellFileTargets("python3 -c \"from pathlib import Path; Path('/outside/notes.md').read_text()\"", paths))
      .toContain("/outside/notes.md")
    expect(SessionGuardrailStandard.shellFileTargets("python3 -c 'print(\"open('/outside/out.txt','w')\")'", paths))
      .not.toContain("/outside/out.txt")
    expect(SessionGuardrailStandard.shellFileTargets("curl -d @body.json https://example.com/api/session", paths))
      .toContain("/workspace/project/body.json")
    expect(SessionGuardrailStandard.shellFileTargets("curl file:///outside/secret.txt", paths)).toContain("/outside/secret.txt")
    expect(SessionGuardrailStandard.shellFileTargets("curl file:///outside/a%20b.txt", paths)).toContain("/outside/a b.txt")
    expect(SessionGuardrailStandard.shellFileTargets("curl -H 'X-Info: file:///outside/note' https://example.com", paths))
      .not.toContain("/outside/note")
    expect(SessionGuardrailStandard.shellFileTargets("curl 'https://example.com/?next=file:///outside/note'", paths))
      .not.toContain("/outside/note")
    expect(SessionGuardrailStandard.shellFileTargets("curl -H @/outside/headers.txt https://example.com/api/session", paths))
      .toContain("/outside/headers.txt")
    expect(SessionGuardrailStandard.outsidePaths("shell", "python3 /outside/script.py", paths)).toEqual([])
  })

  test.each([
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
  ])("does not review read-only inspection or executed script paths: %s", (command) => {
    expect(SessionGuardrailMatch.evaluate({ action: "shell", resources: [command], paths }))
      .toMatchObject({ decision: "allow", hardReview: false, ruleIDs: [] })
  })

  test.each([
    "cd /outside && sed -i 's/a/b/' file",
    "cd /outside && node build.mjs",
    "cat file > /outside/out; ls",
    "ls; grep x file | tee /outside/out",
    "python3 script.py > /outside/out",
    "python3 /outside/tool.py --write /outside/out",
    "cd /outside && python3 - <<'PY'\nopen('x', 'w').write('y')\nPY",
    "ls; cat $(touch /outside/file)",
    "cd /outside || exit 1; touch file",
  ])("keeps writes and execution outside the repository reviewed: %s", (command) => {
    expect(SessionGuardrailMatch.evaluate({ action: "shell", resources: [command], paths }))
      .toMatchObject({ decision: "ask", hardReview: false, ruleIDs: ["standard.review.outside-repo"] })
  })

  test.each([
    ["cd /outside && rm -rf ~/Documents", "standard.review.home-child"],
    ["cd /outside || exit 1; git reset --hard HEAD", "standard.review.git-destructive"],
    ["python3 /outside/tool.py; git push --force", "standard.review.force-push"],
  ])("keeps hard review for %s", (command, id) => {
    expect(SessionGuardrailMatch.evaluate({ action: "shell", resources: [command], paths }))
      .toMatchObject({ decision: "ask", hardReview: true, ruleIDs: [id] })
  })

  test("lets custom hard review override ordinary allows across source layers while preserving an effective deny", () => {
    const hard = custom({
      id: "human-review-aws-close",
      decision: "hard_review",
      actions: ["shell"],
      resources: ["aws account close-account*"],
    })
    expect(
      SessionGuardrailMatch.evaluate({
        action: "shell",
        resources: ["aws account close-account --account-id 111122223333"],
        custom: [
          layer([custom({ id: "nearest-allow", decision: "allow", actions: ["shell"], resources: ["aws *"] })]),
          layer([hard]),
        ],
      }),
    ).toMatchObject({ decision: "ask", hardReview: true, standard: false, ruleIDs: [hard.id] })
    expect(
      SessionGuardrailMatch.evaluate({
        action: "shell",
        resources: ["aws account close-account --account-id 111122223333"],
        custom: [
          layer([custom({ id: "nearest-deny", decision: "deny", actions: ["shell"], resources: ["aws *"] })]),
          layer([hard]),
        ],
      }),
    ).toMatchObject({ decision: "deny", hardReview: false, ruleIDs: ["nearest-deny"] })
  })

  test("applies the synthetic AWS hard-review rule only to configured destructive operations", () => {
    const rules = layer([
      custom({
        id: "protect-aws-account-deletion",
        decision: "hard_review",
        actions: ["shell"],
        resources: ["aws organizations delete-organization*", "aws account close-account*"],
      }),
    ])
    for (const resource of [
      "aws organizations delete-organization",
      "aws account close-account --account-id 111122223333",
    ])
      expect(SessionGuardrailMatch.evaluate({ action: "shell", resources: [resource], custom: [rules] })).toMatchObject(
        {
          decision: "ask",
          hardReview: true,
          ruleIDs: ["protect-aws-account-deletion"],
        },
      )
    expect(
      SessionGuardrailMatch.evaluate({
        action: "shell",
        resources: ["aws organizations describe-organization"],
        custom: [rules],
      }),
    ).toMatchObject({ decision: "allow", hardReview: false })
  })

  test("takes the first matching custom source layer before broader repository and user layers", () => {
    expect(
      SessionGuardrailMatch.evaluate({
        action: "shell",
        resources: ["npm publish"],
        custom: [
          layer([custom({ id: "nearest-allow", decision: "allow", actions: ["shell"], resources: ["npm publish*"] })]),
          layer([custom({ id: "broader-deny", decision: "deny", actions: ["shell"], resources: ["npm publish*"] })]),
          layer([custom({ id: "user-deny", decision: "deny", actions: ["shell"], resources: ["npm publish*"] })]),
        ],
      }),
    ).toMatchObject({ decision: "allow", standard: false, ruleIDs: ["nearest-allow"] })
  })

  test("lets user custom decisions suppress the outside-repository review but never a standard hard review", () => {
    expect(
      SessionGuardrailMatch.evaluate({
        action: "shell",
        resources: ["cp notes.md ../sibling/notes.md"],
        paths,
        custom: [layer([custom({ id: "user-allow-copy", decision: "allow", actions: ["shell"], resources: ["cp *"] })])],
      }),
    ).toMatchObject({ decision: "allow", standard: false, ruleIDs: ["user-allow-copy"] })
    expect(
      SessionGuardrailMatch.evaluate({
        action: "shell",
        resources: ["git reset --hard HEAD~1"],
        paths,
        custom: [layer([custom({ id: "user-allow-reset", decision: "allow", actions: ["shell"], resources: ["git reset --hard*"] })])],
      }),
    ).toMatchObject({ decision: "ask", hardReview: true, ruleIDs: ["standard.review.git-destructive"] })
  })

  test("uses numeric priority then lexical file and rule order within one layer", () => {
    const rules = [
      custom({ id: "00-lexical-allow", decision: "allow", actions: ["shell"], resources: ["echo *"], priority: 10 }),
      custom({ id: "01-lexical-deny", decision: "deny", actions: ["shell"], resources: ["echo *"], priority: 10 }),
      custom({ id: "99-higher", decision: "ask", actions: ["shell"], resources: ["echo *"], priority: 20 }),
    ]
    expect(
      SessionGuardrailMatch.evaluate({ action: "shell", resources: ["echo safe"], custom: [layer(rules)] }),
    ).toMatchObject({ decision: "ask", ruleIDs: ["99-higher"] })
    expect(
      SessionGuardrailMatch.evaluate({ action: "shell", resources: ["echo safe"], custom: [layer(rules.slice(0, 2))] }),
    ).toMatchObject({ decision: "allow", ruleIDs: ["00-lexical-allow"] })
  })

  test("preserves invalid-file source priority and fails closed for mutations", () => {
    const result = SessionGuardrailMatch.evaluate({
      action: "shell",
      resources: ["echo mutate"],
      custom: [
        layer([], ["nearest-invalid.md"]),
        layer([custom({ id: "broader-allow", decision: "allow", actions: ["shell"], resources: ["echo *"] })]),
      ],
    })
    expect(result).toMatchObject({ decision: "ask", ruleIDs: ["configuration.invalid"] })
  })

  test("does not let an invalid file weaken a valid deny in the same source layer", () => {
    const result = SessionGuardrailMatch.evaluate({
      action: "shell",
      resources: ["npm publish"],
      custom: [
        layer(
          [custom({ id: "deny-publish", decision: "deny", actions: ["shell"], resources: ["npm publish*"] })],
          ["invalid.md"],
        ),
      ],
    })
    expect(result).toMatchObject({ decision: "deny", ruleIDs: ["deny-publish"] })
  })

  test("fails closed for mutations when custom configuration is invalid", () => {
    expect(
      SessionGuardrailMatch.evaluate({
        action: "file_mutation",
        resources: ["/workspace/a.ts"],
        custom: [layer([], ["invalid.md"])],
      }),
    ).toMatchObject({ decision: "ask", ruleIDs: ["configuration.invalid"] })
    expect(
      SessionGuardrailMatch.evaluate({
        action: "read",
        resources: ["/workspace/a.ts"],
        custom: [layer([], ["invalid.md"])],
      }),
    ).toMatchObject({ decision: "allow" })
  })
})
