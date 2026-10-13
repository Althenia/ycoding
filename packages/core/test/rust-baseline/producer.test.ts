import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { createBaselineRoot, produceBaseline } from "../../../../script/rust-parity/producer"
import { exportDatabase, fingerprint, sourceFingerprint, verifyCopy } from "../../../../script/rust-parity/export"

const allocated: string[] = []
const fixture = { root: "", sourceRevision: "", sourceFingerprint: "" }
beforeAll(async () => {
  fixture.root = await createBaselineRoot()
  allocated.push(fixture.root)
  Object.assign(fixture, await produceBaseline(fixture.root))
}, 120_000)
afterAll(async () => {
  await Promise.all(allocated.map((root) => rm(root, { recursive: true, force: true })))
})

describe("WP-001 / HARNESS-01 F-STORE", () => {
  test("refuses repository and arbitrary temp roots without touching them", async () => {
    await expect(produceBaseline(path.resolve(import.meta.dir, "../../../.."))).rejects.toThrow("fresh harness-created")
    const arbitrary = await mkdtemp(path.join(tmpdir(), "not-baseline-"))
    allocated.push(arbitrary)
    await expect(produceBaseline(arbitrary)).rejects.toThrow("fresh harness-created")
  })

  test("refuses a used or nonempty harness root", async () => {
    await expect(produceBaseline(fixture.root)).rejects.toThrow("fresh harness-created")
    const nonempty = await createBaselineRoot()
    allocated.push(nonempty)
    await Bun.write(path.join(nonempty, "sentinel"), "unchanged")
    await expect(produceBaseline(nonempty)).rejects.toThrow("empty fresh")
    expect(await Bun.file(path.join(nonempty, "sentinel")).text()).toBe("unchanged")
  })

  test("refuses root replacement by a symlink before starting any runtime", async () => {
    const replaced = await createBaselineRoot()
    allocated.push(replaced)
    const target = await mkdtemp(path.join(tmpdir(), "not-baseline-symlink-"))
    allocated.push(target)
    await rm(replaced, { recursive: true })
    await symlink(target, replaced)
    await expect(produceBaseline(replaced)).rejects.toThrow("unchanged empty fresh")
  })

  test("exports every catalog table and records no silent coverage omissions", async () => {
    const exported = await Bun.file(path.join(fixture.root, "semantic-export.json")).json()
    expect(Object.keys(exported.core)).toHaveLength(49)
    expect(Object.keys(exported.meeting)).toHaveLength(9)
    expect(exported.core.session).toHaveLength(3)
    expect(exported.core.session_pending).toHaveLength(2)
    expect(exported.meeting.meetings).toHaveLength(1)
    const coverage = await Bun.file(path.join(fixture.root, "coverage.json")).json()
    expect(coverage.core).toHaveLength(49)
    expect(coverage.meeting).toHaveLength(9)
    expect(coverage.unresolved).toEqual([])
    expect(
      coverage.core.every(
        (row: { evidence: string; status: string }) =>
          row.evidence && ["populated", "unreachable-current-runtime"].includes(row.status),
      ),
    ).toBe(true)
    expect(
      coverage.core
        .filter((row: { status: string }) => row.status === "unreachable-current-runtime")
        .map((row: { table: string }) => row.table),
    ).toEqual(["project_artifact_legacy_cleanup", "workspace"])
    expect(coverage.meeting.every((row: { rows: number }) => row.rows > 0)).toBe(true)
  })

  test("TEST-001 preserves paired, lone-high, lone-low and mixed UTF-16 values AND dynamic keys", async () => {
    const exported = await Bun.file(path.join(fixture.root, "semantic-export.json")).json()
    const values = [
      "paired:\ud83d\ude80",
      "high:\ud800",
      "low:\udc00",
      "mixed:\ud800A\udc00\ud83d\ude80\ud800\ud800\udc00",
    ]
    const expectedUnits = [
      [0xd83d, 0xde80],
      [0xd800],
      [0xdc00],
      [0xd800, 65, 0xdc00, 0xd83d, 0xde80, 0xd800, 0xd800, 0xdc00],
    ]
    const documents = [
      JSON.parse(exported.core.kv[0].value),
      JSON.parse(exported.core.instruction_entry[0].value),
      JSON.parse(
        exported.core.session_pending.find((row: { id: string }) => row.id === "msg_baseline_pending_steer").data,
      ).metadata,
      JSON.parse(exported.core.session_message.find((row: { id: string }) => row.id === "msg_baseline_steer").data)
        .metadata,
    ]
    for (const document of documents) {
      expect(Object.keys(document).sort()).toEqual(values.toSorted())
      for (const [index, value] of values.entries()) {
        expect(document[value]).toBe(value)
        const suffix = document[value].slice(document[value].indexOf(":") + 1)
        expect(Array.from({ length: suffix.length }, (_, unit) => suffix.charCodeAt(unit))).toEqual(
          expectedUnits[index],
        )
      }
      expect(JSON.parse(JSON.stringify(document))).toEqual(document)
    }
    const meeting = JSON.parse(exported.meeting.meetings[0].data)
    expect(meeting.title).toBe(values[3])
    expect(JSON.parse(exported.meeting.proposals[0].data).suggestedContent).toBe(values[2])
  })

  test("preserves real provider terminal Steps, both promoted deliveries, form settlement, instructions, skill and attachment bytes", async () => {
    const exported = await Bun.file(path.join(fixture.root, "semantic-export.json")).json()
    const eventData = exported.core.event.map((row: { type: string; data: string }) => ({
      type: row.type,
      data: JSON.parse(row.data),
    }))
    const started = eventData.filter((row: { type: string }) => row.type.startsWith("session.step.started."))
    const ended = eventData.filter((row: { type: string }) => row.type.startsWith("session.step.ended."))
    expect(started).toHaveLength(2)
    expect(ended).toHaveLength(2)
    expect(eventData.some((row: { type: string }) => row.type.startsWith("session.step.failed."))).toBe(false)
    expect(ended.map((row: { data: { assistantMessageID: string } }) => row.data.assistantMessageID).sort()).toEqual(
      started.map((row: { data: { assistantMessageID: string } }) => row.data.assistantMessageID).sort(),
    )
    expect(exported.core.session_provider_request).toHaveLength(2)
    expect(
      exported.core.session_message
        .filter((row: { type: string }) => row.type === "assistant")
        .map(
          (row: { data: string }) =>
            JSON.parse(row.data).content.find((part: { type: string }) => part.type === "text").text,
        ),
    ).toEqual(["Hello!", "Hello!"])
    expect(exported.core.session_message.some((row: { id: string }) => row.id === "msg_baseline_queue")).toBe(true)
    expect(exported.core.session_pending.map((row: { delivery: string }) => row.delivery).sort()).toEqual([
      "queue",
      "steer",
    ])
    expect(eventData.some((row: { type: string }) => row.type.startsWith("session.skill.activated."))).toBe(true)
    const oracle = await Bun.file(path.join(fixture.root, "runtime-oracle.json")).json()
    expect(oracle.form.state).toEqual({ status: "answered", answer: { confirm: true } })
    const attachment = JSON.parse(
      exported.core.session_pending.find((row: { id: string }) => row.id === "msg_baseline_pending_steer").data,
    ).files[0].content
    expect(await Bun.file(path.join(fixture.root, "data/ycoding", attachment.path)).text()).toBe(
      "Synthetic attachment bytes\n",
    )
    expect(exported.core.instruction_blob.length).toBeGreaterThan(0)
  })

  test("TEST-063 copied stores reopen through current Core migrations and Meeting validation without mutating the frozen source", async () => {
    const copy = await createBaselineRoot()
    allocated.push(copy)
    const originalFiles = ["data/core.sqlite", "meeting/meetings.sqlite"]
    const hashes = await Promise.all(originalFiles.map((file) => fingerprint(path.join(fixture.root, file))))
    await Bun.write(path.join(copy, "core.sqlite"), Bun.file(path.join(fixture.root, originalFiles[0])))
    await Bun.write(path.join(copy, "meetings.sqlite"), Bun.file(path.join(fixture.root, originalFiles[1])))
    const reopened = Bun.spawn([process.execPath, "run", path.join(import.meta.dir, "reopen.ts"), copy], {
      cwd: path.resolve(import.meta.dir, "../.."),
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: path.join(copy, "home"),
        TMPDIR: path.dirname(copy),
        TZ: "UTC",
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      timeout: 30000,
    })
    const [stdout, stderr, exit] = await Promise.all([
      new Response(reopened.stdout).text(),
      new Response(reopened.stderr).text(),
      reopened.exited,
    ])
    expect({ exit, stdout, stderr }).toEqual({ exit: 0, stdout: "", stderr: "" })
    const exported = await Bun.file(path.join(fixture.root, "semantic-export.json")).json()
    expect(exportDatabase(path.join(copy, "core.sqlite"))).toEqual(exported.core)
    expect(exportDatabase(path.join(copy, "meetings.sqlite"))).toEqual(exported.meeting)
    expect(await Promise.all(originalFiles.map((file) => fingerprint(path.join(fixture.root, file))))).toEqual(hashes)
  }, 30000)

  test("freezes all files with exact hashes and immutable reopen export", async () => {
    const provenance = await Bun.file(path.join(fixture.root, "provenance.json")).json()
    expect(provenance.sourceRevision).toBe(fixture.sourceRevision)
    expect(provenance.sourceRevision).toMatch(/^[0-9a-f]{40}$/)
    expect(provenance.sourceFingerprint.sha256).toBe(fixture.sourceFingerprint)
    expect(provenance.sourceFingerprint).toEqual(await sourceFingerprint(path.resolve(import.meta.dir, "../../../..")))
    for (const file of provenance.files) expect(await fingerprint(path.join(fixture.root, file.file))).toBe(file.sha256)
    await verifyCopy(fixture.root, provenance.files)
    const exported = await Bun.file(path.join(fixture.root, "semantic-export.json")).json()
    expect(exportDatabase(path.join(fixture.root, "data/core.sqlite"))).toEqual(exported.core)
    expect(exportDatabase(path.join(fixture.root, "meeting/meetings.sqlite"))).toEqual(exported.meeting)
  })

  test("fingerprints every emitted resource, including hidden artifact scope and journal markers", async () => {
    const provenance = await Bun.file(path.join(fixture.root, "provenance.json")).json()
    const files = []
    for await (const file of new Bun.Glob("**/*").scan({ cwd: fixture.root, onlyFiles: true, dot: true }))
      if (file !== "provenance.json") files.push(file)
    expect(provenance.files.map((file: { file: string }) => file.file).sort()).toEqual(files.sort())
    expect(files.some((file) => file.endsWith("/.ycoding-scope.json"))).toBe(true)
    expect(files.some((file) => file.endsWith("/.ycoding-project-artifact.json"))).toBe(true)
  })

  test("HARNESS-01 copy integrity rejects a corrupted copied store and traversal", async () => {
    const copy = await createBaselineRoot()
    allocated.push(copy)
    const data = Bun.file(path.join(fixture.root, "data/core.sqlite"))
    const entry = {
      file: "core.sqlite",
      sha256: await fingerprint(path.join(fixture.root, "data/core.sqlite")),
      bytes: data.size,
    }
    await Bun.write(path.join(copy, entry.file), data)
    await verifyCopy(copy, [entry])
    await Bun.write(path.join(copy, entry.file), "corrupted synthetic copy")
    await expect(verifyCopy(copy, [entry])).rejects.toThrow("integrity mismatch")
    await expect(verifyCopy(copy, [{ ...entry, file: "../core.sqlite" }])).rejects.toThrow("Invalid copied-file path")
  })
})
