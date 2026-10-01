/**
 * Host-owned primary-agent synchronization for Cursor SwitchMode.
 *
 * The language model stays host-neutral: it records a canonical Cursor mode
 * (`plan`, `spec`, `agent`, ...). A host entrypoint may install this structural
 * callback when its public API can select the corresponding primary agent.
 * OpenCode 2.0 uses it to select its vendor-maintained `plan` / `build` agents;
 * OpenCode 1.x continues to use advertised `plan_enter` / `plan_exit` tools.
 */
export type HostAgentModeSwitchInput = {
    sessionID: string;
    targetModeID: string;
    /** Concrete Cursor Run that owns the switch. */
    cursorSessionID?: string;
};
export type HostAgentModeSwitchFn = (input: HostAgentModeSwitchInput) => void | Promise<void>;
export declare function setHostAgentModeSwitch(fn: HostAgentModeSwitchFn | undefined): void;
/** Queue only when this host installed a native primary-agent switch. */
export declare function queueHostAgentModeSwitch(input: HostAgentModeSwitchInput): boolean;
export declare function cancelHostAgentModeSwitch(sessionID: string | undefined): void;
/**
 * Apply the switch only after its Cursor Run is terminal and owns no pending
 * execs. This avoids changing the host's permission/catalog state underneath a
 * held Run that still needs to finish or receive a tool result.
 */
export declare function flushHostAgentModeSwitch(sessionID: string | undefined, options?: {
    cursorSessionID?: string;
    terminal?: boolean;
    pumpActive?: boolean;
    pendingExecs?: number;
}): Promise<boolean>;
export declare function resetHostAgentModeSwitchForTests(): void;
