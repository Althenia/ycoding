# Initial settings catalog

All entries await local consumer and UI verification. See ALL_SETTINGS.md for the coverage gate. Wildcard records require schema-guided advanced editors, not raw unvalidated values.

| ID | Domain / path | Page | Treatment |
|---|---|---|---|
| SET-001 | `runtime:autoupdate` | General | editable_after_owner_audit |
| SET-002 | `runtime:username` | General | editable_after_owner_audit |
| SET-003 | `runtime:default_agent` | General | editable_after_owner_audit |
| SET-004 | `runtime:model` | General | editable_after_owner_audit |
| SET-005 | `runtime:snapshots` | General | editable_after_owner_audit |
| SET-006 | `runtime:share` | General | editable_after_owner_audit |
| SET-007 | `runtime:enterprise.url` | General | editable_after_owner_audit |
| SET-008 | `runtime:shell` | Tools / Shell | editable_after_owner_audit |
| SET-009 | `runtime:shell_sandbox` | Tools / Shell | editable_after_owner_audit |
| SET-010 | `runtime:shell_memory_limit_mb` | Tools / Shell | editable_after_owner_audit |
| SET-011 | `runtime:agents.*.model` | Agents | editable_after_owner_audit |
| SET-012 | `runtime:agents.*.request.headers.*` | Agents | editable_after_owner_audit |
| SET-013 | `runtime:agents.*.request.body.*` | Agents | editable_after_owner_audit |
| SET-014 | `runtime:agents.*.system` | Agents | editable_after_owner_audit |
| SET-015 | `runtime:agents.*.description` | Agents | editable_after_owner_audit |
| SET-016 | `runtime:agents.*.mode` | Agents | editable_after_owner_audit |
| SET-017 | `runtime:agents.*.hidden` | Agents | editable_after_owner_audit |
| SET-018 | `runtime:agents.*.disabled` | Agents | editable_after_owner_audit |
| SET-019 | `runtime:agents.*.color` | Agents | editable_after_owner_audit |
| SET-020 | `runtime:agents.*.steps` | Agents | editable_after_owner_audit |
| SET-021 | `runtime:agents.*.permissions[].action` | Agents | editable_after_owner_audit |
| SET-022 | `runtime:agents.*.permissions[].resource` | Agents | editable_after_owner_audit |
| SET-023 | `runtime:agents.*.permissions[].effect` | Agents | editable_after_owner_audit |
| SET-024 | `runtime:permissions[].action` | Permissions / Guardrails | editable_after_owner_audit |
| SET-025 | `runtime:permissions[].resource` | Permissions / Guardrails | editable_after_owner_audit |
| SET-026 | `runtime:permissions[].effect` | Permissions / Guardrails | editable_after_owner_audit |
| SET-027 | `runtime:guardrails.enabled` | Permissions / Guardrails | editable_after_owner_audit |
| SET-028 | `runtime:guardrails.max_concurrent_shells` | Permissions / Guardrails | editable_after_owner_audit |
| SET-029 | `runtime:guardrails.max_concurrent_subagents` | Permissions / Guardrails | editable_after_owner_audit |
| SET-030 | `runtime:guardrails.max_pending_reviews` | Permissions / Guardrails | editable_after_owner_audit |
| SET-031 | `runtime:experimental.subagent_depth` | Permissions / Guardrails | editable_after_owner_audit |
| SET-032 | `runtime:experimental.policies[]*` | Permissions / Guardrails | editable_after_owner_audit |
| SET-033 | `runtime:commands.*.template` | Commands | editable_after_owner_audit |
| SET-034 | `runtime:commands.*.description` | Commands | editable_after_owner_audit |
| SET-035 | `runtime:commands.*.agent` | Commands | editable_after_owner_audit |
| SET-036 | `runtime:commands.*.model` | Commands | editable_after_owner_audit |
| SET-037 | `runtime:commands.*.subtask` | Commands | editable_after_owner_audit |
| SET-038 | `runtime:references.*` | Projects / References | editable_after_owner_audit |
| SET-039 | `runtime:references.*.repository` | Projects / References | editable_after_owner_audit |
| SET-040 | `runtime:references.*.branch` | Projects / References | editable_after_owner_audit |
| SET-041 | `runtime:references.*.description` | Projects / References | editable_after_owner_audit |
| SET-042 | `runtime:references.*.hidden` | Projects / References | editable_after_owner_audit |
| SET-043 | `runtime:references.*.path` | Projects / References | editable_after_owner_audit |
| SET-044 | `runtime:skills[]` | Skills / Instructions | editable_after_owner_audit |
| SET-045 | `runtime:instruction_max_bytes` | Skills / Instructions | editable_after_owner_audit |
| SET-046 | `runtime:instructions[]` | Advanced / Inactive keys | inactive_explain_no_toggle |
| SET-047 | `runtime:$schema` | Advanced / Schema metadata | metadata_editor_only |
| SET-048 | `runtime:providers.*.name` | Providers | editable_after_owner_audit |
| SET-049 | `runtime:providers.*.package` | Providers | editable_after_owner_audit |
| SET-050 | `runtime:providers.*.env[]` | Providers | editable_after_owner_audit |
| SET-051 | `runtime:providers.*.settings.*` | Providers | editable_after_owner_audit |
| SET-052 | `runtime:providers.*.headers.*` | Providers | editable_after_owner_audit |
| SET-053 | `runtime:providers.*.body.*` | Providers | editable_after_owner_audit |
| SET-054 | `runtime:providers.*.models.*.modelID` | Models | editable_after_owner_audit |
| SET-055 | `runtime:providers.*.models.*.family` | Models | editable_after_owner_audit |
| SET-056 | `runtime:providers.*.models.*.name` | Models | editable_after_owner_audit |
| SET-057 | `runtime:providers.*.models.*.package` | Models | editable_after_owner_audit |
| SET-058 | `runtime:providers.*.models.*.settings.*` | Models | editable_after_owner_audit |
| SET-059 | `runtime:providers.*.models.*.headers.*` | Models | editable_after_owner_audit |
| SET-060 | `runtime:providers.*.models.*.body.*` | Models | editable_after_owner_audit |
| SET-061 | `runtime:providers.*.models.*.capabilities.tools` | Models | editable_after_owner_audit |
| SET-062 | `runtime:providers.*.models.*.capabilities.input[]` | Models | editable_after_owner_audit |
| SET-063 | `runtime:providers.*.models.*.capabilities.output[]` | Models | editable_after_owner_audit |
| SET-064 | `runtime:providers.*.models.*.variants[].id` | Models | editable_after_owner_audit |
| SET-065 | `runtime:providers.*.models.*.variants[].settings.*` | Models | editable_after_owner_audit |
| SET-066 | `runtime:providers.*.models.*.variants[].headers.*` | Models | editable_after_owner_audit |
| SET-067 | `runtime:providers.*.models.*.variants[].body.*` | Models | editable_after_owner_audit |
| SET-068 | `runtime:providers.*.models.*.cost*` | Models | editable_after_owner_audit |
| SET-069 | `runtime:providers.*.models.*.disabled` | Models | editable_after_owner_audit |
| SET-070 | `runtime:providers.*.models.*.limit.context` | Models | editable_after_owner_audit |
| SET-071 | `runtime:providers.*.models.*.limit.input` | Models | editable_after_owner_audit |
| SET-072 | `runtime:providers.*.models.*.limit.output` | Models | editable_after_owner_audit |
| SET-073 | `runtime:mcp.timeout.startup` | MCP | editable_after_owner_audit |
| SET-074 | `runtime:mcp.timeout.catalog` | MCP | editable_after_owner_audit |
| SET-075 | `runtime:mcp.timeout.execution` | MCP | editable_after_owner_audit |
| SET-076 | `runtime:mcp.servers.*.type` | MCP | editable_after_owner_audit |
| SET-077 | `runtime:mcp.servers.*.command[]` | MCP | editable_after_owner_audit |
| SET-078 | `runtime:mcp.servers.*.cwd` | MCP | editable_after_owner_audit |
| SET-079 | `runtime:mcp.servers.*.environment.*` | MCP | editable_after_owner_audit |
| SET-080 | `runtime:mcp.servers.*.disabled` | MCP | editable_after_owner_audit |
| SET-081 | `runtime:mcp.servers.*.timeout.startup` | MCP | editable_after_owner_audit |
| SET-082 | `runtime:mcp.servers.*.timeout.catalog` | MCP | editable_after_owner_audit |
| SET-083 | `runtime:mcp.servers.*.timeout.execution` | MCP | editable_after_owner_audit |
| SET-084 | `runtime:mcp.servers.*.codemode` | MCP | editable_after_owner_audit |
| SET-085 | `runtime:mcp.servers.*.url` | MCP | editable_after_owner_audit |
| SET-086 | `runtime:mcp.servers.*.headers.*` | MCP | editable_after_owner_audit |
| SET-087 | `runtime:mcp.servers.*.oauth` | MCP | editable_after_owner_audit |
| SET-088 | `runtime:mcp.servers.*.oauth.client_id` | MCP | editable_after_owner_audit |
| SET-089 | `runtime:mcp.servers.*.oauth.client_secret` | MCP | editable_after_owner_audit |
| SET-090 | `runtime:mcp.servers.*.oauth.scope` | MCP | editable_after_owner_audit |
| SET-091 | `runtime:mcp.servers.*.oauth.redirect_uri` | MCP | editable_after_owner_audit |
| SET-092 | `runtime:mcp.servers.*.oauth.callback_port` | MCP | editable_after_owner_audit |
| SET-093 | `runtime:plugins[]` | Plugins | editable_after_owner_audit |
| SET-094 | `runtime:plugins[].package` | Plugins | editable_after_owner_audit |
| SET-095 | `runtime:plugins[].options.*` | Plugins | editable_after_owner_audit |
| SET-096 | `runtime:formatter` | Tools / Formatters | editable_after_owner_audit |
| SET-097 | `runtime:formatter.*.disabled` | Tools / Formatters | editable_after_owner_audit |
| SET-098 | `runtime:formatter.*.command[]` | Tools / Formatters | editable_after_owner_audit |
| SET-099 | `runtime:formatter.*.environment.*` | Tools / Formatters | editable_after_owner_audit |
| SET-100 | `runtime:formatter.*.extensions[]` | Tools / Formatters | editable_after_owner_audit |
| SET-101 | `runtime:lsp` | Tools / Language servers | editable_after_owner_audit |
| SET-102 | `runtime:lsp.*.disabled` | Tools / Language servers | editable_after_owner_audit |
| SET-103 | `runtime:lsp.*.command[]` | Tools / Language servers | editable_after_owner_audit |
| SET-104 | `runtime:lsp.*.extensions[]` | Tools / Language servers | editable_after_owner_audit |
| SET-105 | `runtime:lsp.*.env.*` | Tools / Language servers | editable_after_owner_audit |
| SET-106 | `runtime:lsp.*.initialization.*` | Tools / Language servers | editable_after_owner_audit |
| SET-107 | `runtime:watcher.ignore[]` | Tools / Watcher | editable_after_owner_audit |
| SET-108 | `runtime:attachments.image.auto_resize` | Context / Attachments | editable_after_owner_audit |
| SET-109 | `runtime:attachments.image.max_width` | Context / Attachments | editable_after_owner_audit |
| SET-110 | `runtime:attachments.image.max_height` | Context / Attachments | editable_after_owner_audit |
| SET-111 | `runtime:attachments.image.max_base64_bytes` | Context / Attachments | editable_after_owner_audit |
| SET-112 | `runtime:tool_output.max_lines` | Context / Attachments | editable_after_owner_audit |
| SET-113 | `runtime:tool_output.max_bytes` | Context / Attachments | editable_after_owner_audit |
| SET-114 | `runtime:image_analyzer*` | Context / Attachments | editable_after_owner_audit |
| SET-115 | `runtime:compaction.keep_recent_messages` | Context / Compaction | editable_after_owner_audit |
| SET-116 | `runtime:compaction.reserved_output_tokens` | Context / Compaction | editable_after_owner_audit |
| SET-117 | `runtime:compaction.context_safety_margin_tokens` | Context / Compaction | editable_after_owner_audit |
| SET-118 | `runtime:compaction.timeout_seconds` | Context / Compaction | editable_after_owner_audit |
| SET-119 | `runtime:compaction.max_output_tokens` | Context / Compaction | editable_after_owner_audit |
| SET-120 | `runtime:compaction.max_manifest_bytes` | Context / Compaction | editable_after_owner_audit |
| SET-121 | `runtime:compaction.max_internal_passes` | Context / Compaction | editable_after_owner_audit |
| SET-122 | `runtime:compaction.advisory` | Context / Compaction | editable_after_owner_audit |
| SET-123 | `runtime:compaction.advisory.consider_percent` | Context / Compaction | editable_after_owner_audit |
| SET-124 | `runtime:compaction.advisory.strongly_advised_percent` | Context / Compaction | editable_after_owner_audit |
| SET-125 | `runtime:efficiency.title` | Context / Efficiency | editable_after_owner_audit |
| SET-126 | `runtime:efficiency.goal_synthesis` | Context / Efficiency | editable_after_owner_audit |
| SET-127 | `runtime:efficiency.helper_models.title` | Context / Efficiency | editable_after_owner_audit |
| SET-128 | `runtime:efficiency.helper_models.goal` | Context / Efficiency | editable_after_owner_audit |
| SET-129 | `runtime:efficiency.helper_models.compaction.main` | Context / Efficiency | editable_after_owner_audit |
| SET-130 | `runtime:efficiency.helper_models.compaction.subagent` | Context / Efficiency | editable_after_owner_audit |
| SET-131 | `runtime:efficiency.prompt_cache.anthropic_ttl` | Context / Efficiency | editable_after_owner_audit |
| SET-132 | `runtime:efficiency.prompt_cache.openai_mode` | Context / Efficiency | editable_after_owner_audit |
| SET-133 | `runtime:efficiency.prompt_cache.openai_extended_retention` | Context / Efficiency | editable_after_owner_audit |
| SET-134 | `runtime:efficiency.openai_responses_continuation` | Context / Efficiency | editable_after_owner_audit |
| SET-135 | `runtime:efficiency.openai_responses_state` | Context / Efficiency | editable_after_owner_audit |
| SET-136 | `runtime:ntfy.enabled` | Notifications | editable_after_owner_audit |
| SET-137 | `runtime:ntfy.topic` | Notifications | editable_after_owner_audit |
| SET-138 | `runtime:provider_usage.codex_app_server.command` | Usage / Provider quota | editable_after_owner_audit |
| SET-139 | `runtime:provider_usage.codex_app_server.args[]` | Usage / Provider quota | editable_after_owner_audit |
| SET-140 | `runtime:provider_usage.codex_app_server.cwd` | Usage / Provider quota | editable_after_owner_audit |
| SET-141 | `runtime:provider_usage.codex_app_server.timeout_ms` | Usage / Provider quota | editable_after_owner_audit |
| SET-142 | `tui:theme.name` | Appearance | adapt_semantics_separate_store |
| SET-143 | `tui:theme.mode` | Appearance | adapt_semantics_separate_store |
| SET-144 | `tui:keybinds.*` | Keybindings | audit_complete_action_registry |
| SET-145 | `tui:leader.timeout` | Keybindings | audit_complete_action_registry |
| SET-146 | `tui:attention.enabled` | Notifications | adapt_semantics_separate_store |
| SET-147 | `tui:attention.notifications` | Notifications | adapt_semantics_separate_store |
| SET-148 | `tui:attention.sound` | Notifications | adapt_semantics_separate_store |
| SET-149 | `tui:attention.volume` | Notifications | adapt_semantics_separate_store |
| SET-150 | `tui:attention.sound_pack` | Notifications | adapt_semantics_separate_store |
| SET-151 | `tui:attention.sounds.*` | Notifications | adapt_semantics_separate_store |
| SET-152 | `tui:scroll.speed` | Sessions / Presentation | adapt_semantics_separate_store |
| SET-153 | `tui:scroll.acceleration` | Sessions / Presentation | adapt_semantics_separate_store |
| SET-154 | `tui:diffs.wrap` | Sessions / Presentation | adapt_semantics_separate_store |
| SET-155 | `tui:diffs.tree` | Sessions / Presentation | adapt_semantics_separate_store |
| SET-156 | `tui:diffs.single` | Sessions / Presentation | adapt_semantics_separate_store |
| SET-157 | `tui:diffs.view` | Sessions / Presentation | adapt_semantics_separate_store |
| SET-158 | `tui:prompt.editor` | Sessions / Presentation | adapt_semantics_separate_store |
| SET-159 | `tui:prompt.paste` | Sessions / Presentation | adapt_semantics_separate_store |
| SET-160 | `tui:session.sidebar` | Sessions / Presentation | adapt_semantics_separate_store |
| SET-161 | `tui:session.scrollbar` | Sessions / Presentation | adapt_semantics_separate_store |
| SET-162 | `tui:session.thinking` | Sessions / Presentation | adapt_semantics_separate_store |
| SET-163 | `tui:session.grouping` | Sessions / Presentation | adapt_semantics_separate_store |
| SET-164 | `tui:hints.onboarding` | Sessions / Presentation | adapt_semantics_separate_store |
| SET-165 | `tui:animations` | Sessions / Presentation | adapt_semantics_separate_store |
| SET-166 | `tui:terminal.title` | Advanced / Terminal only | terminal_only_or_explicit_desktop_equivalent |
| SET-167 | `tui:mouse` | Advanced / Terminal only | terminal_only_or_explicit_desktop_equivalent |
| SET-168 | `tui:plugins[]` | Advanced / Terminal only | terminal_only_or_explicit_desktop_equivalent |
| SET-169 | `tui:plugins[].package` | Advanced / Terminal only | terminal_only_or_explicit_desktop_equivalent |
| SET-170 | `tui:plugins[].options.*` | Advanced / Terminal only | terminal_only_or_explicit_desktop_equivalent |
| SET-171 | `tui:debug.devtools` | Advanced / Terminal only | terminal_only_or_explicit_desktop_equivalent |
| SET-172 | `tui:debug.timing` | Advanced / Terminal only | terminal_only_or_explicit_desktop_equivalent |
| SET-173 | `tui:terminal.copy_on_select` | Advanced / Inactive keys | deprecated_ignored_no_toggle |
| SET-174 | `service:hostname` | Advanced / Service | owned_service_setup_secret_redacted |
| SET-175 | `service:port` | Advanced / Service | owned_service_setup_secret_redacted |
| SET-176 | `service:password` | Advanced / Service | owned_service_setup_secret_redacted |
| SET-177 | `environment:YCODING_CONFIG` | Advanced / Process configuration | provenance_and_restart_not_env_value_dump |
| SET-178 | `environment:YCODING_CONFIG_CONTENT` | Advanced / Process configuration | provenance_and_restart_not_env_value_dump |
| SET-179 | `environment:YCODING_CONFIG_DIR` | Advanced / Process configuration | provenance_and_restart_not_env_value_dump |
| SET-180 | `environment:YCODING_CONFIG_PROJECT_DISABLE` | Advanced / Process configuration | provenance_and_restart_not_env_value_dump |
| SET-181 | `environment:YCODING_DISABLE_PROJECT_CONFIG` | Advanced / Process configuration | provenance_and_restart_not_env_value_dump |
| SET-182 | `environment:YCODING_PASSWORD` | Advanced / Process configuration | provenance_and_restart_not_env_value_dump |
| SET-183 | `environment:YCODING_SERVER_PASSWORD` | Advanced / Process configuration | provenance_and_restart_not_env_value_dump |
| SET-184 | `environment:YCODING_DB` | Advanced / Process configuration | provenance_and_restart_not_env_value_dump |
| SET-185 | `environment:YCODING_MODELS_URL` | Advanced / Process configuration | provenance_and_restart_not_env_value_dump |
| SET-186 | `environment:YCODING_MODELS_PATH` | Advanced / Process configuration | provenance_and_restart_not_env_value_dump |
| SET-187 | `environment:YCODING_DISABLE_MODELS_FETCH` | Advanced / Process configuration | provenance_and_restart_not_env_value_dump |
| SET-188 | `environment:YCODING_DISABLE_AUTOUPDATE` | Advanced / Process configuration | provenance_and_restart_not_env_value_dump |
| SET-189 | `environment:YCODING_LOG_LEVEL` | Advanced / Process configuration | provenance_and_restart_not_env_value_dump |
| SET-190 | `environment:YCODING_PRINT_LOGS` | Advanced / Process configuration | provenance_and_restart_not_env_value_dump |
| SET-191 | `environment:YCODING_CLIENT` | Advanced / Process configuration | provenance_and_restart_not_env_value_dump |
| SET-192 | `environment:YCODING_GIT_BASH_PATH` | Advanced / Process configuration | provenance_and_restart_not_env_value_dump |
| SET-193 | `environment:YCODING_FILEWATCHER_DISABLE` | Advanced / Process configuration | provenance_and_restart_not_env_value_dump |
| SET-194 | `environment:YCODING_DISABLE_FILEWATCHER` | Advanced / Process configuration | provenance_and_restart_not_env_value_dump |
| SET-195 | `environment:YCODING_DISABLE_FFF` | Advanced / Process configuration | provenance_and_restart_not_env_value_dump |
| SET-196 | `environment:YCODING_WEBSEARCH_PROVIDER` | Advanced / Process configuration | provenance_and_restart_not_env_value_dump |
| SET-197 | `environment:YCODING_TERMINAL` | Advanced / Process configuration | provenance_and_restart_not_env_value_dump |
| SET-198 | `environment:YCODING_SIMULATE` | Advanced / Test-only | reject_or_explicit_diagnostic_in_production |
| SET-199 | `desktop:appearance.theme` | Appearance | proposed_implement_and_persist |
| SET-200 | `desktop:appearance.text_scale` | Appearance | proposed_implement_and_persist |
| SET-201 | `desktop:appearance.contrast` | Appearance | proposed_implement_and_persist |
| SET-202 | `desktop:appearance.motion` | Appearance | proposed_implement_and_persist |
| SET-203 | `desktop:startup.restore_projects` | General | proposed_implement_and_persist |
| SET-204 | `desktop:startup.default_view` | General | proposed_implement_and_persist |
| SET-205 | `desktop:updates.check_policy` | General | proposed_implement_and_persist |
| SET-206 | `desktop:updates.channel` | General | proposed_implement_and_persist |
| SET-207 | `desktop:office.show_player` | Office | proposed_implement_and_persist |
| SET-208 | `desktop:office.player_avatar` | Office | proposed_implement_and_persist |
| SET-209 | `desktop:office.walk_speed` | Office | proposed_implement_and_persist |
| SET-210 | `desktop:office.camera_follow` | Office | proposed_implement_and_persist |
| SET-211 | `desktop:office.camera_zoom` | Office | proposed_implement_and_persist |
| SET-212 | `desktop:office.click_to_walk` | Office | proposed_implement_and_persist |
| SET-213 | `desktop:office.ambient_motion` | Office | proposed_implement_and_persist |
| SET-214 | `desktop:office.bubble_verbosity` | Office | proposed_implement_and_persist |
| SET-215 | `desktop:office.activity_density` | Office | proposed_implement_and_persist |
| SET-216 | `desktop:input.bindings.*` | Keybindings | proposed_implement_and_persist |
| SET-217 | `desktop:input.send_behavior` | Keybindings | proposed_implement_and_persist |
| SET-218 | `desktop:input.camera_pan` | Keybindings | proposed_implement_and_persist |
| SET-219 | `desktop:projects.recent[]*` | Projects | proposed_implement_and_persist |
| SET-220 | `desktop:projects.pinned[]*` | Projects | proposed_implement_and_persist |
| SET-221 | `desktop:projects.views.*` | Projects | proposed_implement_and_persist |
| SET-222 | `desktop:projects.drafts.*` | Projects | proposed_implement_and_persist |
| SET-223 | `desktop:statistics.range` | Statistics / Budgets | proposed_implement_and_persist |
| SET-224 | `desktop:statistics.timezone` | Statistics / Budgets | proposed_implement_and_persist |
| SET-225 | `desktop:statistics.include_helpers` | Statistics / Budgets | proposed_implement_and_persist |
| SET-226 | `desktop:statistics.default_scope` | Statistics / Budgets | proposed_implement_and_persist |
| SET-227 | `desktop:statistics.export_privacy` | Statistics / Budgets | proposed_implement_and_persist |
| SET-228 | `desktop:budgets[]*` | Statistics / Budgets | proposed_implement_and_persist |
| SET-229 | `desktop:notifications.enabled` | Notifications | proposed_implement_and_persist |
| SET-230 | `desktop:notifications.background_only` | Notifications | proposed_implement_and_persist |
| SET-231 | `desktop:notifications.sound` | Notifications | proposed_implement_and_persist |
| SET-232 | `desktop:notifications.volume` | Notifications | proposed_implement_and_persist |
| SET-233 | `desktop:notifications.events.*` | Notifications | proposed_implement_and_persist |
| SET-234 | `desktop:diagnostics.log_level` | Data / Diagnostics | proposed_implement_and_persist |
| SET-235 | `desktop:diagnostics.redact` | Data / Diagnostics | proposed_implement_and_persist |
| SET-236 | `desktop:diagnostics.local_retention` | Data / Diagnostics | proposed_implement_and_persist |
