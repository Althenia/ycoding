import type { CursorContinuationOptions } from "./session.js";
import type { HostToolDialect } from "./protocol/tools.js";
import type { createCursorLanguageModel } from "./language-model.js";
export type CursorRetryOptions = {
    /** Total attempts including the initial request. Default: 3. */
    maxAttempts?: number;
    /** Initial full-jitter backoff ceiling. Default: 500ms. */
    baseDelayMs?: number;
    /** Exponential backoff ceiling. Default: 8000ms. */
    maxDelayMs?: number;
};
export type CreateCursorOptions = {
    name: string;
    accessToken?: string;
    apiKey?: string;
    /** API base for auth, model discovery, and GetServerConfig. */
    apiBaseURL?: string;
    /** Explicit Cursor agent Run host override. */
    agentBaseURL?: string;
    /** @deprecated Use agentBaseURL. Kept as the legacy agent Run host override. */
    baseURL?: string;
    headers?: Record<string, string>;
    /** Opt in to telemetry on the GetServerConfig endpoint lookup. Defaults to false. */
    telemetryEnabled?: boolean;
    /** OpenCode project / worktree directory for request_context collectors. */
    workspaceRoot?: string;
    /**
     * Host cache root for Cursor project metadata + model/version caches.
     * Prefer the host's Path.cache (Effect v2) when available; otherwise the
     * provider resolves the native OpenCode cache dir, or an injected host path bridge.
     */
    cacheDir?: string;
    /** Held-stream policy. Defaults: heartbeat 5s, semantic idle 120s, tool inactivity 10m. */
    continuation?: CursorContinuationOptions;
    /** Fresh-turn retry policy. Defaults: 3 attempts, 500ms base, 8000ms cap. */
    retry?: CursorRetryOptions;
    /** Fallback host dialect when schemas are omitted or ambiguous. Default: OpenCode 1.x. */
    defaultDialect?: HostToolDialect;
};
export declare function createCursor(options: CreateCursorOptions): {
    languageModel(modelId: string): ReturnType<typeof createCursorLanguageModel>;
};
