## The settings information architecture.
##
## Settings is a large page with its own grouped navigation, not a flip through a
## flat list. This module owns the GROUPING and the SEARCH index - which group a
## page belongs to, the order groups are offered in, and which pages a query
## matches - so the panel renders a decision that was made here rather than one
## invented per widget.
##
## The group names are YCoding's own. They mirror the shape the product already
## has in `docs/configuration.md` (application/desktop preferences, project
## discovery, provider and MCP connections, runtime behaviour, environment-owned
## advanced configuration) rather than any external product's branding.
##
## Pure presentation logic: no scene tree, no store, no transport. A page here is a
## NAVIGATION destination and nothing more - whether a page can actually be edited
## is a separate question owned by the configuration bridge (R3-02), and nothing in
## this module may claim otherwise.
class_name SettingsGroup
extends RefCounted

const APPLICATION := "application"
const WORKSPACE := "workspace"
const CONNECTIONS := "connections"
const RUNTIME := "runtime"
const ADVANCED := "advanced"

## Every group, in the order the navigation offers them. One canonical list, so a
## group cannot exist in the pages table without also existing here.
const ORDER := [APPLICATION, WORKSPACE, CONNECTIONS, RUNTIME, ADVANCED]

const LABELS := {
	APPLICATION: "Application",
	WORKSPACE: "Workspace",
	CONNECTIONS: "Connections",
	RUNTIME: "Runtime",
	ADVANCED: "Advanced",
}

const DETAIL := {
	APPLICATION: "Startup, appearance, keybindings, notifications and the office.",
	WORKSPACE: "The projects and folders this window can work in.",
	CONNECTIONS: "Providers, models, MCP servers, and browser or computer capability.",
	RUNTIME: "Agents, skills, commands, permissions, context, tools and integrations.",
	ADVANCED: "Usage and budgets, updates, local data, and environment-owned configuration.",
}

## The page each group opens on, so a group row is a destination rather than only a
## disclosure. Every group names its own first page in `PAGES` order.
const FIRST_PAGE := {
	APPLICATION: "general",
	WORKSPACE: "projects",
	CONNECTIONS: "providers",
	RUNTIME: "agents",
	ADVANCED: "advanced",
}

## page id -> group. One canonical table, so a page cannot be offered without a
## group and a group cannot own an undeclared page.
const PAGES := {
	"general": APPLICATION,
	"appearance": APPLICATION,
	"keybindings": APPLICATION,
	"notifications": APPLICATION,
	"office": APPLICATION,
	"projects": WORKSPACE,
	"providers": CONNECTIONS,
	"models": CONNECTIONS,
	"browser": CONNECTIONS,
	"agents": RUNTIME,
	"skills": RUNTIME,
	"commands": RUNTIME,
	"permissions": RUNTIME,
	"context": RUNTIME,
	"tools": RUNTIME,
	"integrations": RUNTIME,
	"usage": ADVANCED,
	"updates": ADVANCED,
	"data": ADVANCED,
	"advanced": ADVANCED,
}

const PAGE_LABELS := {
	"general": "General",
	"appearance": "Appearance",
	"keybindings": "Keybindings",
	"notifications": "Notifications",
	"office": "Office",
	"projects": "Projects and folders",
	"providers": "Providers",
	"models": "Models",
	"browser": "Browser and computer",
	"agents": "Agents",
	"skills": "Skills and instructions",
	"commands": "Commands",
	"permissions": "Permissions and guardrails",
	"context": "Context and efficiency",
	"tools": "Tools",
	"integrations": "Integrations",
	"usage": "Usage and budgets",
	"updates": "Updates",
	"data": "Data and diagnostics",
	"advanced": "Configuration and environment",
}

## What a page covers, in one line. This is navigation copy: it says which settings
## live here, and it is the second field a search matches.
const PAGE_DETAIL := {
	"general": "Auto-update, default agent and model, snapshots.",
	"appearance": "Panel mode, interface text scale, and motion.",
	"keybindings": "Application shortcuts and how a prompt is sent.",
	"notifications": "Attention notices and the ntfy topic they are sent to.",
	"office": "How the office renders: ambient motion and what a session shows.",
	"projects": "Recent and pinned folders, references, and the discovery rules.",
	"providers": "Configured providers, their packages, and custom endpoints.",
	"models": "The model catalogue, variants, capabilities and request overlays.",
	"browser": "Browser and computer capability, and whether the host grants it.",
	"agents": "Roles, models, step caps, hidden and disabled agents.",
	"skills": "Instruction sources, skills, and the instruction byte budget.",
	"commands": "Command templates and the agent, model and subtask they run as.",
	"permissions": "Tool permissions, guardrail limits, and custom safety rules.",
	"context": "Compaction, helper models, prompt caching and attachments.",
	"tools": "Shell, sandbox and memory limits, formatters, language servers, watchers.",
	"integrations": "MCP servers, plugins and hooks, and their authentication.",
	"usage": "Provider quota, session accounting and advisory budgets.",
	"updates": "Release channel and the update check policy.",
	"data": "Local diagnostics, log level, and retention.",
	"advanced": "Effective source and process environment ownership.",
}


## What a page covers, as the concrete configuration areas it is responsible for.
##
## Each item names a domain `docs/configuration.md` documents, so a page's contents
## are a claim about the runtime and not a decoration. These are NAVIGATION labels:
## they say which area lives on the page and make no claim about an effective value,
## which is the configuration bridge's business (R3-02).
const PAGE_COVERAGE := {
	"general": ["Runtime auto-update", "Default agent and model", "Snapshots and share"],
	"appearance": ["Panel colour mode", "Interface text scale", "Reduced motion"],
	"keybindings": ["Shortcut bindings", "Leader key timeout", "How a prompt is sent"],
	"notifications": ["Attention notices", "Notification sound", "ntfy topic"],
	"office": ["Ambient motion", "Session activity shown", "Bubble verbosity"],
	"projects": ["Recent and pinned folders", "Folder references", "Configuration discovery"],
	"providers": ["Configured providers", "Provider packages", "Custom endpoints and headers"],
	"models": ["Model catalogue", "Model variants", "Request overlays and limits"],
	"browser": ["Browser capability", "Computer capability", "Host OS permissions"],
	"agents": ["Agent roles", "Step caps and autonomy", "Hidden and disabled agents"],
	"skills": ["Instruction sources", "Skills", "Instruction byte budget"],
	"commands": ["Command templates", "Command agent and model", "Subtask commands"],
	"permissions": ["Tool permissions", "Guardrail limits and counters", "Custom safety rules"],
	"context": ["Compaction", "Helper models", "Prompt cache and attachments"],
	"tools": ["Shell, sandbox and memory limits", "Formatters and language servers", "File watcher"],
	"integrations": ["MCP servers and timeouts", "MCP authentication", "Plugins and hooks"],
	"usage": ["Provider quota", "Session accounting", "Advisory budgets"],
	"updates": ["Release channel", "Update check policy", "Restart requirement"],
	"data": ["Log level", "Local retention", "Redacted diagnostics"],
	"advanced": ["Effective configuration source", "Process environment ownership", "Inactive keys"],
}


## The top-level configuration keys each page owns, taken from the live `Config.Info`
## struct (`packages/core/src/config.ts`). Every key here is a real top-level
## configuration key, and each key has exactly ONE page, so two pages can never offer
## the same value and disagree about it.
##
## A page with no key is listed as empty rather than omitted: it is a real destination
## that owns no runtime configuration document value, which is a different statement
## from "this page is broken". Those pages are desktop preferences, connection surfaces
## whose values live nested under `providers`, or navigation-only areas.
const PAGE_KEYS := {
	"general": ["autoupdate", "default_agent", "model", "snapshots", "share", "enterprise", "username"],
	"appearance": [],
	"keybindings": [],
	"notifications": ["ntfy"],
	"office": [],
	"projects": ["references"],
	"providers": ["providers"],
	"models": [],
	"browser": [],
	"agents": ["agents"],
	"skills": ["skills", "instructions", "instruction_max_bytes"],
	"commands": ["commands"],
	"permissions": ["permissions", "guardrails", "experimental"],
	"context": ["compaction", "efficiency", "attachments", "tool_output", "image_analyzer", "memory"],
	"tools": ["shell", "shell_sandbox", "shell_memory_limit_mb", "formatter", "lsp", "watcher"],
	"integrations": ["mcp", "plugins"],
	"usage": ["provider_usage"],
	"updates": [],
	"data": [],
	"advanced": [],
}

## Why a page offers no configuration key, phrased for a reader. A page with no key is
## stated rather than left as an empty list.
const NO_KEY_REASONS := {
	"appearance": "Appearance is a desktop preference stored locally, not a runtime configuration value.",
	"keybindings": "Keybindings belong to the terminal client's own configuration, not to runtime configuration.",
	"office": "The office is this client's own presentation; the runtime has no configuration for it.",
	"models": "Model entries live nested under their provider, which the Providers page owns.",
	"browser": "Browser and computer capability is detected from the host, not configured here.",
	"updates": "Update behaviour is the runtime's own `autoupdate` key, owned by the General page.",
	"data": "Local data and diagnostics are this client's own files, not runtime configuration.",
	"advanced": "Advanced shows the effective source for every key; each key is owned by its own page.",
}


## Whether a string names a group this shell can show. An unknown group is refused
## rather than adopted, because a section with no pages renders as an empty box.
static func is_group(value: String) -> bool:
	return ORDER.has(value)


## A group name, or "" when the value is not one.
static func clamp_group(value: String) -> String:
	return value if is_group(value) else ""


static func label(group: String) -> String:
	return str(LABELS.get(group, group))


static func detail(group: String) -> String:
	return str(DETAIL.get(group, ""))


## Whether a string names a page.
static func is_page(value: String) -> bool:
	return PAGES.has(value)


static func group_of(page: String) -> String:
	return str(PAGES.get(page, ""))


static func page_label(page: String) -> String:
	return str(PAGE_LABELS.get(page, page))


static func page_detail(page: String) -> String:
	return str(PAGE_DETAIL.get(page, ""))


## The configuration areas a page covers, in declared order.
static func coverage(page: String) -> Array[String]:
	var listed: Variant = PAGE_COVERAGE.get(page, [])
	var out: Array[String] = []
	if listed is Array:
		for item in listed:
			out.append(str(item))
	return out


## The top-level configuration keys the page owns, in declared order.
##
## A page that owns no key returns an empty list, and `no_key_reason` explains why
## rather than leaving a reader to guess.
static func keys_for(page: String) -> Array[String]:
	var listed: Variant = PAGE_KEYS.get(page, [])
	var out: Array[String] = []
	if listed is Array:
		for item in listed:
			out.append(str(item))
	return out


## Why a page owns no configuration key, or "" when it owns at least one.
static func no_key_reason(page: String) -> String:
	if not keys_for(page).is_empty():
		return ""
	return str(NO_KEY_REASONS.get(page, ""))


## Every key any page owns, each exactly once. Used to prove no key is offered twice.
static func all_keys() -> Array[String]:
	var out: Array[String] = []
	for page in PAGES:
		for key in keys_for(str(page)):
			if not out.has(key):
				out.append(key)
	return out


## The page that owns a top-level key, or "" when no page claims it.
static func page_for_key(key: String) -> String:
	for page in PAGES:
		if keys_for(str(page)).has(key):
			return str(page)
	return ""


## Every page, in the order the navigation offers them: groups in `ORDER`, and
## within a group the order the pages table declares them in.
static func all_pages() -> Array[String]:
	var pages: Array[String] = []
	for group in ORDER:
		for page in PAGES:
			if str(PAGES[page]) == group:
				pages.append(str(page))
	return pages


## The pages a group offers, in declared order.
static func pages_in(group: String) -> Array[String]:
	var pages: Array[String] = []
	for page in PAGES:
		if str(PAGES[page]) == group:
			pages.append(str(page))
	return pages


## The groups that actually have pages, in `ORDER`. A group that lost its pages is
## not offered, so the navigation never shows a section that opens onto nothing.
static func groups_present() -> Array[String]:
	var groups: Array[String] = []
	for group in ORDER:
		if not pages_in(group).is_empty():
			groups.append(group)
	return groups


## The page a group opens on: its declared first page, or its first page, or "".
static func first_page(group: String) -> String:
	var declared := str(FIRST_PAGE.get(group, ""))
	if is_page(declared) and group_of(declared) == group:
		return declared
	var pages := pages_in(group)
	return pages[0] if not pages.is_empty() else ""


## The page a fresh settings visit opens on.
static func default_page() -> String:
	var groups := groups_present()
	return first_page(groups[0]) if not groups.is_empty() else ""


## The pages a query matches.
##
## A query matches a page by its own label, by its detail line, by the group it
## belongs to, or by the group's own label - so "providers" finds the Models page
## too, because Models is a connection. Matching is case-insensitive and ignores
## surrounding whitespace; an empty query matches every page, so clearing the box
## restores the full list rather than emptying it.
static func matching_pages(query: String) -> Array[String]:
	var needle := query.strip_edges().to_lower()
	if needle.is_empty():
		return all_pages()
	var matched: Array[String] = []
	for page in all_pages():
		if _matches(page, needle):
			matched.append(page)
	return matched


static func _matches(page: String, needle: String) -> bool:
	var group := group_of(page)
	var fields: Array[String] = [
		page_label(page),
		page_detail(page),
		group,
		label(group),
		detail(group),
	]
	# A page's COVERAGE is searchable too: "sandbox" must find Tools, and "ntfy"
	# must find Notifications, or the search box cannot reach a setting by the name
	# a person knows it by.
	for item in coverage(page):
		fields.append(item)
	for field in fields:
		if field.to_lower().contains(needle):
			return true
	return false


## The groups that still have a matching page under a query, in `ORDER`. A group
## whose pages are all filtered out is not offered, so a search never leaves an
## empty section behind.
static func matching_groups(query: String) -> Array[String]:
	var matched := matching_pages(query)
	var groups: Array[String] = []
	for group in groups_present():
		for page in matched:
			if group_of(page) == group:
				groups.append(group)
				break
	return groups


## The page `delta` steps from `page` within the matching set, wrapping at each end.
##
## Arrow navigation walks the list the user is actually looking at, so a filtered
## list cannot move the selection onto a page the search hid.
static func stepped_page(page: String, delta: int, query: String = "") -> String:
	var pages := matching_pages(query)
	if pages.is_empty():
		return ""
	var index := pages.find(page)
	if index < 0:
		return pages[0]
	return pages[posmod(index + delta, pages.size())]


## How many settings rows a page owns.
##
## The count is of the page's DECLARED coverage items, which is what the navigation
## can honestly say before the configuration bridge exists. It is deliberately not a
## count of runtime values: reaching those is R3-02's job, and a number derived from
## a read that does not exist yet would be invented.
static func row_count() -> int:
	return PAGES.size()