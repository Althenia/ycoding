# Screen design map

These are implementable composition specifications, not runtime screenshots. UI tokens are a starting scale system; user references and native verification determine final quality.

| Screen | Composition and primary flow | Failure/empty states |
|---|---|---|
| Office | Persistent sidebar; expansive world; You avatar; bottom-centered composer; contextual source drawer | No project, service disconnected, no running tasks, blocked agent |
| Projects | Native folder open + searchable/pinned list; project/folder/branch visible; independent drafts | Missing folder, permission denial, unresolved location, late switch response |
| Sessions | Searchable history list + rich transcript; show parent/child, actual tool output and source | Empty history, reconnect, stale selection, error, paginated result |
| Settings | Large page/dialog; grouped nav; search; scope selector; compact rows; advanced editor | Inherited override, invalid config, dirty form, conflict, unwritable source |
| Providers | Connected/available groups; identity and source; actual connect/test/disconnect workflow | Auth needed, offline, unsupported usage, missing permissions |
| Models | Search; provider grouping; enabled/available/variant; capability-bound controls | Stale catalog, no model selected, invalid capability |
| Statistics | Date/timezone/project filters; cards + activity chart/table + heatmap + breakdown | No observations, unknown prices, partial data, aggregation error |
| Quota/Budgets | Independent provider windows with units/freshness; local budget settings visibly separate | Unsupported, unauthorized, stale/error, unknown denominator |
| About/Updates | App vs service version; release channel; actual download/action | Incompatible service, unsigned candidate, network failure |

Settings or Statistics may temporarily replace the world content. Office remains the default, not a wallpaper behind giant generic panels. Return restores player/camera/draft. Human-attention notifications retain project/session scope on every screen.
