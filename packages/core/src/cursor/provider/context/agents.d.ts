export type CollectedAgent = {
    fullPath: string;
    name: string;
    description: string;
    prompt: string;
};
/**
 * Custom agents from the active OpenCode-compatible config roots. A host bridge may
 * install a host-neutral bridge before loading this module; without one this
 * remains the direct OpenCode discovery path.
 */
export declare function collectAgents(workspaceRoot: string): Promise<CollectedAgent[]>;
