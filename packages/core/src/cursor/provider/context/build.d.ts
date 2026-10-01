import { type OpencodeToolDef } from "../protocol/tools.js";
export type BuildRequestContextInput = {
    workspaceRoot: string;
    tools?: OpencodeToolDef[];
    providerIdentifier?: string;
    /** When set, skills/subagents/plugins are epoch-held for this conversation. */
    conversationId?: string;
};
export declare const DYNAMIC_REQUEST_CONTEXT_KEYS: readonly ["tools", "agent_skills", "custom_subagents", "mcp_file_system_options", "mcp_meta_tool_options", "web_search_enabled", "web_fetch_enabled", "agent_skills_info_complete", "custom_subagents_info_complete", "mcp_file_system_info_complete", "mcp_info_complete", "hooks_additional_context"];
export type DynamicRequestContextKey = typeof DYNAMIC_REQUEST_CONTEXT_KEYS[number];
/**
 * Full RequestContext payload for live UMA + exec #10 reply.
 * Sourced from OpenCode discovery (and .claude/.agents skill fallbacks).
 * Honors `instructions` globs the same way OpenCode does. The provider never
 * looks in Cursor's own directories; a `.cursor/` path is read only when the
 * user's own OpenCode config lists it, exactly as the host would read it.
 */
export declare function buildRequestContext(input: BuildRequestContextInput): Promise<Record<string, unknown>>;
/** Rediscover only capability/plugin sections that may change during a chat. */
export declare function buildDynamicRequestContext(input: BuildRequestContextInput): Promise<Record<string, unknown>>;
/** Keep expensive workspace state frozen while replacing every live capability field. */
export declare function materializeRequestContext(base: Record<string, unknown>, dynamic: Record<string, unknown>): Record<string, unknown>;
/** Strip live capability fields before retaining/persisting a conversation base. */
export declare function requestContextBase(context: Record<string, unknown>): Record<string, unknown>;
