import path from "node:path";
import { extractHostSubagentCatalog, toolsToDescriptors, toolsToMcpDescriptors, } from "../protocol/tools.js";
import { collectRules, findGitWorktree, loadMergedConfig, } from "./rules.js";
import { collectSkills } from "./skills.js";
import { collectAgents } from "./agents.js";
import { collectPlugins } from "./plugins.js";
import { collectGit } from "./git.js";
import { collectProjectLayout } from "./layout.js";
import { buildEnv } from "./env.js";
import { ensureOpencodeProjectDir } from "./paths.js";
import { holdCapabilityOverlay } from "./overlay.js";
import { traceRequestContextPaths } from "../debug.js";
export const DYNAMIC_REQUEST_CONTEXT_KEYS = [
    "tools",
    "agent_skills",
    "custom_subagents",
    "mcp_file_system_options",
    "mcp_meta_tool_options",
    "web_search_enabled",
    "web_fetch_enabled",
    "agent_skills_info_complete",
    "custom_subagents_info_complete",
    "mcp_file_system_info_complete",
    "mcp_info_complete",
    "hooks_additional_context",
];
const DEFAULT_HOST_SUBAGENTS = [
    {
        name: "general",
        description: "General-purpose agent for complex research and multi-step tasks.",
    },
    {
        name: "explore",
        description: "Read-only agent for searching and understanding the local codebase.",
    },
];
/**
 * Convert the raw host executor catalog into the exact subagent list advertised
 * to Cursor. `hostSubagents.complete` answers a narrow question: did the host's
 * task tool itself exposes an exhaustive recipient list (schema enum or
 * catalog marker)? OpenCode's task tool intentionally uses a plain string, so
 * that raw flag is false even though we can still advertise a complete Cursor
 * catalog by adding built-in defaults and discovered agent files.
 *
 * `custom_subagents_info_complete` must describe the final advertised list, not
 * the raw extraction source. If there is no executor, the empty list is
 * complete. If the host catalog is complete, use it verbatim. Otherwise we make
 * the advertised set complete by augmenting with default host agents and all
 * locally discovered agents.
 */
function buildAdvertisedSubagentCatalog(hostSubagents, discoveredAgents) {
    if (!hostSubagents.executor)
        return { agents: [], complete: true };
    if (hostSubagents.complete)
        return { agents: hostSubagents.agents, complete: true };
    return {
        agents: [...DEFAULT_HOST_SUBAGENTS, ...hostSubagents.agents, ...discoveredAgents],
        complete: true,
    };
}
/**
 * Full RequestContext payload for live UMA + exec #10 reply.
 * Sourced from OpenCode discovery (and .claude/.agents skill fallbacks).
 * Honors `instructions` globs the same way OpenCode does. The provider never
 * looks in Cursor's own directories; a `.cursor/` path is read only when the
 * user's own OpenCode config lists it, exactly as the host would read it.
 */
export async function buildRequestContext(input) {
    const workspaceRoot = path.resolve(input.workspaceRoot || process.cwd());
    const { rules, config, worktree } = await collectRules(workspaceRoot);
    const [dynamic, git, layout] = await Promise.all([
        buildDynamicRequestContextFromDiscovery(input, workspaceRoot, worktree, config),
        collectGit(workspaceRoot),
        collectProjectLayout(workspaceRoot),
    ]);
    const base = {
        env: buildEnv(workspaceRoot),
        rules: rules.map((r) => ({
            full_path: r.fullPath,
            content: r.content,
        })),
        repository_info: git.repositoryInfo,
        git_repos: git.gitRepos,
        project_layouts: [layout],
        rules_info_complete: true,
        env_info_complete: true,
        repository_info_complete: true,
        git_repo_info_complete: true,
        git_status_info_complete: true,
    };
    const ctx = materializeRequestContext(base, dynamic);
    traceRequestContextPaths("buildRequestContext", ctx);
    return ctx;
}
async function buildDynamicRequestContextFromDiscovery(input, workspaceRoot, worktree, config) {
    const providerIdentifier = input.providerIdentifier ?? "opencode";
    const tools = input.tools ?? [];
    const [skills, agents, plugins] = await Promise.all([
        collectSkills(workspaceRoot, worktree),
        collectAgents(workspaceRoot),
        collectPlugins(workspaceRoot, config),
    ]);
    const mcpServerNames = Object.keys(config.mcp ?? {});
    const flat = toolsToDescriptors(tools, providerIdentifier, mcpServerNames);
    const nested = toolsToMcpDescriptors(tools, providerIdentifier, mcpServerNames);
    const projectDir = ensureOpencodeProjectDir(workspaceRoot);
    const hostSubagents = extractHostSubagentCatalog(tools);
    const advertisedSubagents = buildAdvertisedSubagentCatalog(hostSubagents, agents);
    const discoveredByName = new Map(agents.map((agent) => [agent.name, agent]));
    const advertisedByName = new Map();
    for (const agent of advertisedSubagents.agents) {
        if (!advertisedByName.has(agent.name))
            advertisedByName.set(agent.name, agent);
    }
    const customSubagents = [...advertisedByName.values()].map((agent) => {
        const discovered = discoveredByName.get(agent.name);
        return {
            full_path: discovered?.fullPath ?? "",
            name: agent.name,
            description: discovered?.description || agent.description || "Host-configured subagent.",
            // The host applies the real configured prompt when Task/Actor executes.
            // Cursor only needs enough context to select the recipient intentionally.
            prompt: discovered?.prompt ||
                `Delegate to the host-configured ${agent.name} subagent; its host instructions and tools apply.`,
        };
    });
    const liveSkills = skills.map((s) => ({
        id: s.name,
        full_path: s.fullPath,
        content: s.content,
        description: s.description,
    }));
    const livePlugins = plugins.map((p) => ({
        id: p.id,
        line: `opencode-plugin:${p.source}:${p.id}`,
    }));
    const overlay = input.conversationId
        ? holdCapabilityOverlay(input.conversationId, {
            skills: liveSkills,
            subagents: customSubagents,
            plugins: livePlugins,
        })
        : { skills: liveSkills.map(({ full_path, content, description }) => ({ full_path, content, description })), subagents: customSubagents, plugins: livePlugins };
    const dynamic = {
        tools: flat,
        agent_skills: overlay.skills,
        custom_subagents: overlay.subagents,
        mcp_file_system_options: {
            enabled: true,
            // Cursor metadata root (mcps / agent-tools), not the git workspace.
            workspace_project_dir: projectDir,
            mcp_descriptors: nested,
        },
        mcp_meta_tool_options: {
            enabled: true,
            mcp_descriptors: nested,
        },
        // This provider always rejects native web_search/web_fetch interaction
        // queries with a headless-UI reason (see interactions.ts). Advertise that
        // unavailability up front so Cursor prefers the collision-safe
        // custom_web* aliases instead of routing through a query doomed to fail.
        web_search_enabled: false,
        web_fetch_enabled: false,
        agent_skills_info_complete: true,
        custom_subagents_info_complete: advertisedSubagents.complete,
        mcp_file_system_info_complete: true,
        mcp_info_complete: true,
    };
    if (overlay.plugins.length > 0) {
        dynamic.hooks_additional_context = overlay.plugins.map((p) => p.line).join("\n");
    }
    return dynamic;
}
/** Rediscover only capability/plugin sections that may change during a chat. */
export async function buildDynamicRequestContext(input) {
    const workspaceRoot = path.resolve(input.workspaceRoot || process.cwd());
    const [worktree, config] = await Promise.all([
        findGitWorktree(workspaceRoot),
        loadMergedConfig(workspaceRoot),
    ]);
    return buildDynamicRequestContextFromDiscovery(input, workspaceRoot, worktree, config);
}
/** Keep expensive workspace state frozen while replacing every live capability field. */
export function materializeRequestContext(base, dynamic) {
    const context = structuredClone(base);
    for (const key of DYNAMIC_REQUEST_CONTEXT_KEYS)
        delete context[key];
    for (const key of DYNAMIC_REQUEST_CONTEXT_KEYS) {
        if (Object.hasOwn(dynamic, key))
            context[key] = structuredClone(dynamic[key]);
    }
    return context;
}
/** Strip live capability fields before retaining/persisting a conversation base. */
export function requestContextBase(context) {
    const base = structuredClone(context);
    for (const key of DYNAMIC_REQUEST_CONTEXT_KEYS)
        delete base[key];
    return base;
}
