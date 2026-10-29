import { describe, expect, test } from "bun:test"
import { mergeToml, parseToml, projectToml, stringifyToml, TomlParseError, type TomlTable } from "../src/remote-control/cca-toml"

const render = (text: string, paths: string[][]) => {
  const projected = projectToml(parseToml(text), paths)
  return projected === undefined ? undefined : stringifyToml(projected as TomlTable)
}

describe("CCA TOML layer projection matches the official exec-server serializer", () => {
  test("tables, arrays of tables, key quoting, and insertion order", () => {
    const source = [
      'model = "synthetic"',
      "[mcp_servers.synthetic]",
      'command = "/synthetic/bin/server"',
      'args = ["--flag", "value"]',
      "startup_timeout_sec = 120",
      "[mcp_servers.synthetic.env]",
      'ZED = "1"',
      'ALPHA = "2"',
      '"needs space" = "3"',
      "[[mcp_servers.synthetic.list]]",
      "n = 1",
      "[[mcp_servers.synthetic.list]]",
      "n = 2",
      'inline = { b = 1, a = "x" }',
      "",
    ].join("\n")
    expect(render(source, [["mcp_servers"]])).toBe(
      '[mcp_servers.synthetic]\ncommand = "/synthetic/bin/server"\nargs = ["--flag", "value"]\nstartup_timeout_sec = 120\n\n[mcp_servers.synthetic.env]\nZED = "1"\nALPHA = "2"\n"needs space" = "3"\n\n[[mcp_servers.synthetic.list]]\nn = 1\n\n[[mcp_servers.synthetic.list]]\nn = 2\n\n[mcp_servers.synthetic.list.inline]\nb = 1\na = "x"\n',
    )
    expect(render(source, [["absent"]])).toBeUndefined()
  })

  test("string representations follow the literal, multiline, and escape rules", () => {
    const source = String.raw`quoted = 'has "double" quotes'
back = "a\\b"
both = "it's \"x\""
multi = "line1\nline2"
ctrl = "tab\there"
uni = "héllo"
s_ctrl = "a\u0001b"
s_cr = "a\rb"
s_triple = "x'''y"
s_endq = "it'"
s_bs_q = "a\\b'c"
s_empty = ""
s_nl_bs = "a\\b\nc"
s_del = "a\u007fb"
s_esc = "a\eb\x41"
`
    const keys = ["quoted", "back", "both", "multi", "ctrl", "uni", "s_ctrl", "s_cr", "s_triple", "s_endq", "s_bs_q", "s_empty", "s_nl_bs", "s_del", "s_esc"]
    expect(render(source, keys.map((key) => [key]))).toBe(
      [
        `quoted = 'has "double" quotes'`,
        String.raw`back = 'a\b'`,
        `both = """it's "x""""`,
        'multi = """\nline1\nline2"""',
        String.raw`ctrl = "tab\there"`,
        'uni = "héllo"',
        String.raw`s_ctrl = "a\u0001b"`,
        String.raw`s_cr = "a\rb"`,
        `s_triple = "x'''y"`,
        `s_endq = "it'"`,
        String.raw`s_bs_q = '''a\b'c'''`,
        's_empty = ""',
        "s_nl_bs = '''\na\\b\nc'''",
        String.raw`s_del = "a\u007Fb"`,
        String.raw`s_esc = "a\u001BbA"`,
        "",
      ].join("\n"),
    )
  })

  test("numbers, datetimes, arrays, inline tables, and quoted keys", () => {
    const source = `zeta = 1
alpha = 2.0
"10" = "ten"
"2" = "two"
a_inf = inf
a_ninf = -inf
a_nan = nan
a_negzero = -0.0
a_exp = 1e10
a_float = 3.14159
a_hex = 0xff
a_big = 9223372036854775807
a_neg = -42
a_us = 1_000
f_small = 0.0000001
f_huge = 1e300
when = 1979-05-27T07:32:00Z
d_local = 1979-05-27T07:32:00
d_frac = 1979-05-27T00:32:00.999999-07:00
d_date = 1979-05-27
d_time = 07:32:00
t_short = 07:32
dt_short = 1979-05-27T07:32Z
dt_space = 1979-05-27 07:32:00z
dt_zero_frac = 1979-05-27T07:32:00.000Z
dt_millis = 1979-05-27T07:32:00.120+05:30
k_arr_empty = []
k_arr_nested = [[1, 2], ["a"]]
k_arr_inline = [{ x = 1 }, { y = "z" }]
k_arr_mixed = [1, "a", true]
m_mixed = [1, { x = 1, y = { z = 2 } }]
m_inline_empty = [{}]
"key\\"q" = 1
"a.b" = 2
"" = 3
"é" = 4
`
    expect(stringifyToml(parseToml(source))).toBe(
      [
        "zeta = 1",
        "alpha = 2.0",
        '10 = "ten"',
        '2 = "two"',
        "a_inf = inf",
        "a_ninf = -inf",
        "a_nan = nan",
        "a_negzero = -0.0",
        "a_exp = 10000000000.0",
        "a_float = 3.14159",
        "a_hex = 255",
        "a_big = 9223372036854775807",
        "a_neg = -42",
        "a_us = 1000",
        "f_small = 0.0000001",
        `f_huge = 1${"0".repeat(300)}.0`,
        "when = 1979-05-27T07:32:00Z",
        "d_local = 1979-05-27T07:32:00",
        "d_frac = 1979-05-27T00:32:00.999999-07:00",
        "d_date = 1979-05-27",
        "d_time = 07:32:00",
        "t_short = 07:32:00",
        "dt_short = 1979-05-27T07:32:00Z",
        "dt_space = 1979-05-27T07:32:00Z",
        "dt_zero_frac = 1979-05-27T07:32:00Z",
        "dt_millis = 1979-05-27T07:32:00.12+05:30",
        "k_arr_empty = []",
        'k_arr_nested = [[1, 2], ["a"]]',
        'k_arr_mixed = [1, "a", true]',
        "m_mixed = [1, { x = 1, y = { z = 2 } }]",
        `'key"q' = 1`,
        '"a.b" = 2',
        '"" = 3',
        '"é" = 4',
        "",
        "[[k_arr_inline]]",
        "x = 1",
        "",
        "[[k_arr_inline]]",
        'y = "z"',
        "",
        "[[m_inline_empty]]",
        "",
      ].join("\n"),
    )
  })

  test("header-only tables, empty tables, multiline inline tables, and projection into arrays", () => {
    const source = `m_dotted = { a.b = 1, c = [] }
inl = {
  a = 1,
  b = 2,
}
[empty_table]
[[aot]]
[aot.sub]
k = 1
[[aot]]
v = 2
[[aot.inner]]
q = 1
[tab]
[tab.empty_child]
[tab.val_child]
x = 1
[outer]
v = 1
[outer.mid.inner]
w = 2
`
    expect(render(source, [["m_dotted"], ["inl"], ["empty_table"]])).toBe("[m_dotted]\nc = []\n\n[m_dotted.a]\nb = 1\n\n[inl]\na = 1\nb = 2\n\n[empty_table]\n")
    expect(render(source, [["aot"], ["tab"]])).toBe(
      "[[aot]]\n\n[aot.sub]\nk = 1\n\n[[aot]]\nv = 2\n\n[[aot.inner]]\nq = 1\n\n[tab.empty_child]\n\n[tab.val_child]\nx = 1\n",
    )
    expect(render(source, [["aot", "v"], ["tab", "empty_child"]])).toBe("[[aot]]\n\n[aot.sub]\nk = 1\n\n[[aot]]\nv = 2\n\n[[aot.inner]]\nq = 1\n\n[tab.empty_child]\n")
    expect(render(source, [["outer", "mid"], ["outer", "v", "deeper"]])).toBe("[outer]\nv = 1\n\n[outer.mid.inner]\nw = 2\n")
  })

  test("invalid documents report a line and column", () => {
    const error = (() => {
      try {
        parseToml("bad = = 1\n")
      } catch (caught) {
        return caught
      }
    })()
    expect(error).toBeInstanceOf(TomlParseError)
    expect(error).toMatchObject({ line: 1, column: 7 })
    for (const text of ["a = 1\na = 2\n", "[t]\n[t]\n", "x = 01\n", "x = 9223372036854775808\n", 'x = "open\n', "x = 1979-13-01\n", "t = { a = 1 }\n[t]\n"])
      expect(() => parseToml(text)).toThrow(TomlParseError)
  })
})

describe("CCA TOML layer merge matches codex_config::merge_toml_values", () => {
  const merge = (base: string, overlay: string) => stringifyToml(mergeToml(parseToml(base), parseToml(overlay)))

  test("legacy key aliases move to their canonical keys in the overlay and in base tables the overlay reaches", () => {
    expect(merge("", "[tui]\nwhimsy = true\n[agents]\nmax_threads = 3\n[memories]\nno_memories_if_mcp_or_web_search = true\n")).toBe(
      "[tui.effects]\nstarfield = true\n\n[agents]\nmax_concurrent_threads_per_session = 3\n\n[memories]\ndisable_on_external_context = true\n",
    )
    expect(merge("[agents]\nmax_threads = 3\n[memories]\nno_memories_if_mcp_or_web_search = false\n", "[agents]\nmax_depth = 2\n")).toBe(
      "[agents]\nmax_concurrent_threads_per_session = 3\nmax_depth = 2\n\n[memories]\nno_memories_if_mcp_or_web_search = false\n",
    )
    expect(merge("", "[agents]\nmax_threads = 3\nmax_concurrent_threads_per_session = 5\n")).toBe("[agents]\nmax_concurrent_threads_per_session = 5\n")
  })

  test("structured features keep a boolean as `enabled` when tables and booleans meet", () => {
    expect(merge("[features]\nnetwork_proxy = true\n", "[features.network_proxy]\ncredential_broker = true\n")).toBe(
      "[features.network_proxy]\nenabled = true\ncredential_broker = true\n",
    )
    expect(merge("[features.multi_agent_v2]\nenabled = true\nmax = 2\n", "[features]\nmulti_agent_v2 = false\n")).toBe("[features.multi_agent_v2]\nenabled = false\nmax = 2\n")
    expect(merge("[profiles.p.features]\ncode_mode = false\n", "[profiles.p.features.code_mode]\nlimit = 1\n")).toBe("[profiles.p.features.code_mode]\nenabled = false\nlimit = 1\n")
    expect(merge("[features]\nshell_snapshot = { a = 1 }\n", "[features]\nshell_snapshot = true\n")).toBe("[features]\nshell_snapshot = true\n")
  })

  test("credential providers that claim the same environment source replace earlier providers", () => {
    expect(
      merge(
        '[features.network_proxy.credentials.old]\nenv = ["TOKEN"]\n[features.network_proxy.credentials.other]\nenv = ["OTHER"]\n',
        '[features.network_proxy.credentials.new]\nenv = ["TOKEN"]\n',
      ),
    ).toBe('[features.network_proxy.credentials.other]\nenv = ["OTHER"]\n\n[features.network_proxy.credentials.new]\nenv = ["TOKEN"]\n')
  })

  test("shell environment filter representations replace each other and filter keys compare case-insensitively", () => {
    expect(merge('[shell_environment_policy]\nexclude = ["A"]\ninherit = "all"\n', "[shell_environment_policy.filters]\nAWS = false\n")).toBe(
      '[shell_environment_policy]\ninherit = "all"\n\n[shell_environment_policy.filters]\nAWS = false\n',
    )
    expect(merge("[shell_environment_policy.filters]\nAWS = true\n", "[shell_environment_policy.filters]\naws = false\n")).toBe("[shell_environment_policy.filters]\naws = false\n")
    expect(merge("[shell_environment_policy.filters]\nAWS = true\n", '[shell_environment_policy]\ninclude_only = ["PATH"]\n')).toBe(
      '[shell_environment_policy]\ninclude_only = ["PATH"]\n',
    )
  })

  test("network domain keys normalize hosts before merging", () => {
    expect(merge('[permissions.p.network.domains]\n"Example.COM." = "allow"\n', '[permissions.p.network.domains]\n"example.com:443" = "deny"\n"[::1]" = "allow"\n')).toBe(
      '[permissions.p.network.domains]\n"example.com" = "deny"\n"::1" = "allow"\n',
    )
  })
})
