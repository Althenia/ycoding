import { $ } from "bun"
import semver from "semver"
import path from "path"
import { previewBuildNumber } from "./preview-build.js"

const rootPkgPath = path.resolve(import.meta.dir, "../../../package.json")
const cliPkgPath = path.resolve(import.meta.dir, "../../cli/package.json")
const rootPkg = await Bun.file(rootPkgPath).json()
const expectedBunVersion = rootPkg.packageManager?.split("@")[1]

if (!expectedBunVersion) {
  throw new Error("packageManager field not found in root package.json")
}

// relax version requirement
const expectedBunVersionRange = `^${expectedBunVersion}`

if (!semver.satisfies(process.versions.bun, expectedBunVersionRange)) {
  throw new Error(`This script requires bun@${expectedBunVersionRange}, but you are using bun@${process.versions.bun}`)
}

const env = {
  YCODING_CHANNEL: process.env["YCODING_CHANNEL"],
  YCODING_BUMP: process.env["YCODING_BUMP"],
  YCODING_VERSION: process.env["YCODING_VERSION"],
  YCODING_RELEASE: process.env["YCODING_RELEASE"],
}
const CHANNEL = await (async () => {
  if (env.YCODING_CHANNEL) return env.YCODING_CHANNEL
  if (env.YCODING_BUMP) return "latest"
  if (env.YCODING_VERSION && !env.YCODING_VERSION.startsWith("0.0.0-")) return "latest"
  return await $`git branch --show-current`.text().then((x) => x.trim())
})()
const IS_PREVIEW = CHANNEL !== "latest"

const VERSION = await (async () => {
  if (env.YCODING_VERSION) return env.YCODING_VERSION
  if (IS_PREVIEW)
    return `0.0.0-${CHANNEL}-${previewBuildNumber({
      runNumber: process.env["GITHUB_RUN_NUMBER"],
      runAttempt: process.env["GITHUB_RUN_ATTEMPT"],
    })}`
  const version = (await Bun.file(cliPkgPath).json()).version as string
  const [major, minor, patch] = version.split(".").map((x: string) => Number(x) || 0)
  const t = env.YCODING_BUMP?.toLowerCase()
  if (t === "major") return `${major + 1}.0.0`
  if (t === "minor") return `${major}.${minor + 1}.0`
  return `${major}.${minor}.${patch + 1}`
})()

const bot = ["actions-user", "github-actions[bot]"]
const teamPath = path.resolve(import.meta.dir, "../../../.github/TEAM_MEMBERS")
const team = [
  ...(await Bun.file(teamPath)
    .text()
    .then((x) => x.split(/\r?\n/).map((x) => x.trim()))
    .then((x) => x.filter((x) => x && !x.startsWith("#")))),
  ...bot,
]

export const Script = {
  get channel() {
    return CHANNEL
  },
  get version() {
    return VERSION
  },
  get preview() {
    return IS_PREVIEW
  },
  get release(): boolean {
    return !!env.YCODING_RELEASE
  },
  get team() {
    return team
  },
}
console.log(`ycoding script`, JSON.stringify(Script, null, 2))
