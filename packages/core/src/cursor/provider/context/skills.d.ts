export type CollectedSkill = {
    fullPath: string;
    name: string;
    description: string;
};
/**
 * Discover YCoding skill descriptors and supported `.claude`/`.agents` sources.
 */
export declare function collectSkills(workspaceRoot: string, worktree: string): Promise<CollectedSkill[]>;
