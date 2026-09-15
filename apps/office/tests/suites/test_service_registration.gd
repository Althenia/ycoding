## Service discovery tests.
##
## TASK-045: attach to an existing daemon and exit without stopping it. The
## attach path is only correct if it looks where the CLI actually wrote the file,
## so the path search is pinned against the client's own contract.
extends RefCounted


func run(t) -> void:
	test_state_directory_is_searched(t)
	test_config_directory_is_never_searched(t)
	test_unset_variables_are_skipped(t)
	test_precedence_is_override_then_state_then_home(t)
	test_only_a_registration_with_a_url_is_usable(t)


## The client writes state, not config. A search that missed this would attach to
## nothing while looking like it had tried.
func test_state_directory_is_searched(t) -> void:
	var paths := ServiceRegistration.candidates("", "/state", "/home")
	t.check(
		paths.has("/state/ycoding/service.json"),
		"XDG_STATE_HOME is searched"
	)
	t.check(
		paths.has("/home/.local/state/ycoding/service.json"),
		"~/.local/state is searched as the fallback"
	)


## The config directory is the wrong location and must not be consulted.
func test_config_directory_is_never_searched(t) -> void:
	for path in ServiceRegistration.candidates("", "/state", "/home"):
		t.check(
			not path.contains("/.config/"),
			"no candidate reads the config directory"
		)


## An unset variable must be skipped, not joined into a relative path.
func test_unset_variables_are_skipped(t) -> void:
	var paths := ServiceRegistration.candidates("", "", "")
	t.check(paths.is_empty(), "with nothing set there is nothing to search")
	paths = ServiceRegistration.candidates("  ", "/state", "")
	t.check(
		paths.size() == 1 and paths[0] == "/state/ycoding/service.json",
		"blank inputs are skipped rather than joined"
	)
	for path in ServiceRegistration.candidates("", "", "/home"):
		t.check(not path.begins_with("/ycoding"), "an unset HOME never yields a root path")


func test_precedence_is_override_then_state_then_home(t) -> void:
	var paths := ServiceRegistration.candidates("/explicit.json", "/state", "/home")
	t.check(paths.size() == 3, "all three sources are considered")
	t.check(paths[0] == "/explicit.json", "the explicit override wins")
	t.check(paths[1] == "/state/ycoding/service.json", "state comes next")
	t.check(paths[2].ends_with("/.local/state/ycoding/service.json"), "home comes last")


func test_only_a_registration_with_a_url_is_usable(t) -> void:
	t.check(not ServiceRegistration.is_usable({}), "an empty object is not usable")
	t.check(not ServiceRegistration.is_usable("text"), "a non-object is not usable")
	t.check(
		not ServiceRegistration.is_usable({"pid": 12, "password": "x"}),
		"a registration with no url is not usable, because a url is the point"
	)
	t.check(
		ServiceRegistration.is_usable({"url": "http://127.0.0.1:4096", "pid": 12}),
		"a registration with a url is usable"
	)
