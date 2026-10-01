export declare const MAX_CURSOR_IMAGE_INPUT_BYTES: number;
export type CursorImageInput = {
    data: Uint8Array;
    filename: string;
    mimeType: string;
};
export type CursorHistoryImageExtraction = {
    images: CursorImageInput[];
    hashes: string[];
    candidateCount: number;
    duplicateCount: number;
};
export type CursorPromptImageExtraction = CursorHistoryImageExtraction & {
    userImageCount: number;
};
export declare function hasCursorUserImages(lastUser: Record<string, unknown> | undefined): boolean;
export declare function assertCursorUserImageSupport(lastUser: Record<string, unknown> | undefined, supportsImages: boolean, modelId: string): void;
export declare function extractCursorUserImages(lastUser: Record<string, unknown> | undefined, signal?: AbortSignal, maxBytes?: number): Promise<CursorImageInput[]>;
export declare function extractCursorHistoryImages(prompt: readonly unknown[], options: {
    supportsImages: boolean;
    seenHashes?: ReadonlySet<string>;
    signal?: AbortSignal;
    maxBytes?: number;
    filenameOffset?: number;
}): Promise<CursorHistoryImageExtraction>;
export declare function extractCursorPromptImages(prompt: readonly unknown[], lastUser: Record<string, unknown> | undefined, options: {
    supportsImages: boolean;
    seenHistoryHashes?: ReadonlySet<string>;
    signal?: AbortSignal;
    maxBytes?: number;
}): Promise<CursorPromptImageExtraction>;
