## The scopes the configuration owner actually resolves.
##
## This module encodes the LIVE contract, not an assumption about it. `server.config`
## (`packages/protocol/src/groups/config.ts`, `specs/v2/configuration-api.md`) declares
## exactly two scope sets:
##
##   * `Config.Scope`  = global | project | virtual   (read provenance)
##   * `Config.WriteScope` = global | project         (writable documents)
##
## So there are TWO writable scopes and they are the only two a control may name:
##
##   * global  - the platform global configuration document;
##   * project - the project document discovery found for the open Location.
##
## `virtual` is a PROVENANCE scope, not a writable one: it is a document without a file
## path (well-known integration configuration, or inline `YCODING_CONFIG_CONTENT`). A
## value whose most specific source is virtual is reported as such and offers no write,
## because there is no file to write.
##
## Two things this module deliberately does NOT pretend to support:
##
##   * a SESSION scope. Session overrides belong to the session contract and are not
##     configuration files. Offering one would name a target the API cannot write.
##   * a FOLDER scope distinct from the project document. The API has no path field: the
##     write target is always the document discovery already found, so a client cannot
##     choose an arbitrary path and must not imply that it can.
##
## Both are EXPLAINED rather than silently absent, and `not_a_scope_explanation` is the
## single source of that text so no surface invents its own wording.
##
## Pure presentation logic: this module decides which scopes are valid here. It does not
## read or write any configuration.
class_name SettingsScope
extends RefCounted

const GLOBAL := "global"
const PROJECT := "project"
const VIRTUAL := "virtual"

## Names that are NOT configuration scopes but are recognised settings concepts, so a
## surface can explain them rather than treating them as typos. Neither is ever writable.
const SESSION := "session"
const FOLDER := "folder"

## Every scope the owner reports as provenance, in precedence order from broadest to
## narrowest. `Config.Scope`.
const ALL := [GLOBAL, PROJECT, VIRTUAL]

## The scopes a document can be WRITTEN at. `Config.WriteScope`, exactly.
const WRITABLE := [GLOBAL, PROJECT]

## The names this application recognises as settings scopes, including the two concepts
## that are NOT configuration documents so they can be explained rather than appearing
## as typos.
const RECOGNISED := [GLOBAL, PROJECT, VIRTUAL, "folder", "session"]

const LABELS := {
	GLOBAL: "Global",
	PROJECT: "Project",
	VIRTUAL: "Configured elsewhere",
	"folder": "Folder",
	"session": "Session",
}

## Why a scope cannot be written here, per scope. Used wherever a scope is omitted or
## shown as unavailable, so the absence always has a stated cause.
const REASONS := {
	GLOBAL: "",
	PROJECT: "Open a project folder to write a project configuration document.",
	VIRTUAL: (
		"This value is set by a document with no file path (integration configuration or "
		+ "inline content), so there is no file to write."
	),
	"folder": (
		"A folder is not a configuration document. Project settings apply to the document "
		+ "discovery found for the open folder."
	),
	"session": (
		"Session overrides are not configuration documents. They belong to the session, "
		+ "not to a settings file."
	),
}


## The scopes a control may NAME for a write, in `ALL` order.
##
## `has_project` is true when the window holds an open project folder whose document can
## be written. Global is always writable: it is the broadest document and always exists.
static func writable(has_project: bool) -> Array[String]:
	var scopes: Array[String] = [GLOBAL]
	if has_project:
		scopes.append(PROJECT)
	return scopes


## The scopes offered for reading provenance, which includes the read-only ones.
static func readable(has_project: bool) -> Array[String]:
	var scopes: Array[String] = [GLOBAL]
	if has_project:
		scopes.append(PROJECT)
	scopes.append(VIRTUAL)
	return scopes


## Whether a scope is a document the API will accept a write for.
static func is_writable(scope: String) -> bool:
	return WRITABLE.has(scope)


## Whether a scope is valid for this context: a writable document that exists here, or a
## read-only provenance scope.
static func is_available(scope: String, has_project: bool) -> bool:
	return readable(has_project).has(scope)


## Whether a string names a scope the owner reports.
static func is_scope(value: String) -> bool:
	return ALL.has(value)


## Whether a string names something this application recognises as a settings concept,
## including the two that are not configuration documents.
static func is_recognised(value: String) -> bool:
	return RECOGNISED.has(value)


## Why a scope cannot be used here, or "" when it can.
##
## A concept that is not a configuration document is refused with its OWN reason rather
## than the context reason: "open a project folder" would be a false explanation for a
## session scope, which no folder would make writable.
static func reason_unavailable(scope: String, has_project: bool) -> String:
	if not is_recognised(scope):
		return "That is not a settings scope."
	if is_available(scope, has_project):
		return ""
	return str(REASONS.get(scope, ""))


## The explanation for a concept that is not WRITABLE, or "" when it is.
##
## A provenance scope that is a real scope but has no file to write - `virtual` - gets
## its own explanation, because it is not a not-a-scope and it is not a writable one
## either. The two concepts that are not configuration documents at all get theirs.
static func not_a_scope_explanation(scope: String) -> String:
	if is_writable(scope):
		return ""
	if is_scope(scope) or is_recognised(scope):
		return str(REASONS.get(scope, ""))
	return ""


## A scope name, or the fallback when the value is not one. A corrupt stored preference
## still yields a usable page.
static func clamp_scope(value: String, fallback: String = GLOBAL) -> String:
	if is_scope(value):
		return value
	return fallback if is_scope(fallback) else GLOBAL


## The scope a settings page opens on: the broadest writable document that exists here.
static func default_for(has_project: bool) -> String:
	var scopes := writable(has_project)
	return scopes[0] if not scopes.is_empty() else GLOBAL


## The scope that should be in force after the context changes.
##
## If the scope currently chosen is still available it is kept, because a context change
## must not silently move the user to another scope. Only a scope that has become
## invalid is replaced, and then by the default.
static func reconcile(current: String, has_project: bool) -> String:
	if is_available(clamp_scope(current), has_project):
		return clamp_scope(current)
	return default_for(has_project)


static func label(scope: String) -> String:
	return str(LABELS.get(scope, scope))


## How a scope is named in a row's badge, e.g. "Global" or "Project: beta".
##
## The project is named when one is open, because "Project" alone does not say WHICH
## document a value would be written to.
static func badge(scope: String, project_name: String = "") -> String:
	match clamp_scope(scope):
		PROJECT:
			return "Project: %s" % project_name if not project_name.is_empty() else "Project"
		_:
			return label(scope) if is_recognised(scope) else str(scope)