## Resolving a chosen folder into a project target.
##
## A folder the user picks becomes a LOCATION the runtime is asked about, and that
## resolution has rules the kit states explicitly (`docs/MULTI_PROJECT.md`):
##
##   * canonicalize before use, resolving symlinks so the same folder chosen by two
##     routes is one location;
##   * respect host case sensitivity and NEVER lowercase a path;
##   * keep two worktrees of one repository as SEPARATE locations;
##   * keep a monorepo subdirectory as its own location rather than collapsing it to
##     the repository root;
##   * refuse a missing or inaccessible folder with a reason a user can read, and
##     distinguish the two, because "does not exist" and "cannot be read" are
##     different problems with different fixes.
##
## Chosen deliberately: git identity is discovered by READING `.git` and its `HEAD`
## rather than by running `git`. A shipped module may not spawn processes -- the
## asset-provenance suite allows only reviewed OS calls under `app`, `ui`, `core`,
## `office` and `integration` -- and reading the files git itself writes is both
## dependency-free and sufficient for the branch name.
##
## Selecting a folder is NEVER execution consent. This module only resolves and
## reports; nothing here creates a session, submits a prompt, or starts work.
class_name FolderTarget
extends RefCounted

## What the chosen directory turned out to be.
const KIND_FOLDER := "folder"
const KIND_GIT := "git"

## The last refusal, so a caller can say WHY rather than showing a dead control.
var _last_error: String = ""
var _directory: String = ""
var _kind: String = ""
var _branch: String = ""
var _root: String = ""


## Resolve a chosen path, or return "" with a reason.
##
## The path is canonicalized first, so a caller never compares or keys by an
## unnormalized string.
func resolve(path: String) -> String:
	_last_error = ""
	_directory = ""
	_kind = ""
	_branch = ""
	_root = ""

	var cleaned := _canonicalize(path)
	if cleaned.is_empty():
		_last_error = "That is not an absolute folder path."
		return ""
	# Links are resolved BEFORE the existence check, so a symlink to a real folder is
	# accepted and canonicalizes to its target.
	if DirAccess.open(cleaned) != null:
		cleaned = _resolve_links(cleaned)
	if not DirAccess.dir_exists_absolute(cleaned):
		_last_error = "That folder does not exist."
		return ""
	# `dir_exists_absolute` answers true for a directory this process cannot read, so
	# existence and readability are separate questions and are asked separately.
	if DirAccess.open(cleaned) == null:
		_last_error = "That folder exists but cannot be read. Check its permissions."
		return ""

	_directory = cleaned
	var git_root := _find_git_root(cleaned)
	if git_root.is_empty():
		_kind = KIND_FOLDER
		return _directory

	_kind = KIND_GIT
	_root = git_root
	_branch = _read_branch(git_root)
	return _directory


## The resolved directory, or "" when nothing has been resolved.
func directory() -> String:
	return _directory


## Whether the resolved directory is a git project or a plain folder.
func project_kind() -> String:
	return _kind


## The checked-out branch of the resolved git project, or "" for a non-git folder or
## a detached HEAD.
func branch() -> String:
	return _branch


## The repository root of the resolved git project, or "" for a plain folder. Kept
## separate from `directory()` because they differ for a monorepo subdirectory: the
## location is the FOLDER CHOSEN, and the root is only reported alongside it.
func repository_root() -> String:
	return _root


func last_error() -> String:
	return _last_error


## Whether a path is absolute, which is what makes it safe to key by. Both separators
## are accepted so a stored Windows path is recognised rather than treated as relative.
static func is_absolute(path: String) -> bool:
	if path.is_empty():
		return false
	if path.begins_with("/"):
		return true
	# A drive-letter path such as C:\Users\me, or a UNC path.
	if path.length() >= 3 and path[1] == ":" and (path[2] == "\\" or path[2] == "/"):
		return true
	return path.begins_with("\\\\")


## Normalize a path WITHOUT resolving symlinks: collapse repeated separators and
## remove "." and ".." segments, so `a/./b/../c` becomes `a/c`.
##
## Symlink resolution is deliberately left to `resolve`, because collapsing `..`
## lexically is correct only before a link is followed and would otherwise be a lie.
static func _canonicalize(path: String) -> String:
	var trimmed := path.strip_edges()
	if trimmed.is_empty() or not is_absolute(trimmed):
		return ""
	var separator := "/"
	if trimmed.find("\\") != -1 and trimmed.find("/") == -1:
		separator = "\\"
	var parts: Array[String] = []
	for segment in trimmed.split(separator, false):
		if segment == "." or segment.is_empty():
			continue
		if segment == "..":
			if not parts.is_empty():
				parts.remove_at(parts.size() - 1)
			continue
		parts.append(segment)
	return separator + separator.join(parts)


## Resolve symlinks in a path that already exists.
##
## Each ancestor is replaced by its real target, walking from the root down, so the
## result names the real directory rather than the link the user navigated through.
func _resolve_links(path: String) -> String:
	if not DirAccess.dir_exists_absolute(path):
		return path
	var dir := DirAccess.open(path)
	if dir == null:
		return path
	# `is_equivalent` compares two paths after resolving links, which is the mechanism
	# the platform gives us for identifying a link with its target without walking
	# every ancestor by hand.
	var real := _real_path_of(path)
	return real if not real.is_empty() else path


## The real path behind a link, using the platform's own resolution where it offers
## one. The link's text target is read and made absolute relative to the link's own
## directory, which is exactly how the filesystem resolves it.
func _real_path_of(path: String) -> String:
	var parent := path.get_base_dir()
	var leaf := path.get_file()
	if parent.is_empty() or leaf.is_empty():
		return path
	var dir := DirAccess.open(parent)
	if dir == null:
		return path
	if not dir.is_link(leaf):
		# Not a link itself, but an ANCESTOR may be, so keep walking up.
		var up := _real_path_of(parent)
		return up.path_join(leaf) if not up.is_empty() else path
	var target := dir.read_link(leaf)
	if target.is_empty():
		return path
	var absolute := target if FolderTarget.is_absolute(target) else parent.path_join(target)
	var resolved_parent := _real_path_of(absolute)
	return resolved_parent if not resolved_parent.is_empty() else absolute


## Walk upward looking for the `.git` entry git writes at a repository or worktree
## root. A worktree's `.git` is a FILE pointing at the worktree's admin directory,
## which is why existence rather than directory-ness is what is checked.
func _find_git_root(path: String) -> String:
	var current := path
	for _step in 64:
		if current.is_empty():
			return ""
		var dir := DirAccess.open(current)
		if dir != null and (dir.dir_exists(".git") or dir.file_exists(".git")):
			return current
		var parent := current.get_base_dir()
		if parent == current or parent.is_empty():
			return ""
		current = parent
	return ""


## The checked-out branch from git's own `HEAD`.
##
## A worktree's `.git` is a file naming its admin directory, and `HEAD` lives there,
## so that case is followed rather than assumed to be a directory.
func _read_branch(root: String) -> String:
	var head := _head_path(root)
	if head.is_empty():
		return ""
	var file := FileAccess.open(head, FileAccess.READ)
	if file == null:
		return ""
	var line := file.get_line().strip_edges()
	file.close()
	const PREFIX := "ref: refs/heads/"
	if not line.begins_with(PREFIX):
		return ""
	return line.substr(PREFIX.length())


## Where this repository's or worktree's `HEAD` actually is.
func _head_path(root: String) -> String:
	if DirAccess.dir_exists_absolute(root + "/.git"):
		return root + "/.git/HEAD"
	var pointer := FileAccess.open(root + "/.git", FileAccess.READ)
	if pointer == null:
		return ""
	var text := pointer.get_line().strip_edges()
	pointer.close()
	const PREFIX := "gitdir: "
	if not text.begins_with(PREFIX):
		return ""
	var admin := text.substr(PREFIX.length()).strip_edges()
	var absolute := admin if FolderTarget.is_absolute(admin) else root.path_join(admin)
	return absolute.path_join("HEAD")
