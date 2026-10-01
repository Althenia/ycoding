/**
 * Epoch-hold live RequestContext overlay lists (skills, subagents, plugins).
 *
 * Same policy as the tool catalog: first nonempty freeze is UTF-16 by id,
 * equal ids keep frozen bytes (including content), new ids append at the
 * tail, shrink keeps the epoch advertisement. Discovery still runs every
 * Run; this only canonicalizes what is advertised.
 */
export declare const MAX_OVERLAY_HOLDS = 256;
export type OverlaySkill = {
    id: string;
    full_path: string;
    content: string;
    description: string;
};
export type OverlaySubagent = {
    full_path: string;
    name: string;
    description: string;
    prompt: string;
};
export type OverlayPlugin = {
    id: string;
    line: string;
};
export type OverlayHold = {
    skills: OverlaySkill[];
    subagents: OverlaySubagent[];
    plugins: OverlayPlugin[];
};
export type OverlayWire = {
    skills: Array<{
        full_path: string;
        content: string;
        description: string;
    }>;
    subagents: OverlaySubagent[];
    plugins: OverlayPlugin[];
};
/** Merge live discovery into the conversation overlay epoch. */
export declare function holdCapabilityOverlay(conversationId: string, live: OverlayHold): OverlayWire;
export declare function clearOverlayHold(conversationId: string): void;
export declare function transferOverlayHold(previousConversationId: string, nextConversationId: string): void;
export declare function resetOverlayHoldsForTests(): void;
