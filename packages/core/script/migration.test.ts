import { expect, test } from "bun:test"
import { renderMigration } from "./migration"

const snapshot = { ddl: [
  { entityType: "columns", table: "member", name: "id" },
  { entityType: "columns", table: "member", name: "owner" },
] }
const full = "CREATE TABLE `member` (`id` text, `owner` text, CONSTRAINT `owner_fk` FOREIGN KEY (`owner`) REFERENCES `session` (`id`) ON DELETE SET NULL ON UPDATE CASCADE);\n--> statement-breakpoint\nCREATE INDEX `owner_idx` ON `member` (`owner`);"

test("added foreign-key columns retain the snapshot's deletion and update actions", () => {
  const rendered = renderMigration("owner", "ALTER TABLE `member` ADD `owner` text REFERENCES session(id);", snapshot, full)
  expect(rendered).toContain("ON DELETE SET NULL ON UPDATE CASCADE")
  expect(rendered).toContain("CONSTRAINT \\`owner_fk\\`")
  expect(rendered).toContain("INSERT INTO \\`__new_member\\` (\\`id\\`) SELECT \\`id\\` FROM \\`member\\`;")
  expect(rendered).toContain("CREATE INDEX \\`owner_idx\\`")
})

test("explicit actions are retained without duplication", () => {
  const rendered = renderMigration("owner", "ALTER TABLE `member` ADD `owner` text REFERENCES session(id) ON DELETE SET NULL ON UPDATE CASCADE;\n--> statement-breakpoint\nCREATE INDEX `owner_idx` ON `member` (`owner`);", snapshot, full)
  expect(rendered.match(/ON DELETE/g)).toHaveLength(1)
  expect(rendered.match(/ON UPDATE/g)).toHaveLength(1)
  expect(rendered.match(/CREATE INDEX/g)).toHaveLength(1)
})

test("ordinary column additions do not acquire foreign-key actions", () => {
  const rendered = renderMigration("label", "ALTER TABLE `member` ADD `label` text;", snapshot, full)
  expect(rendered).toContain("ADD \\`label\\` text;")
  expect(rendered).not.toContain("ON DELETE")
})

test("missing canonical table or retained-column metadata fails generation", () => {
  const sql = "ALTER TABLE `member` ADD `owner` text REFERENCES session(id);"
  expect(() => renderMigration("owner", sql, { ddl: [] }, full)).toThrow("Missing table metadata")
  expect(() => renderMigration("owner", sql, snapshot, "")).toThrow("Missing table metadata")
})
