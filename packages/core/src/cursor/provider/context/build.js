import path from "node:path";
import { extractHostSubagentCatalog, toolsToDescriptors, toolsToMcpDescriptors, } from "../protocol/tools.js";
import { collectRules, findGitWorktree, loadMergedConfig, } from "./rules.js";
import { collectSkills } from "./skills.js";
import { collectPlugins } from "./plugins.js";
import { collectGit } from "./git.js";
import { collectProjectLayout } from "./layout.js";
import { buildEnv } from "./env.js";
import { ensureCursorProjectDir } from "./paths.js";
import { holdCapabilityOverlay } from "./overlay.js";
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
/**
 * Full RequestContext payload for live UMA + exec #10 reply.
 * Sourced from YCoding configuration and supported skill roots.
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
    return ctx;
}
async function buildDynamicRequestContextFromDiscovery(input, workspaceRoot, worktree, config) {
    const providerIdentifier = input.providerIdentifier ?? "opencode";
    const tools = input.tools ?? [];
    const [skills, plugins] = await Promise.all([
        collectSkills(workspaceRoot, worktree),
        collectPlugins(workspaceRoot, config),
    ]);
    const mcpServerNames = Object.keys(config.mcp?.servers ?? {});
    const flat = toolsToDescriptors(tools, providerIdentifier, mcpServerNames);
    const nested = toolsToMcpDescriptors(tools, providerIdentifier, mcpServerNames);
    const projectDir = ensureCursorProjectDir(workspaceRoot);
    const hostSubagents = extractHostSubagentCatalog(tools);
    const customSubagents = hostSubagents.agents.map((agent) => ({
        full_path: "",
        name: agent.name,
        description: agent.description || "Host-configured subagent.",
        prompt: `Delegate to the host-configured ${agent.name} subagent; its host instructions and tools apply.`,
    }));
    const liveSkills = skills.map((s) => ({
        id: s.name,
        full_path: s.fullPath,
        description: s.description,
    }));
    const livePlugins = plugins.map((p) => ({
        id: p.id,
        line: `ycoding-plugin:${p.source}:${p.id}`,
    }));
    const overlay = input.conversationId
        ? holdCapabilityOverlay(input.conversationId, {
            skills: liveSkills,
            subagents: customSubagents,
            plugins: livePlugins,
        })
        : { skills: liveSkills.map(({ full_path, description }) => ({ full_path, description })), subagents: customSubagents, plugins: livePlugins };
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
        agent_skills_info_complete: false,
        custom_subagents_info_complete: hostSubagents.complete,
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
