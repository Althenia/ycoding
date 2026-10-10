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
    "excludes temp root %s even when it contains the project or is a home child", (root) => {
      expect(SessionGuardrailMatch.evaluate({ action: "shell", resources: [`rm -rf ${root} ${root}/x`],
        paths: { workdir: "/scratch/temp/project", project: "/scratch/temp/project", home: "/scratch", tmpdir: "/scratch/temp" },
      })).toMatchObject({ decision: "allow", hardReview: false, ruleIDs: [] })
    },
  )

  test("evaluates only the project in mixed temp and project deletion", () => {
    expect(SessionGuardrailMatch.evaluate({ action: "shell", resources: ["rm -rf /tmp/a /private/tmp/y ."], paths }))
      .toMatchObject({ decision: "ask", hardReview: true, ruleIDs: ["standard.review.project-deletion"] })
  })

  test.each(["/tmp", "/private/tmp", "/var/tmp", "/private/var/tmp", "/var/folders", "/scratch/temp"])(
    "temp %s overrides project and home deletion classification", (root) => {
      expect(SessionGuardrailMatch.evaluate({ action: "shell", resources: [`rm -rf ${root}`],
        paths: { workdir: `${root}/project`, project: `${root}/project`, home: root, tmpdir: "/scratch/temp" },
      })).toMatchObject({ decision: "allow", ruleIDs: [] })
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
  ])("keeps repo, temporary, device, executable and read-only paths exempt: %s %s", (action, resource) => {
    expect(SessionGuardrailMatch.evaluate({ action, resources: [resource], paths }))
      .toMatchObject({ decision: "allow", hardReview: false, ruleIDs: [] })
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
