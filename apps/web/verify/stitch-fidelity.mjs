import { spawn } from "node:child_process"
import { mkdir, mkdtemp, readdir, rm, stat } from "node:fs/promises"
import { basename, join, relative, resolve } from "node:path"
import { tmpdir } from "node:os"
import { STITCH_REMOTE_SCENARIOS } from "./stitch-remote-data.ts"

const root = resolve(import.meta.dirname, "../../..")
const web = join(root, "apps/web")
const approvedDirectory = join(root, ".aphrodite/stitch-review/export-adaptation")
const nativeManifestPath = join(root, ".verification-tmp/stitch-fidelity/native/manifest.json")
const buildDirectory = join(web, "output/stitch-remote-fidelity")
const outputDirectory = join(root, ".verification-tmp/stitch-remote-comparison")
const captureDirectory = join(outputDirectory, "captures")
const chrome = process.env.YCODING_WEB_CHROME
const families = ["r01", "r02", "r03", "r04", "r05", "r06", "r07", "r08"]
const widths = [1440, 768, 390]
const themes = ["dark", "light"]
const sourcePaths = [
  "apps/web/src/remote/ui/shell.tsx",
  "apps/web/src/remote/ui/conversation.tsx",
  "apps/web/src/remote/ui/composer.tsx",
  "apps/web/src/remote/ui/settings.tsx",
  "apps/web/src/styles/base.css",
  "apps/web/src/styles/remote.css",
  "apps/web/src/ui/custom-select.tsx",
  "apps/web/src/ui/custom-select.css",
  "apps/web/verify/remote-fixture.tsx",
  "apps/web/verify/stitch-remote-data.ts",
  "apps/web/verify/stitch-fidelity.mjs",
]

if (!chrome) throw new Error("Set YCODING_WEB_CHROME to an installed Chromium or Chrome executable.")

await mkdir(captureDirectory, { recursive: true })
const sourceBefore = await filesManifest(sourcePaths.map((path) => join(root, path)))
await buildFixture()
await requireUnchangedSource(sourceBefore, "while the remote fixture was built")

const nativeManifest = await Bun.file(nativeManifestPath).json()
const nativeEntries = nativeManifest.entries.filter((entry) => families.includes(entry.family))
if (nativeEntries.length !== families.length * widths.length) {
  throw new Error(`Expected ${families.length * widths.length} remote native bindings, received ${nativeEntries.length}.`)
}
for (const entry of nativeEntries) {
  if (await sha256(join(approvedDirectory, entry.path.slice(1))) !== entry.sourceSHA256) throw new Error(`Approved source changed for ${entry.family}-${entry.declaredWidth}.`)
  if (await sha256(join(root, entry.file)) !== entry.sha256) throw new Error(`Native capture changed for ${entry.family}-${entry.declaredWidth}.`)
}

const referenceServer = serve(approvedDirectory)
const buildServer = serve(buildDirectory)
const browser = await connectChrome(chrome)
const matrix = []
const probes = []

try {
  for (const family of families) {
    for (const width of widths) {
      const nativeEntry = nativeEntries.find((entry) => entry.family === family && entry.declaredWidth === width)
      const scenario = STITCH_REMOTE_SCENARIOS.find((entry) => entry.family === family && entry.specimen === width)
      if (!nativeEntry || !scenario) throw new Error(`Binding or fixture scenario missing for ${family}-${width}.`)

      for (const theme of themes) {
        console.log(`compare ${family}-${width}-${theme}`)
        const reference = await browser.page(1600, 5000, theme)
        await reference.navigate(`${referenceServer.origin}${nativeEntry.path}`)
        const native = await reference.evaluate(regionMeasurement(`[document.querySelector(${JSON.stringify(nativeEntry.selector)})]`))
        const nativeCapture = join(captureDirectory, `native-${family}-${width}-${theme}.png`)
        await reference.capture(nativeCapture, native.absoluteRect)
        await reference.close()

        const actual = await browser.page(width, actualViewportHeight(family, nativeEntry), theme)
        const query = `/verify/remote.html?stitch=${family}&specimen=${width}`
        await actual.navigate(`${buildServer.origin}${query}`)
        await waitForScenario(actual, scenario.expectedText, `${family}-${width}`)
        await actual.evaluate(`(() => {
          document.documentElement.dataset.theme = ${JSON.stringify(theme)};
          for (const element of document.querySelectorAll('.fixture__banner,.fixture__controls')) element.style.display = 'none';
        })()`)

        const behavior = await actual.evaluate(remoteBehavior())
        const failures = familyFailures(family, width, behavior)
        if (failures.length > 0) throw new Error(`${family} ${width}/${theme}: ${failures.join("; ")}`)

        const measured = await actual.evaluate(regionMeasurement(actualRoots(family, width)))
        const actualCapture = join(captureDirectory, `actual-${family}-${width}-${theme}.png`)
        await actual.capture(actualCapture, measured.absoluteRect)

        if (theme === "dark" && mutation(family, width) !== undefined) {
          const probe = mutation(family, width)
          await actual.evaluate(probe.apply)
          const rejectedBy = familyFailures(family, width, await actual.evaluate(remoteBehavior()))
          if (!rejectedBy.some((failure) => failure.includes(probe.expected))) {
            throw new Error(`${family} mutation probe was not rejected by ${probe.expected}.`)
          }
          await actual.evaluate(probe.restore)
          const restoredFailures = familyFailures(family, width, await actual.evaluate(remoteBehavior()))
          if (restoredFailures.length > 0) throw new Error(`${family} mutation probe did not restore: ${restoredFailures.join("; ")}`)
          probes.push({ family, specimen: width, mutation: probe.name, rejectedBy, restored: true })
        }
        await actual.close()

        const nativeImage = await imageEvidence(nativeCapture)
        const actualImage = await imageEvidence(actualCapture)
        if (!nativeImage.nonblank || !actualImage.nonblank) throw new Error(`Blank capture detected for ${family}-${width}-${theme}.`)
        matrix.push({
          id: `${family}-${width}-${theme}`,
          family,
          specimen: width,
          theme,
          sourceTheme: nativeEntry.theme,
          source: {
            path: repositoryPath(join(approvedDirectory, nativeEntry.path.slice(1))),
            sha256: nativeEntry.sourceSHA256,
            explicitSelector: nativeEntry.selector,
            manifestRect: nativeEntry.rect,
            measured: native,
            capture: repositoryPath(nativeCapture),
            captureSHA256: await sha256(nativeCapture),
            image: nativeImage,
          },
          actual: {
            query,
            target: actualTarget(family, width),
            behavior,
            measured,
            capture: repositoryPath(actualCapture),
            captureSHA256: await sha256(actualCapture),
            image: actualImage,
          },
          assertions: familyAssertions(family, width),
          exclusions: scenario.exclusions,
          status: "passed",
        })
      }
    }
  }
} finally {
  await browser.close()
  await referenceServer.stop()
  await buildServer.stop()
}

if (matrix.length !== families.length * widths.length * themes.length) throw new Error(`Expected 48 comparisons, received ${matrix.length}.`)
if (probes.length !== families.length || probes.some((probe) => !probe.restored)) throw new Error(`Expected ${families.length} restored mutation probes, received ${probes.length}.`)
await requireUnchangedSource(sourceBefore, "during the remote comparison")

const capturePattern = /^(?:actual|native)-r0[1-8]-(?:1440|768|390)-(?:dark|light)\.png$/
const report = {
  scope: "Source-matched R01-R08 remote workspace comparison at 1440, 768, and 390 in dark and light themes.",
  acceptance: "behavior and responsive-layout assertions passed",
  fidelity: "Measured approved-source and current-implementation evidence; exact-pixel parity is excluded and no numeric parity threshold is claimed.",
  manifests: {
    source: sourceBefore,
    approved: await filesManifest([...families.map((family) => join(approvedDirectory, `${family}.html`)), nativeManifestPath]),
    build: await directoryManifest(buildDirectory),
    captures: await directoryManifest(captureDirectory, (path) => capturePattern.test(basename(path))),
  },
  familyCounts: Object.fromEntries(families.map((family) => [family, matrix.filter((entry) => entry.family === family).length])),
  probes,
  matrix,
  remainingGates: [],
}
await Bun.write(join(outputDirectory, "report.json"), JSON.stringify(report, null, 2))
await Bun.write(join(outputDirectory, "manifest.json"), JSON.stringify(report.manifests, null, 2))
await Bun.write(join(outputDirectory, "review.html"), review(report))
console.log(JSON.stringify({ comparisons: matrix.length, familyCounts: report.familyCounts, captures: report.manifests.captures.length, probes, report: repositoryPath(join(outputDirectory, "report.json")) }, null, 2))

function familyFailures(family, width, value) {
  const common = [
    ...(value.overflow ? ["page has horizontal overflow"] : []),
    ...(!value.mainVisible ? ["workspace main is not visible"] : []),
    ...(value.bodyText.includes("New Session") ? ["unsupported New Session control is present"] : []),
    ...(value.bodyText.includes("[account name]") ? ["fake account identity placeholder is present"] : []),
  ]
  if (family === "r01") return [...common,
    ...(value.workspaceColumns !== (width >= 768 ? 2 : 1) ? [`workspace must have ${width >= 768 ? "two" : "one"} columns`] : []),
    ...(value.railVisible !== (width >= 768) ? ["Sessions rail visibility is wrong"] : []),
    ...(value.persistentActivity !== 0 ? ["persistent Activity aside must be absent"] : []),
    ...(!value.activityAccessible ? ["Activity must remain accessible"] : []),
    ...(value.bottomNavigationVisible !== (width < 768) ? ["bottom navigation visibility is wrong"] : []),
  ]
  if (family === "r02") return [...common,
    ...(value.appClasses.includes("app--empty") ? ["Sessions route must not use conversation-empty composition"] : []),
    ...(value.sessionRows !== 4 ? ["Sessions table must expose four source-matched sessions"] : []),
    ...(value.sessionsTableColumns !== (width === 768 ? 2 : 1) ? ["Sessions responsive columns are wrong"] : []),
    ...(width >= 1024 && value.sessionHeadColumns !== 4 ? ["desktop Sessions rows must expose four data columns"] : []),
    ...(value.sessionsHeadingVisible ? ["Sessions route must not repeat a visible page heading"] : []),
  ]
  if (family === "r03") return [...common,
    ...(value.transcriptMessages < 2 ? ["conversation transcript must contain source-matched messages"] : []),
    ...(!value.composerVisible ? ["conversation composer must be visible"] : []),
    ...(value.deliveryOptions.length !== 2 || value.deliveryOptions.filter((option) => option.pressed).length !== 1 ? ["delivery control must expose two options and one pressed state"] : []),
    ...(value.toolRows < 1 ? ["conversation tool output must be present"] : []),
  ]
  if (family === "r04") return [...common,
    ...(value.appClasses.includes("app--empty") ? ["Activity route must not use conversation-empty composition"] : []),
    ...(value.activityRows < 2 ? ["Activity must expose reported events"] : []),
    ...(value.requestCards !== 2 ? ["Activity must expose two pending decisions"] : []),
    ...(value.activityColumns !== (width >= 768 ? 2 : 1) ? ["Activity responsive columns are wrong"] : []),
    ...(width < 768 && !(value.decisionsY < value.eventsY) ? ["mobile pending decisions must precede reported events"] : []),
  ]
  if (family === "r05") return [...common,
    ...(value.requestCards !== (width === 1440 ? 6 : width === 768 ? 2 : 3) ? ["decision card count is wrong"] : []),
    ...(value.hardActions.some((actions) => JSON.stringify(actions) !== JSON.stringify(["Approve once", "Reject"])) ? ["hard review actions must be Approve once and Reject"] : []),
    ...(width === 1440 && !value.ordinaryActions.some((actions) => actions.includes("Always this process")) ? ["ordinary review must expose Always this process"] : []),
    ...(width !== 768 && !value.permissionActions.some((actions) => actions.includes("Always this session")) ? ["permission must expose Always this session"] : []),
    ...(value.bodyText.includes("Permission Guardrail") || value.bodyText.includes("Retry") ? ["unsupported decision control or label is present"] : []),
    ...(width < 1024 && value.minimumRequestControlHeight < 44 ? ["compact decision controls must be at least 44px"] : []),
  ]
  if (family === "r06") {
    if (width === 1440) return [...common,
      ...(!value.appClasses.includes("app--empty") ? ["empty conversation must use conversation-empty composition"] : []),
      ...(!value.bodyText.includes("No sessions") ? ["empty backend must report No sessions"] : []),
      ...(value.composerVisible ? ["empty backend must not expose a composer"] : []),
    ]
    if (width === 768) return [...common,
      ...(!value.statusText.includes("Studio Mac is not reachable") || !value.statusText.includes("Reconnect") ? ["offline device must expose truthful reconnect state"] : []),
      ...(value.composerVisible ? ["offline no-session state must not expose a composer"] : []),
    ]
    return [...common,
      ...(value.appClasses.includes("app--empty") ? ["signed-out Settings must not use conversation-empty composition"] : []),
      ...(!value.accountText.includes("not signed in") || !value.accountText.includes("Sign in with Google") ? ["signed-out account must expose truthful sign-in state"] : []),
    ]
  }
  if (family === "r07") return [...common,
    ...(value.appClasses.includes("app--empty") ? ["Settings route must not use conversation-empty composition"] : []),
    ...(!value.accountText.includes("account_fixture") ? ["service account identity must be rendered"] : []),
    ...(value.deviceRows.length !== 3 ? ["device table must expose active, offline, and revoked records"] : []),
    ...(value.deviceRows.some((row) => row.text.includes("Legacy-MacBook") && row.actions !== 0) ? ["revoked device must not expose an action"] : []),
    ...(!value.enrollmentText.includes("Enrollment ID") || !value.enrollmentText.includes("Enrollment code (shown once)") ? ["enrollment ID and one-use code must be separate"] : []),
    ...(value.enrollmentCommand.includes("AAAA-BBBB") ? ["enrollment command must not contain the one-use code"] : []),
    ...(width < 1024 && value.minimumSettingsControlHeight < 44 ? ["compact device controls must be at least 44px"] : []),
  ]
  return [...common,
    ...(value.appClasses.includes("app--empty") ? ["Settings route must not use conversation-empty composition"] : []),
    ...(value.themeRadios !== 3 || value.checkedThemeRadios !== 1 ? ["theme control must expose three options and one checked state"] : []),
    ...(value.autonomyRadios !== 4 || value.checkedAutonomyRadios !== 1 ? ["autonomy control must expose four levels and one checked state"] : []),
    ...(value.notificationRows !== 5 || value.notificationChecks !== 10 ? ["notifications must expose five categories and two channels"] : []),
    ...(!value.settingsText.includes("Hard guardrail reviews always require a human decision") ? ["hard-review invariant must be visible"] : []),
    ...(value.settingsText.includes("Recommended") || value.settingsText.includes("Re-check permission status") ? ["unsupported Settings control or recommendation is present"] : []),
    ...(width < 1024 && value.minimumSettingsControlHeight < 44 ? ["compact Settings controls must be at least 44px"] : []),
  ]
}

function familyAssertions(family, width) {
  const shared = ["source-matched fixture text settled", "nonblank source and implementation regions", "no horizontal overflow", "no unsupported New Session or fake account placeholder"]
  const details = {
    r01: [width >= 768 ? "two-column Sessions/conversation workspace" : "single-column mobile conversation", "Activity remains accessible without a persistent aside"],
    r02: ["four source-matched Sessions", `${width === 768 ? 2 : 1}-track responsive Session list`, ...(width >= 1024 ? ["four desktop data columns"] : []), "no conversation-empty centering"],
    r03: ["source-matched conversation and tool output", "visible composer", "Steer/Queue pressed semantics"],
    r04: ["reported events and two pending decisions", `${width >= 768 ? 2 : 1}-column Activity composition`, ...(width < 768 ? ["pending decisions precede events"] : [])],
    r05: ["source-matched decision count", "hard versus ordinary review actions", ...(width < 1024 ? ["44px compact controls"] : [])],
    r06: [width === 1440 ? "signed-in empty backend" : width === 768 ? "offline selected device" : "signed-out Settings", "no unavailable composer"],
    r07: ["service account identity", "active/offline/revoked device records", "separate enrollment ID and one-use code", ...(width < 1024 ? ["44px compact controls"] : [])],
    r08: ["three theme options", "four autonomy levels", "five-category/two-channel notifications", "hard-review notice and goal controls", ...(width < 1024 ? ["44px compact controls"] : [])],
  }
  return [...shared, ...details[family]]
}

function mutation(family, width) {
  if (family === "r01" && width === 1440) return {
    name: "collapse desktop workspace to one column",
    expected: "workspace must have two columns",
    apply: `document.querySelector('.workspace').style.gridTemplateColumns='1fr'`,
    restore: `document.querySelector('.workspace').style.removeProperty('grid-template-columns')`,
  }
  if (family === "r02" && width === 1440) return {
    name: "hide the Sessions table",
    expected: "Sessions table must expose four",
    apply: `document.querySelector('.sessions-table').style.display='none'`,
    restore: `document.querySelector('.sessions-table').style.removeProperty('display')`,
  }
  if (family === "r03" && width === 1440) return {
    name: "hide the conversation composer",
    expected: "conversation composer must be visible",
    apply: `document.querySelector('.composer').style.display='none'`,
    restore: `document.querySelector('.composer').style.removeProperty('display')`,
  }
  if (family === "r04" && width === 1440) return {
    name: "collapse Activity to one column",
    expected: "Activity responsive columns are wrong",
    apply: `document.querySelector('.activity-page').style.gridTemplateColumns='1fr'`,
    restore: `document.querySelector('.activity-page').style.removeProperty('grid-template-columns')`,
  }
  if (family === "r05" && width === 1440) return {
    name: "replace hard-review Reject with reusable approval",
    expected: "hard review actions must be",
    apply: `(() => { const button=document.querySelector('.request--hard .request__actions button:last-child'); button.dataset.probeText=button.textContent; button.textContent='Always this process'; })()`,
    restore: `(() => { const button=document.querySelector('.request--hard .request__actions button:last-child'); button.textContent=button.dataset.probeText; delete button.dataset.probeText; })()`,
  }
  if (family === "r06" && width === 390) return {
    name: "apply conversation-empty centering to signed-out Settings",
    expected: "signed-out Settings must not use conversation-empty",
    apply: `document.querySelector('.app').classList.add('app--empty')`,
    restore: `document.querySelector('.app').classList.remove('app--empty')`,
  }
  if (family === "r07" && width === 1440) return {
    name: "add an action to the revoked device",
    expected: "revoked device must not expose an action",
    apply: `(() => { const row=[...document.querySelectorAll('.device-table .device')].find(row=>row.textContent.includes('Legacy-MacBook')); const button=document.createElement('button'); button.dataset.probe='revoked-action'; button.textContent='Connect'; row.append(button); })()`,
    restore: `document.querySelector('[data-probe="revoked-action"]')?.remove()`,
  }
  if (family === "r08" && width === 1440) return {
    name: "clear the selected theme radio",
    expected: "theme control must expose three options and one checked state",
    apply: `document.querySelector('#appearance-settings').closest('section').querySelector('[role="radio"][aria-checked="true"]').setAttribute('aria-checked','false')`,
    restore: `document.querySelector('#appearance-settings').closest('section').querySelector('[role="radio"]:nth-child(3)').setAttribute('aria-checked','true')`,
  }
  return undefined
}

function remoteBehavior() {
  return `(() => {
    const shown=element=>element instanceof HTMLElement&&element.getBoundingClientRect().width>0&&element.getBoundingClientRect().height>0&&getComputedStyle(element).display!=='none'&&getComputedStyle(element).visibility!=='hidden';
    const columns=element=>element instanceof HTMLElement&&shown(element)&&getComputedStyle(element).gridTemplateColumns!=='none'?getComputedStyle(element).gridTemplateColumns.split(' ').filter(Boolean).length:0;
    const text=element=>element?.innerText??element?.textContent??'';
    const actions=selector=>[...document.querySelectorAll(selector)].map(card=>[...card.querySelectorAll('.request__actions button')].filter(shown).map(button=>button.textContent.trim()));
    const settingsSections=['#account-settings','#device-settings','#appearance-settings','#autonomy-settings','#notification-settings'].map(selector=>document.querySelector(selector)?.closest('section')).filter(Boolean);
    const settingsControls=settingsSections.flatMap(section=>[...section.querySelectorAll('button,.switch')]).filter(shown);
    const appearance=document.querySelector('#appearance-settings')?.closest('section');
    const autonomy=document.querySelector('#autonomy-settings')?.closest('section');
    const notifications=document.querySelector('#notification-settings')?.closest('section');
    const enrollmentCommand=document.querySelector('#device-settings')?.closest('section')?.querySelector('.code-block code')?.textContent??'';
    return {
      appClasses:document.querySelector('.app')?.className??'',
      bodyText:document.body.innerText,
      overflow:document.documentElement.scrollWidth>document.documentElement.clientWidth,
      mainVisible:shown(document.querySelector('.workspace__main')),
      workspaceColumns:columns(document.querySelector('.workspace')),
      railVisible:shown(document.querySelector('.workspace__rail')),
      persistentActivity:document.querySelectorAll('.workspace__activity').length,
      activityAccessible:shown(document.querySelector('button[aria-label="Open activity"]'))||[...document.querySelectorAll('a[href="/remote/activity"]')].some(shown),
      bottomNavigationVisible:shown(document.querySelector('.bottom-nav')),
      sessionRows:[...document.querySelectorAll('.sessions-table__row')].filter(shown).length,
      sessionsTableColumns:columns(document.querySelector('.sessions-table')),
      sessionHeadColumns:columns(document.querySelector('.sessions-table__head')),
      sessionsHeadingVisible:shown(document.querySelector('.sessions-page .page-head')),
      transcriptMessages:[...document.querySelectorAll('.transcript .message')].filter(shown).length,
      composerVisible:shown(document.querySelector('.composer')),
      deliveryOptions:[...document.querySelectorAll('.composer__delivery-option')].filter(shown).map(button=>({text:button.textContent.trim(),pressed:button.getAttribute('aria-pressed')==='true'})),
      toolRows:[...document.querySelectorAll('.tool')].filter(shown).length,
      activityRows:[...document.querySelectorAll('.activity-page .activity-row')].filter(shown).length,
      requestCards:[...document.querySelectorAll('.request')].filter(shown).length,
      activityColumns:columns(document.querySelector('.activity-page')),
      decisionsY:document.querySelector('.activity-page__decisions')?.getBoundingClientRect().y??0,
      eventsY:document.querySelector('.activity-page__events')?.getBoundingClientRect().y??0,
      hardActions:actions('.request--hard'),
      ordinaryActions:actions('.request--guardrail:not(.request--hard)'),
      permissionActions:actions('.request--permission'),
      minimumRequestControlHeight:Math.min(Infinity,...[...document.querySelectorAll('.request button')].filter(shown).map(button=>button.getBoundingClientRect().height)),
      statusText:text(document.querySelector('.status-strip')),
      accountText:text(document.querySelector('#account-settings')?.closest('section')),
      settingsText:settingsSections.map(text).join(' '),
      deviceRows:[...document.querySelectorAll('.device-table .device')].filter(shown).map(row=>({text:text(row),actions:row.querySelectorAll('button').length})),
      enrollmentText:text(document.querySelector('#device-settings')?.closest('section')),
      enrollmentCommand,
      minimumSettingsControlHeight:Math.min(Infinity,...settingsControls.map(control=>control.getBoundingClientRect().height)),
      themeRadios:appearance?.querySelectorAll('[role="radio"]').length??0,
      checkedThemeRadios:appearance?.querySelectorAll('[role="radio"][aria-checked="true"]').length??0,
      autonomyRadios:autonomy?.querySelectorAll('[role="radio"]').length??0,
      checkedAutonomyRadios:autonomy?.querySelectorAll('[role="radio"][aria-checked="true"]').length??0,
      notificationRows:notifications?.querySelectorAll('tbody tr').length??0,
      notificationChecks:notifications?.querySelectorAll('tbody input[type="checkbox"]').length??0,
    };
  })()`
}

function actualRoots(family, width) {
  if (family === "r03") return `[document.querySelector('.workspace__main')]`
  if (family === "r04") return `[document.querySelector('.activity-page')]`
  if (family === "r05") return `[document.querySelector('.requests')]`
  if (family === "r06" && width === 390) return `[document.querySelector('#account-settings')?.closest('section')]`
  if (family === "r07") return `[document.querySelector('.page-head'),document.querySelector('#account-settings')?.closest('section'),document.querySelector('#device-settings')?.closest('section')]`
  if (family === "r08") return `[document.querySelector('#appearance-settings')?.closest('section'),document.querySelector('#autonomy-settings')?.closest('section'),document.querySelector('#notification-settings')?.closest('section')]`
  return `[document.querySelector('.app')]`
}

function actualTarget(family, width) {
  if (family === "r03") return ".workspace__main"
  if (family === "r04") return ".activity-page"
  if (family === "r05") return ".requests"
  if (family === "r06" && width === 390) return "#account-settings section"
  if (family === "r07") return ".page-head + Account + Devices"
  if (family === "r08") return "Appearance + Autonomy + Notifications"
  return ".app"
}

function actualViewportHeight(family, entry) {
  if (family === "r05" || family === "r07" || family === "r08") return 1800
  return Math.max(620, Math.ceil(entry.rect.height))
}

function regionMeasurement(rootsExpression) {
  return `(async () => {
    await document.fonts.ready;
    await new Promise(requestAnimationFrame);
    const roots=(${rootsExpression}).filter(root=>root instanceof HTMLElement);
    if(roots.length===0)throw new Error('Comparison roots missing');
    const rects=roots.map(root=>root.getBoundingClientRect());
    const left=Math.min(...rects.map(rect=>rect.left)); const top=Math.min(...rects.map(rect=>rect.top)); const right=Math.max(...rects.map(rect=>rect.right)); const bottom=Math.max(...rects.map(rect=>rect.bottom));
    if(!(right>left&&bottom>top))throw new Error('Comparison region is blank');
    return {
      viewport:{width:innerWidth,height:innerHeight,devicePixelRatio},
      absoluteRect:{x:left+scrollX,y:top+scrollY,width:right-left,height:bottom-top},
      region:{x:left,y:top,width:right-left,height:bottom-top},
      roots:roots.map(root=>({tag:root.tagName,id:root.id||null,className:typeof root.className==='string'?root.className:null,text:root.textContent.trim().replace(/\\s+/g,' ').slice(0,160)})),
    };
  })()`
}

async function buildFixture() {
  const process = Bun.spawn(["bunx", "vite", "build", "--outDir", "output/stitch-remote-fidelity", "--emptyOutDir"], {
    cwd: web,
    env: { ...processEnv(), YCODING_WEB_VERIFY: "1" },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [exitCode, stdout, stderr] = await Promise.all([process.exited, new Response(process.stdout).text(), new Response(process.stderr).text()])
  if (exitCode !== 0) throw new Error(`Remote fixture build failed (${exitCode}):\n${stdout}\n${stderr}`)
}

function processEnv() {
  return Object.fromEntries(Object.entries(process.env).filter((entry) => entry[1] !== undefined))
}

async function waitForScenario(page, expected, id) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const state = await page.evaluate(`({text:document.body.innerText,fonts:document.fonts.status})`)
    if (state.fonts === "loaded" && expected.every((text) => state.text.includes(text))) return
    await Bun.sleep(100)
  }
  throw new Error(`${id} did not settle: ${expected.join(" | ")}`)
}

async function imageEvidence(path) {
  const process = Bun.spawnSync(["python3", "-c", "from PIL import Image; import json,sys; im=Image.open(sys.argv[1]).convert('RGB'); e=im.getextrema(); spread=max(hi-lo for lo,hi in e); print(json.dumps({'width':im.width,'height':im.height,'spread':spread,'nonblank':im.width>0 and im.height>0 and spread>8}))", path])
  if (process.exitCode !== 0) throw new Error(`PNG validation failed for ${repositoryPath(path)}: ${process.stderr.toString()}`)
  return JSON.parse(process.stdout.toString())
}

async function sha256(path) {
  return new Bun.CryptoHasher("sha256").update(await Bun.file(path).arrayBuffer()).digest("hex")
}

async function filesManifest(paths) {
  return Promise.all([...paths].sort((left, right) => left.localeCompare(right)).map(async (path) => ({ path: repositoryPath(path), sha256: await sha256(path) })))
}

async function directoryManifest(directory, include = () => true) {
  return filesManifest((await walk(directory)).filter(include))
}

async function walk(directory) {
  const entries = await readdir(directory)
  return (await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry)
    return (await stat(path)).isDirectory() ? walk(path) : [path]
  }))).flat()
}

async function requireUnchangedSource(before, when) {
  if (JSON.stringify(before) !== JSON.stringify(await filesManifest(sourcePaths.map((path) => join(root, path))))) throw new Error(`Source changed ${when}.`)
}

function repositoryPath(path) {
  return relative(root, path).replaceAll("\\", "/")
}

function serve(directory) {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const pathname = decodeURIComponent(new URL(request.url).pathname)
    const target = resolve(directory, `.${pathname}`)
    if (!target.startsWith(`${directory}/`) && target !== directory) return new Response("Not found", { status: 404 })
    const file = Bun.file(target)
    return new Response(await file.exists() ? file : Bun.file(join(directory, "index.html")))
  } })
  return { origin: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) }
}

async function connectChrome(executable) {
  const profile = await mkdtemp(join(tmpdir(), "stitch-remote-fidelity-"))
  const child = spawn(executable, ["--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "--disable-gpu", "--hide-scrollbars", "about:blank"], { stdio: ["ignore", "pipe", "pipe"] })
  const endpoint = await new Promise((resolveEndpoint, reject) => {
    let stderr = ""
    child.stderr.on("data", (chunk) => {
      stderr += chunk
      const match = stderr.match(/DevTools listening on (ws:\/\/\S+)/)
      if (match) resolveEndpoint(match[1])
    })
    child.once("exit", (code) => reject(new Error(`Chrome exited ${code}`)))
  })
  const socket = new WebSocket(endpoint)
  await new Promise((resolveOpen, reject) => { socket.onopen = resolveOpen; socket.onerror = reject })
  let next = 0
  const waiting = new Map()
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(data)
    if (!message.id) return
    const wait = waiting.get(message.id)
    if (!wait) return
    waiting.delete(message.id)
    message.error ? wait.reject(new Error(message.error.message)) : wait.resolve(message.result ?? {})
  }
  const send = (method, params = {}, sessionId) => new Promise((resolveSend, reject) => {
    const id = ++next
    waiting.set(id, { resolve: resolveSend, reject })
    socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
  })
  return {
    async page(width, height, theme) {
      const target = await send("Target.createTarget", { url: "about:blank" })
      const attached = await send("Target.attachToTarget", { targetId: target.targetId, flatten: true })
      const call = (method, params = {}) => send(method, params, attached.sessionId)
      await call("Page.enable")
      await call("Runtime.enable")
      await call("Network.enable")
      await call("Network.setBlockedURLs", { urls: ["*sw.js*"] })
      await call("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false })
      await call("Emulation.setTouchEmulationEnabled", { enabled: width <= 390, ...(width <= 390 ? { maxTouchPoints: 1 } : {}) })
      await call("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: theme }, { name: "prefers-reduced-motion", value: "reduce" }, ...(width <= 390 ? [{ name: "pointer", value: "coarse" }] : [])] })
      return {
        async navigate(url) { await call("Page.navigate", { url }); await Bun.sleep(350) },
        async evaluate(expression) {
          const result = await call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })
          if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
          return result.result.value
        },
        async capture(path, clip) {
          const image = await call("Page.captureScreenshot", { format: "png", clip: { x: clip.x, y: clip.y, width: Math.max(1, clip.width), height: Math.max(1, clip.height), scale: 1 }, captureBeyondViewport: true })
          await Bun.write(path, Buffer.from(image.data, "base64"))
        },
        close: () => call("Target.closeTarget", { targetId: target.targetId }),
      }
    },
    async close() {
      socket.close()
      child.kill("SIGKILL")
      await rm(profile, { recursive: true, force: true })
    },
  }
}

function review(report) {
  const rows = report.matrix.map((entry) => `<article><h2>${entry.id}</h2><p>${entry.assertions.join(" · ")}</p><div><figure><figcaption>Approved source region (${entry.sourceTheme} specimen)</figcaption><img src="${relative(outputDirectory, join(root, entry.source.capture))}"></figure><figure><figcaption>Current implementation (${entry.theme})</figcaption><img src="${relative(outputDirectory, join(root, entry.actual.capture))}"></figure></div></article>`).join("")
  return `<!doctype html><meta charset="utf-8"><title>R01-R08 source-bound comparison</title><style>body{margin:24px;background:#101416;color:#edf3f1;font:14px system-ui}article{border-top:1px solid #53625e;padding:18px 0}article div{display:grid;grid-template-columns:1fr 1fr;gap:12px}figure{margin:0}img{width:100%;border:1px solid #53625e}@media(max-width:800px){article div{grid-template-columns:1fr}}</style><h1>R01-R08 source-bound comparison</h1><p>${report.fidelity}</p>${rows}`
}
