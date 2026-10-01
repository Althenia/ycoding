import { encodeMessage, getMessageTypes } from "./messages.js";
import { toolsToDescriptors } from "./tools.js";
/**
 * Seed ConversationStateStructure for the first turn (no checkpoint yet).
 *
 * OpenCode needs a system prompt channel; we put it in root_prompt_messages_json
 * as a JSON chat message. After the first checkpoint arrives we stop inventing
 * state and echo the server's opaque structure instead (CLI behavior).
 *
 * Compaction resets also use this seed, with `history` carrying OpenCode's
 * compacted prompt turns so Cursor can summarize without the old checkpoint.
 *
 * We deliberately do NOT use `AgentRunRequest.custom_system_prompt` (#8): that
 * field is the internal `--system-prompt` CLI override and the server rejects
 * it for normal accounts.
 */
export function buildSeedConversationState(input) {
    const root = getMessageTypes();
    const type = root.lookupType("ConversationStateStructure");
    const messages = [];
    if (input?.systemPrompt && input.systemPrompt.length > 0) {
        messages.push(JSON.stringify({ role: "system", content: input.systemPrompt }));
    }
    for (const entry of input?.history ?? []) {
        if (!entry.content)
            continue;
        // Avoid duplicating the system prompt when history also carries one.
        if (entry.role === "system" && input?.systemPrompt)
            continue;
        messages.push(JSON.stringify({ role: entry.role, content: entry.content }));
    }
    const obj = {};
    if (messages.length > 0)
        obj.root_prompt_messages_json = messages;
    return type.encode(type.fromObject(obj)).finish();
}
/**
 * Build an AgentClientMessage{run_request} for a conversation turn.
 *
 * Live `user_message.text` is the current prompt only — same as Cursor CLI.
 * Cross-turn history is the last server checkpoint re-sent as conversation_state.
 */
export function buildRunRequest(input) {
    const msgId = input.messageId ?? crypto.randomUUID();
    // Advertise opencode's tools on the LIVE path: UserMessageAction.request_context
    // (#2). AgentRunRequest.mcp_tools (#4) is prewarm-only / empty on real turns —
    // putting tools only there is why the model fell back to native Grep/Read.
    const tools = input.tools ?? [];
    const mcpTools = input.toolDescriptors ?? (tools.length > 0 ? toolsToDescriptors(tools) : []);
    const requestContext = input.requestContext;
    const userMessage = {
        text: input.text,
        message_id: msgId,
    };
    if (input.images?.length) {
        userMessage.selected_context = {
            selected_images: input.images.map((image) => ({
                data: image.data,
                uuid: crypto.randomUUID(),
                path: image.filename,
                mime_type: image.mimeType,
            })),
        };
    }
    const userMessageAction = { user_message: userMessage };
    if (requestContext)
        userMessageAction.request_context = requestContext;
    const action = input.action === "resume"
        ? { resume_action: {} }
        : { user_message_action: userMessageAction };
    const conversationState = input.conversationState && input.conversationState.length > 0
        ? input.conversationState
        : buildSeedConversationState({
            systemPrompt: input.systemPrompt,
            history: input.history,
        });
    const runRequest = {
        conversation_id: input.conversationId,
        conversation_group_id: input.conversationGroupId ?? input.conversationId,
        run_id: msgId,
        action,
        requested_model: {
            // The provider always selects a concrete model. Cursor's "default"
            // pseudo-model (Auto) is never used here — we send the real id plus the
            // chosen variant's parameter values.
            model_id: input.modelId,
            max_mode: input.maxMode ?? false,
            parameters: input.parameterValues ?? [],
        },
        conversation_state: conversationState,
        // Keep #4 populated too (harmless on real turns; useful for prewarm /
        // older server builds that still read it).
        mcp_tools: { mcp_tools: mcpTools },
        unknown_flag: 0,
        field_12: 0,
    };
    return encodeMessage("AgentClientMessage", {
        run_request: runRequest,
    });
}
/**
 * Build a heartbeat message.
 */
export function buildHeartbeat() {
    return encodeMessage("AgentClientMessage", {
        client_heartbeat: {},
    });
}
