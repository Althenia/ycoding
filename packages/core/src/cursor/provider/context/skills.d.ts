export type CollectedSkill = {
    fullPath: string;
    name: string;
    description: string;
    content: string;
};
/**
 * Discover skills the way OpenCode does: `.opencode/skills`, global opencode,
 * plus `.claude/skills` and `.agents/skills` (project + home).
 */
export declare function collectSkills(workspaceRoot: string, worktree: string): Promise<CollectedSkill[]>;
