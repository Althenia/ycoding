import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { renderMigration } from "./migration"

const snapshot = { ddl: [
  { entityType: "columns", table: "member", name: "id" },
  { entityType: "columns", table: "member", name: "owner" },
] }
const full = "CREATE TABLE `member` (`id` text, `owner` text, CONSTRAINT `owner_fk` FOREIGN KEY (`owner`) REFERENCES `session` (`id`) ON DELETE SET NULL ON UPDATE CASCADE);\n--> statement-breakpoint\nCREATE INDEX `owner_idx` ON `member` (`owner`);"

function statementsOf(rendered: string) {
  const matches = rendered.matchAll(/tx\.run\(`((?:\\.|[^`])*)`\)/gs)
  return [...matches].map((match) => match[1].replaceAll("\\`", "`"))
}

test("added foreign-key columns retain the snapshot's deletion and update actions", () => {
  const rendered = renderMigration("owner", "ALTER TABLE `member` ADD `owner` text REFERENCES session(id);", snapshot, full)
  expect(rendered).toContain("ON DELETE SET NULL ON UPDATE CASCADE")
  expect(rendered).not.toContain("DROP TABLE")
})

test("explicit actions are retained without duplication", () => {
  const rendered = renderMigration("owner", "ALTER TABLE `member` ADD `owner` text REFERENCES session(id) ON DELETE SET NULL ON UPDATE CASCADE;\n--> statement-breakpoint\nCREATE INDEX `owner_idx` ON `member` (`owner`);", snapshot, full)
  expect(rendered.match(/ON DELETE/g)).toHaveLength(1)
  expect(rendered.match(/ON UPDATE/g)).toHaveLength(1)
  expect(rendered.match(/CREATE INDEX/g)).toHaveLength(1)
})

test("a partial explicit foreign-key action receives only its missing canonical action", () => {
  const partial = "ALTER TABLE `member` ADD `owner` text REFERENCES session(id) ON DELETE SET NULL;"
  const rendered = renderMigration("owner", partial, snapshot, full)
  expect(rendered.match(/ON DELETE/g)).toHaveLength(1)
  expect(rendered.match(/ON UPDATE/g)).toHaveLength(1)
  expect(rendered).toContain("ON DELETE SET NULL ON UPDATE CASCADE")
})

test("ordinary column additions do not acquire foreign-key actions", () => {
  const rendered = renderMigration("label", "ALTER TABLE `member` ADD `label` text;", snapshot, full)
  expect(rendered).toContain("ADD \\`label\\` text;")
  expect(rendered).not.toContain("ON DELETE")
})

test("missing canonical foreign-key metadata fails generation", () => {
  const sql = "ALTER TABLE `member` ADD `owner` text REFERENCES session(id);"
  const message = "Missing canonical foreign-key metadata for member.owner"
  expect(() => renderMigration("owner", sql, snapshot, "")).toThrow(message)
  const other = sql.replace("session(id)", "other(id)")
  expect(() => renderMigration("owner", other, snapshot, full)).toThrow(message)
})

test("rendered additive foreign key preserves populated dependents and canonical actions", () => {
  const db = new Database(":memory:")
  try {
    const setup = [
      "PRAGMA foreign_keys = ON",
      "CREATE TABLE session (id TEXT PRIMARY KEY)",
      "CREATE TABLE member (id TEXT PRIMARY KEY)",
      "CREATE TABLE message (id TEXT PRIMARY KEY, member_id TEXT REFERENCES member(id) ON DELETE CASCADE)",
      "INSERT INTO session VALUES ('s1')",
      "INSERT INTO member VALUES ('m1')",
      "INSERT INTO message VALUES ('msg1', 'm1')",
    ]
    db.exec(setup.join(";\n"))
    const incremental = [
      "ALTER TABLE `member` ADD `owner` text REFERENCES session(id);",
      "ALTER TABLE `member` ADD `label` text DEFAULT 'new';",
      "CREATE INDEX `owner_idx` ON `member` (`owner`);",
    ].join("\n--> statement-breakpoint\n")
    const statements = statementsOf(renderMigration("owner", incremental, snapshot, full))
    expect(statements.length).toBeGreaterThan(0)
    for (const statement of statements) db.exec(statement)
    const members = db.query("SELECT id, owner, label FROM member").all()
    expect(members).toEqual([{ id: "m1", owner: null, label: "new" }])
    expect(db.query("SELECT * FROM message").all()).toEqual([{ id: "msg1", member_id: "m1" }])
    expect(db.query("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 })
    expect(() => db.exec("UPDATE member SET owner = 'missing' WHERE id = 'm1'")).toThrow()
    db.exec("UPDATE member SET owner = 's1'; UPDATE session SET id = 's2' WHERE id = 's1';")
    expect(db.query("SELECT owner FROM member").get()).toEqual({ owner: "s2" })
    db.exec("DELETE FROM session WHERE id = 's2'")
    expect(db.query("SELECT owner FROM member").get()).toEqual({ owner: null })
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([])
    const lookup = "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'owner_idx'"
    expect(db.query(lookup).all()).toHaveLength(1)
  } finally {
    db.close()
  }
})

type Entry = Record<string, unknown>

function column(name: string, type: string, extra: Entry = {}): Entry {
  return {
    type,
    notNull: false,
    autoincrement: false,
    default: null,
    generated: null,
    name,
    entityType: "columns",
    table: "member",
    ...extra,
  }
}

function memberIndex(name: string, value: string): Entry {
  return {
    columns: [{ value, isExpression: false }],
    isUnique: false,
    where: null,
    origin: "manual",
    name,
    entityType: "indexes",
    table: "member",
  }
}

function memberCheck(name: string, value: string): Entry {
  return { value, name, entityType: "checks", table: "member" }
}

const kindColumn = column("kind", "text", { notNull: true, default: "'a'" })
const kindCheck = memberCheck("member_kind_check", "\"kind\" IN ('a', 'b')")
const earlier: Entry[] = [
  column("id", "text"),
  column("org_id", "text"),
  column("label", "text", { notNull: true, default: "'x'" }),
  { columns: ["id"], nameExplicit: false, name: "member_pk", entityType: "pks", table: "member" },
  {
    columns: ["org_id"],
    tableTo: "org",
    columnsTo: ["id"],
    onUpdate: "NO ACTION",
    onDelete: "CASCADE",
    nameExplicit: false,
    name: "fk_member_org_id_org_id_fk",
    entityType: "fks",
    table: "member",
  },
  memberIndex("member_label_idx", "label"),
  memberCheck("member_label_check", 'length("label") > 0'),
]

function create(table: string) {
  return [
    `CREATE TABLE \`${table}\` (`,
    "\t`id` text PRIMARY KEY,",
    "\t`kind` text DEFAULT 'a' NOT NULL,",
    "\t`org_id` text,",
    "\t`label` text DEFAULT 'x' NOT NULL,",
    "\tCONSTRAINT `fk_member_org_id_org_id_fk` FOREIGN KEY (`org_id`) REFERENCES `org`(`id`) ON DELETE CASCADE,",
    '\tCONSTRAINT "member_label_check" CHECK(length("label") > 0),',
    "\tCONSTRAINT \"member_kind_check\" CHECK(\"kind\" IN ('a', 'b'))",
    ");",
  ].join("\n")
}

const labelIndex = "CREATE INDEX `member_label_idx` ON `member` (`label`);"
const kindIndex = "CREATE INDEX `member_kind_idx` ON `member` (`kind`);"
const otherIndex = "CREATE INDEX `member_label_idx` ON `member` (`org_id`);"
const addKind = "ALTER TABLE `member` ADD `kind` text DEFAULT 'a' NOT NULL;"
const addInteger = "ALTER TABLE `member` ADD `kind` integer DEFAULT 'a' NOT NULL;"
const addDefault = "ALTER TABLE `member` ADD `kind` text DEFAULT 'b' NOT NULL;"
const addNullable = "ALTER TABLE `member` ADD `kind` text DEFAULT 'a';"
const alterOrg = "ALTER TABLE `org` ADD `note` text;"
const updateKind = "UPDATE `member` SET `kind` = 'a';"
const updateLabel = "UPDATE `member` SET `label` = 'x';"
const copy = "INSERT INTO `__new_member`(`id`, `org_id`, `label`) SELECT `id`, `org_id`, `label` FROM `member`;"
const dropMember = "DROP TABLE `member`;"
const renameMember = "ALTER TABLE `__new_member` RENAME TO `member`;"
const pragmaOff = "PRAGMA foreign_keys=OFF;"
const pragmaOn = "PRAGMA foreign_keys=ON;"
const newCreate = `${create("__new_member")}\n`
const changedCreate = newCreate.replace("DEFAULT 'x'", "DEFAULT 'y'")
const rebuild = [addKind, pragmaOff, newCreate, copy, dropMember, renameMember, pragmaOn, labelIndex]

type Edit = {
  both?: (entries: Entry[]) => Entry[]
  previous?: (entries: Entry[]) => Entry[]
  next?: (entries: Entry[]) => Entry[]
  swap?: readonly [string, string]
  incremental?: (statements: string[]) => string[]
  full?: (statements: string[]) => string[]
}

const keepEntries = (entries: Entry[]) => entries
const keepStatements = (statements: string[]) => statements

function omit(...removed: string[]) {
  return (statements: string[]) => statements.filter((statement) => !removed.includes(statement))
}

function substitute(from: string, to: string) {
  return (statements: string[]) => statements.map((statement) => (statement === from ? to : statement))
}

function change(entityType: string, name: string, update: Entry) {
  const matches = (entry: Entry) => entry.entityType === entityType && entry.name === name
  return (entries: Entry[]) => entries.map((entry) => (matches(entry) ? { ...entry, ...update } : entry))
}

function remove(entityType: string, name: string) {
  const matches = (entry: Entry) => entry.entityType === entityType && entry.name === name
  return (entries: Entry[]) => entries.filter((entry) => !matches(entry))
}

function scenario(edit: Edit = {}) {
  const swap = (text: string) => (edit.swap ? text.replaceAll(edit.swap[0], edit.swap[1]) : text)
  const steps = (edit.incremental ?? keepStatements)(rebuild)
  const canonicalSteps = (edit.full ?? keepStatements)([create("member"), labelIndex])
  const incremental = steps.map(swap).join("--> statement-breakpoint\n")
  const canonical = canonicalSteps.map(swap).join("\n--> statement-breakpoint\n")
  const base = (edit.both ?? keepEntries)(earlier)
  const previous = (edit.previous ?? keepEntries)(base)
  const next = (edit.next ?? keepEntries)([...base, kindColumn, kindCheck])
  return ["member-kind", incremental, { ddl: next }, canonical, { ddl: previous }] as const
}

test("CHECK-only rebuild renders as one additive column with its named inline CHECK", () => {
  const rendered = renderMigration(...scenario())
  expect(statementsOf(rendered)).toEqual([
    "ALTER TABLE `member` ADD `kind` text DEFAULT 'a' NOT NULL CONSTRAINT `member_kind_check` CHECK (\"kind\" IN ('a', 'b'));",
  ])
  expect(rendered).not.toMatch(/PRAGMA|__new_|INSERT|DROP TABLE|RENAME|CREATE INDEX/)
})

test("rendered CHECK-only column addition keeps populated rows and cascading dependents with foreign keys enforced", () => {
  const db = new Database(":memory:")
  try {
    const setup = [
      "PRAGMA foreign_keys = ON",
      "CREATE TABLE org (id TEXT PRIMARY KEY)",
      "CREATE TABLE member (id text PRIMARY KEY, org_id text, label text DEFAULT 'x' NOT NULL, CONSTRAINT fk_member_org_id_org_id_fk FOREIGN KEY (org_id) REFERENCES org(id) ON DELETE CASCADE, CONSTRAINT member_label_check CHECK(length(label) > 0))",
      "CREATE INDEX member_label_idx ON member (label)",
      "CREATE TABLE child (id TEXT PRIMARY KEY, member_id TEXT NOT NULL REFERENCES member(id) ON DELETE CASCADE)",
      "INSERT INTO org VALUES ('o1')",
      "INSERT INTO member VALUES ('m1', 'o1', 'l')",
      "INSERT INTO child VALUES ('c1', 'm1')",
    ]
    db.exec(setup.join(";\n"))
    const statements = statementsOf(renderMigration(...scenario()))
    expect(statements).toHaveLength(1)
    db.exec("BEGIN")
    for (const statement of statements) db.exec(statement)
    db.exec("COMMIT")
    const members = db.query("SELECT id, org_id, label, kind FROM member").all()
    expect(members).toEqual([{ id: "m1", org_id: "o1", label: "l", kind: "a" }])
    const children = db.query("SELECT id, member_id FROM child").all()
    expect(children).toEqual([{ id: "c1", member_id: "m1" }])
    expect(db.query("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 })
    expect(() => db.exec("INSERT INTO member (id, org_id, kind) VALUES ('m2', 'o1', 'z')")).toThrow()
    db.exec("INSERT INTO member (id, org_id, kind) VALUES ('m3', 'o1', 'b')")
    expect(() => db.exec("INSERT INTO child VALUES ('c2', 'missing')")).toThrow()
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([])
    const lookup = "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'member_label_idx'"
    expect(db.query(lookup).all()).toHaveLength(1)
    db.exec("DELETE FROM member WHERE id = 'm1'")
    expect(db.query("SELECT id FROM child").all()).toEqual([])
  } finally {
    db.close()
  }
})

const rejected: Record<string, Edit> = {
  "an old column type changed": {
    next: change("columns", "label", { type: "integer" }),
    swap: ["`label` text DEFAULT", "`label` integer DEFAULT"],
  },
  "an old column default changed": {
    next: change("columns", "label", { default: "'y'" }),
    swap: ["`label` text DEFAULT 'x'", "`label` text DEFAULT 'y'"],
  },
  "an old column notNull changed": {
    next: change("columns", "label", { notNull: false }),
    swap: ["DEFAULT 'x' NOT NULL", "DEFAULT 'x'"],
  },
  "an old column was removed": {
    next: remove("columns", "label"),
  },
  "an old index changed": {
    next: change("indexes", "member_label_idx", { columns: [{ value: "org_id", isExpression: false }] }),
    swap: ["ON `member` (`label`)", "ON `member` (`org_id`)"],
  },
  "an old index was removed": {
    next: remove("indexes", "member_label_idx"),
    incremental: omit(labelIndex),
    full: omit(labelIndex),
  },
  "an old foreign key changed": {
    next: change("fks", "fk_member_org_id_org_id_fk", { onDelete: "SET NULL" }),
    swap: ["`org`(`id`) ON DELETE CASCADE", "`org`(`id`) ON DELETE SET NULL"],
  },
  "an old check changed": {
    next: change("checks", "member_label_check", { value: 'length("label") > 1' }),
    swap: ['CHECK(length("label") > 0)', 'CHECK(length("label") > 1)'],
  },
  "a second check was added": {
    next: (entries) => [...entries, memberCheck("member_kind_extra_check", "\"kind\" <> ''")],
    swap: [
      "CHECK(\"kind\" IN ('a', 'b'))",
      "CHECK(\"kind\" IN ('a', 'b')),\n\tCONSTRAINT \"member_kind_extra_check\" CHECK(\"kind\" <> '')",
    ],
  },
  "a new index was added": {
    next: (entries) => [...entries, memberIndex("member_kind_idx", "kind")],
    incremental: (statements) => [...statements, kindIndex],
    full: (statements) => [...statements, kindIndex],
  },
  "the CHECK references an old column": {
    next: change("checks", "member_kind_check", { value: "\"kind\" IN ('a', 'b') AND \"label\" <> ''" }),
    swap: ["CHECK(\"kind\" IN ('a', 'b'))", "CHECK(\"kind\" IN ('a', 'b') AND \"label\" <> '')"],
  },
  "the INSERT column list differs from the previous columns": {
    swap: ["(`id`, `org_id`, `label`) SELECT `id`, `org_id`, `label`", "(`id`, `label`) SELECT `id`, `label`"],
  },
  "the new table differs from the canonical table": {
    incremental: substitute(newCreate, changedCreate),
  },
  "a recreated index differs from the canonical index": {
    incremental: substitute(labelIndex, otherIndex),
  },
  "the column is not added by this migration": {
    incremental: omit(addKind),
  },
  "the old table is not dropped": {
    incremental: omit(dropMember),
  },
  "the new table is not renamed": {
    incremental: omit(renameMember),
  },
  "the foreign key pragmas are missing": {
    incremental: omit(pragmaOff, pragmaOn),
  },
  "the ADD type differs from the canonical column definition": {
    incremental: substitute(addKind, addInteger),
  },
  "the ADD default differs from the canonical column definition": {
    incremental: substitute(addKind, addDefault),
  },
  "the ADD lacks NOT NULL from the canonical column definition": {
    incremental: substitute(addKind, addNullable),
  },
  "the CHECK has a bare old column in an OR branch": {
    next: change("checks", "member_kind_check", { value: "\"kind\" IN ('a', 'b') OR label = ''" }),
    swap: ["CHECK(\"kind\" IN ('a', 'b'))", "CHECK(\"kind\" IN ('a', 'b') OR label = '')"],
  },
  "the CHECK is a function comparison": {
    next: change("checks", "member_kind_check", { value: 'length("kind") > 0' }),
    swap: ["CHECK(\"kind\" IN ('a', 'b'))", 'CHECK(length("kind") > 0)'],
  },
  "the CHECK ORs the new column with IS NULL": {
    next: change("checks", "member_kind_check", { value: "\"kind\" IN ('a', 'b') OR \"kind\" IS NULL" }),
    swap: ["CHECK(\"kind\" IN ('a', 'b'))", "CHECK(\"kind\" IN ('a', 'b') OR \"kind\" IS NULL)"],
  },
  "the canonical CREATE does not carry the CHECK": {
    swap: [",\n\tCONSTRAINT \"member_kind_check\" CHECK(\"kind\" IN ('a', 'b'))", ""],
  },
  "an UPDATE follows the rebuild": {
    incremental: (statements) => [...statements, updateKind],
  },
  "an ALTER TABLE on another table follows the rebuild": {
    incremental: (statements) => [...statements, alterOrg],
  },
  "an extra PRAGMA follows the rebuild": {
    incremental: (statements) => [...statements, pragmaOn],
  },
  "a canonical recreated index is missing": {
    incremental: omit(labelIndex),
  },
  "a recreated index is duplicated": {
    incremental: (statements) => [...statements, labelIndex],
  },
  "an extra statement precedes the ADD": {
    incremental: (statements) => [updateLabel, ...statements],
  },
  "a previous entry is duplicated": {
    previous: (entries) => [...entries, ...entries.slice(0, 1)],
  },
  "a next entry is duplicated": {
    next: (entries) => [...entries, ...entries.slice(0, 1)],
  },
  "an entry has no name": {
    both: (entries) => [...entries, { entityType: "uniques", table: "member", columns: ["org_id"] }],
  },
  "an entry has no entityType": {
    both: (entries) => [...entries, { name: "member_ghost", table: "member" }],
  },
}

for (const [rule, edit] of Object.entries(rejected)) {
  test(`CHECK-only rebuild requires review when ${rule}`, () => {
    expect(() => renderMigration(...scenario(edit))).toThrow("Table rebuild for member requires review")
  })
}

test("a rebuild that adds no check passes through unchanged", () => {
  const defaulted = (text: string) => text.replace("`label` text DEFAULT 'x'", "`label` text DEFAULT 'z'")
  const columnsAll = "`id`, `kind`, `org_id`, `label`"
  const steps = [
    pragmaOff,
    `${defaulted(create("__new_member"))}\n`,
    `INSERT INTO \`__new_member\`(${columnsAll}) SELECT ${columnsAll} FROM \`member\`;`,
    dropMember,
    renameMember,
    pragmaOn,
    labelIndex,
  ]
  const previous = [...earlier, kindColumn, kindCheck]
  const next = change("columns", "label", { default: "'z'" })(previous)
  const canonical = [defaulted(create("member")), labelIndex].join("\n--> statement-breakpoint\n")
  const sql = steps.join("--> statement-breakpoint\n")
  const rendered = renderMigration("member-default", sql, { ddl: next }, canonical, { ddl: previous })
  const squash = (text: string) => text.replace(/\s+/g, " ").trim()
  expect(statementsOf(rendered).map(squash)).toEqual(steps.map(squash))
})
