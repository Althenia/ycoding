export declare class AuthExchangeError extends Error {
    cause?: unknown | undefined;
    constructor(message: string, cause?: unknown | undefined);
}
export declare class AuthRefreshError extends Error {
    cause?: unknown | undefined;
    constructor(message: string, cause?: unknown | undefined);
}
export declare class AuthPollError extends Error {
    cause?: unknown | undefined;
    constructor(message: string, cause?: unknown | undefined);
}
export declare class AuthTimeoutError extends Error {
    constructor(message: string);
}
export declare function isExpiringSoon(jwt: string, thresholdS?: number): boolean;
export declare function decodeJwtPayload(jwt: string): Record<string, unknown> | null;
/** JWT `exp` claim as epoch milliseconds, or null if missing/malformed. */
export declare function decodeJwtExpiryMs(jwt: string): number | null;
export declare function useAuthToken(token: string): {
    accessToken: string;
};
export type TokenPair = {
    accessToken: string;
    refreshToken: string;
};
export declare function exchangeApiKey(apiKey: string, baseUrl?: string): Promise<TokenPair>;
export declare function refreshAccessToken(refreshToken: string, baseUrl?: string): Promise<TokenPair>;
/** Clear the apiKey→JWT cache (tests). */
export declare function clearBearerTokenCache(): void;
/**
 * Resolve a Bearer JWT for Cursor API calls. Prefer an already-exchanged
 * `accessToken`; otherwise exchange (and cache) from `apiKey`, refreshing
 * when the cached JWT is near expiry.
 *
 * `apiKey` is only ever a raw exchangeable secret when it has Cursor's
 * `crsr_` prefix. Callers that generically forward whatever credential value
 * they hold — e.g. a host's package-agnostic "aisdk:" SDK loader, which
 * doesn't distinguish our OAuth vs. API-key connection methods and may pass
 * an already-issued JWT through the `apiKey` field — hand us a token that's
 * already good to use as-is; POSTing it to the exchange endpoint 401s.
 */
export declare function resolveBearerToken(input: {
    accessToken?: string;
    apiKey?: string;
    baseUrl?: string;
}): Promise<string>;
export type PkceParams = {
    verifier: string;
    challenge: string;
    uuid: string;
};
export declare function generatePkceParams(): PkceParams;
export declare function generatePkceChallenge(verifier: string): Promise<string>;
export declare function buildLoginUrl(challenge: string, uuid: string, websiteUrl?: string): string;
export declare function pollForTokens(uuid: string, verifier: string, baseUrl?: string, signal?: AbortSignal, maxAttempts?: number): Promise<TokenPair>;
