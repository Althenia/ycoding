export const enumLabels: Readonly<Record<string, Readonly<Record<number, string>>>> = {
  "ycoding.v5.Permission_Effect": {
    "1": "allow",
    "2": "deny",
    "3": "ask",
  },
  "ycoding.v5.UnauthorizedError__tag": {
    "1": "UnauthorizedError",
  },
  "ycoding.v5.InvalidRequestError__tag": {
    "1": "InvalidRequestError",
  },
  "ycoding.v5.ConflictError__tag": {
    "1": "ConflictError",
  },
  "ycoding.v5.ServiceUnavailableError__tag": {
    "1": "ServiceUnavailableError",
  },
  "ycoding.v5.InvalidCursorError__tag": {
    "1": "InvalidCursorError",
  },
  "ycoding.v5.ProviderRequest_Summary_latestInvalidation": {
    "1": "first-request",
    "2": "compaction-reset",
    "3": "model-switched",
    "4": "model-variant-switched",
    "5": "stable-hit",
    "6": "prefix-changed",
    "7": "system-prefix-changed",
    "8": "tool-prefix-changed",
    "9": "below-minimum",
    "10": "provider-not-reported",
    "11": "cache-disabled",
    "12": "retry-fallback",
  },
  "ycoding.v5.ProviderRequest_ModelSpend_costProvenance": {
    "1": "recorded",
    "2": "current_catalog",
  },
  "ycoding.v5.ProviderRequest_Report_group": {
    "1": "model",
    "2": "hour",
    "3": "day",
    "4": "month",
    "5": "session",
    "6": "project",
    "7": "agent",
    "8": "provider",
    "9": "provider-profile-model",
    "10": "provider-model",
    "11": "model-id",
    "12": "profile",
    "13": "prompt",
    "14": "task",
  },
  "ycoding.v5.ProviderRequest_ReportRow_costProvenance": {
    "1": "recorded",
    "2": "current_catalog",
  },
  "ycoding.v5.ProviderRequest_ReportDimensionsValue1_group": {
    "1": "provider",
  },
  "ycoding.v5.ProviderRequest_ReportDimensionsValue2_group": {
    "1": "provider-profile-model",
  },
  "ycoding.v5.ProviderRequest_ReportDimensionsValue2_profileState": {
    "1": "recorded",
    "2": "provider-default",
  },
  "ycoding.v5.ProviderRequest_ReportDimensionsValue3_group": {
    "1": "provider-model",
  },
  "ycoding.v5.ProviderRequest_ReportDimensionsValue4_group": {
    "1": "model-id",
  },
  "ycoding.v5.ProviderRequest_ReportDimensionsValue5_group": {
    "1": "profile",
  },
  "ycoding.v5.ProviderRequest_ReportDimensionsValue5_profileState": {
    "1": "recorded",
    "2": "provider-default",
  },
  "ycoding.v5.ProviderRequest_ReportDimensionsValue6_group": {
    "1": "prompt",
  },
  "ycoding.v5.ProviderRequest_ReportDimensionsValue6_attribution": {
    "1": "complete",
    "2": "partial",
    "3": "unattributed",
  },
  "ycoding.v5.ProviderRequest_ReportDimensionsValue7_group": {
    "1": "task",
  },
  "ycoding.v5.ProviderRequest_ReportDimensionsValue7_attribution": {
    "1": "complete",
    "2": "partial",
    "3": "unattributed",
  },
  "ycoding.v5.ProviderRequest_ReportMetrics_costProvenance": {
    "1": "recorded",
    "2": "current_catalog",
  },
  "ycoding.v5.SessionUsageReportQuery_group": {
    "1": "model",
    "2": "hour",
    "3": "day",
    "4": "month",
    "5": "session",
    "6": "project",
    "7": "agent",
    "8": "provider",
    "9": "provider-profile-model",
    "10": "provider-model",
    "11": "model-id",
    "12": "profile",
    "13": "prompt",
    "14": "task",
  },
  "ycoding.v5.SessionUsageReportQuery_sort": {
    "1": "key",
    "2": "tokens",
    "3": "cost",
    "4": "steps",
    "5": "input",
    "6": "output",
    "7": "reasoning",
    "8": "cacheRead",
    "9": "cacheWrite",
  },
  "ycoding.v5.SessionUsageReportQuery_order": {
    "1": "asc",
    "2": "desc",
  },
  "ycoding.v5.SessionNotFoundError__tag": {
    "1": "SessionNotFoundError",
  },
  "ycoding.v5.ForbiddenError__tag": {
    "1": "ForbiddenError",
  },
  "ycoding.v5.Pty_status": {
    "1": "running",
    "2": "exited",
  },
  "ycoding.v5.Pty_exitReason": {
    "1": "exit",
    "2": "timeout",
    "3": "terminated",
  },
  "ycoding.v5.Pty_control_owner": {
    "1": "agent",
    "2": "user",
    "3": "paused",
  },
  "ycoding.v5.Shell_Info_status": {
    "1": "running",
    "2": "exited",
    "3": "timeout",
    "4": "memory-limit",
    "5": "killed",
  },
  "ycoding.v5.FileDiff_Info_status": {
    "1": "added",
    "2": "deleted",
    "3": "modified",
  },
  "ycoding.v5.Decision_Item_kind": {
    "1": "permission",
    "2": "guardrail",
    "3": "question",
    "4": "form",
    "5": "review",
  },
  "ycoding.v5.Form_StringField_type": {
    "1": "string",
  },
  "ycoding.v5.Form_StringField_format": {
    "1": "email",
    "2": "uri",
    "3": "date",
    "4": "date-time",
  },
  "ycoding.v5.Form_When_op": {
    "1": "eq",
    "2": "neq",
  },
  "ycoding.v5.Form_NumberField_type": {
    "1": "number",
  },
  "ycoding.v5.Form_IntegerField_type": {
    "1": "integer",
  },
  "ycoding.v5.Form_BooleanField_type": {
    "1": "boolean",
  },
  "ycoding.v5.Form_MultiselectField_type": {
    "1": "multiselect",
  },
  "ycoding.v5.Form_ExternalField_type": {
    "1": "external",
  },
  "ycoding.v5.SessionReview_FormPayload_type": {
    "1": "form",
  },
  "ycoding.v5.SessionReview_QuestionPayload_type": {
    "1": "question",
  },
  "ycoding.v5.SessionReview_SubagentQuestionPayload_type": {
    "1": "subagent_question",
  },
  "ycoding.v5.SessionReview_GuardrailPayload_type": {
    "1": "guardrail",
  },
  "ycoding.v5.SessionReview_PermissionPayload_type": {
    "1": "permission",
  },
  "ycoding.v5.SessionReview_RecoveryPayload_type": {
    "1": "recovery",
  },
  "ycoding.v5.Form_Assessment_mode": {
    "1": "manual",
    "2": "auto",
    "3": "yolo",
  },
  "ycoding.v5.Form_FieldAssessment_status": {
    "1": "pending",
    "2": "assessed",
    "3": "unavailable",
    "4": "not_assessed",
  },
  "ycoding.v5.Permission_Source_type": {
    "1": "tool",
  },
  "ycoding.v5.Guardrail_Authority": {
    "1": "baseline",
    "2": "yolo",
  },
  "ycoding.v5.Guardrail_EscalationReason": {
    "1": "unavailable",
    "2": "invalid-request",
    "3": "provider-failed",
    "4": "timeout",
    "5": "input-too-large",
    "6": "invalid-output",
    "7": "refused",
    "8": "truncated-output",
    "9": "unsupported-output",
    "10": "escalated",
    "11": "low_confidence",
    "12": "conflicting_grades",
  },
  "ycoding.v5.Guardrail_DecisionChoice": {
    "1": "approve_all",
    "2": "approve",
    "3": "reject",
    "4": "escalate",
    "5": "allow",
    "6": "deny",
  },
  "ycoding.v5.SessionActive_type": {
    "1": "running",
  },
  "ycoding.v5.AttachmentNotFoundError__tag": {
    "1": "AttachmentNotFoundError",
  },
  "ycoding.v5.AttachmentTooLargeError__tag": {
    "1": "AttachmentTooLargeError",
  },
  "ycoding.v5.SessionAutonomyMode": {
    "1": "normal",
  },
  "ycoding.v5.SessionAutonomy_DecisionMode": {
    "1": "manual",
    "2": "yolo",
    "3": "auto",
  },
  "ycoding.v5.SessionAutonomyGoalStatus": {
    "1": "active",
    "2": "completed",
    "3": "stopped",
    "4": "exhausted",
  },
  "ycoding.v5.SessionAutonomyGoalPhase": {
    "1": "active",
    "2": "waiting",
    "3": "rework",
    "4": "stalled",
  },
  "ycoding.v5.SessionAutonomyGoal_wait": {
    "1": "child",
    "2": "shell",
    "3": "review",
  },
  "ycoding.v5.UnknownError__tag": {
    "1": "UnknownError",
  },
  "ycoding.v5.SessionCapturedChanges_Input_type": {
    "1": "user",
    "2": "synthetic",
    "3": "assistant",
  },
  "ycoding.v5.SessionCapturedChanges_Input_contentItem_type": {
    "1": "tool",
  },
  "ycoding.v5.session_command_Request_payload_delivery": {
    "1": "steer",
    "2": "queue",
  },
  "ycoding.v5.SessionPending_User_type": {
    "1": "user",
  },
  "ycoding.v5.SessionPending_User_delivery": {
    "1": "steer",
    "2": "queue",
  },
  "ycoding.v5.Prompt_ManagedAttachmentContent_type": {
    "1": "managed",
  },
  "ycoding.v5.CommandNotFoundError__tag": {
    "1": "CommandNotFoundError",
  },
  "ycoding.v5.CommandEvaluationError__tag": {
    "1": "CommandEvaluationError",
  },
  "ycoding.v5.SessionCompaction_Result_trigger": {
    "1": "consider",
    "2": "advised",
    "3": "mandatory",
    "4": "manual",
  },
  "ycoding.v5.SessionCompaction_Result_status": {
    "1": "ended",
    "2": "failed",
  },
  "ycoding.v5.SessionCompaction_Result_failure": {
    "1": "cancelled",
    "2": "superseded",
    "3": "invalid_manifest",
    "4": "protected_state_changed",
    "5": "context_limit_unresolved",
    "6": "migration_failed",
    "7": "provider_failed",
  },
  "ycoding.v5.SessionCompaction_HistoryJob_trigger": {
    "1": "consider",
    "2": "advised",
    "3": "mandatory",
    "4": "manual",
  },
  "ycoding.v5.SessionCompaction_HistoryJob_status": {
    "1": "pending",
    "2": "running",
    "3": "completed",
    "4": "failed",
  },
  "ycoding.v5.SessionCompaction_HistoryJob_code": {
    "1": "cancelled",
    "2": "superseded",
    "3": "invalid_manifest",
    "4": "protected_state_changed",
    "5": "context_limit_unresolved",
    "6": "migration_failed",
    "7": "provider_failed",
  },
  "ycoding.v5.Session_Message_AgentSelected_type": {
    "1": "agent-switched",
  },
  "ycoding.v5.Session_Message_ModelSelected_type": {
    "1": "model-switched",
  },
  "ycoding.v5.Session_Message_User_type": {
    "1": "user",
  },
  "ycoding.v5.Session_Message_Synthetic_type": {
    "1": "synthetic",
  },
  "ycoding.v5.Session_Message_System_type": {
    "1": "system",
  },
  "ycoding.v5.Session_Message_Skill_type": {
    "1": "skill",
  },
  "ycoding.v5.Session_Message_SkillDeactivation_reason": {
    "1": "conflict_resolved",
  },
  "ycoding.v5.Session_Message_Shell_type": {
    "1": "shell",
  },
  "ycoding.v5.Session_Message_Shell_status": {
    "1": "running",
    "2": "exited",
    "3": "timeout",
    "4": "memory-limit",
    "5": "killed",
  },
  "ycoding.v5.Session_Message_Assistant_type": {
    "1": "assistant",
  },
  "ycoding.v5.Session_Message_Assistant_finish": {
    "1": "stop",
    "2": "length",
    "3": "tool-calls",
    "4": "content-filter",
    "5": "error",
    "6": "unknown",
  },
  "ycoding.v5.Session_Message_Assistant_Text_type": {
    "1": "text",
  },
  "ycoding.v5.Session_Message_Assistant_Text_phase": {
    "1": "commentary",
    "2": "final_answer",
  },
  "ycoding.v5.Session_Message_Assistant_Reasoning_type": {
    "1": "reasoning",
  },
  "ycoding.v5.Session_Message_Assistant_Tool_type": {
    "1": "tool",
  },
  "ycoding.v5.Session_Message_ToolState_Streaming_status": {
    "1": "streaming",
  },
  "ycoding.v5.Session_Message_ToolState_Running_status": {
    "1": "running",
  },
  "ycoding.v5.Tool_TextContent_type": {
    "1": "text",
  },
  "ycoding.v5.Tool_FileContent_type": {
    "1": "file",
  },
  "ycoding.v5.Session_Message_ToolState_Completed_status": {
    "1": "completed",
  },
  "ycoding.v5.Session_Message_ToolState_Error_status": {
    "1": "error",
  },
  "ycoding.v5.Session_CacheMechanism": {
    "1": "openai-prefix-cache",
    "2": "openrouter-cache-control",
    "3": "anthropic-cache-control",
    "4": "bedrock-cache-point",
    "5": "gemini-prefix-cache",
    "6": "provider-reported",
    "7": "none",
  },
  "ycoding.v5.Session_Message_Compaction_Pending_type": {
    "1": "compaction",
  },
  "ycoding.v5.Session_Message_Compaction_Pending_trigger": {
    "1": "consider",
    "2": "advised",
    "3": "mandatory",
    "4": "manual",
  },
  "ycoding.v5.Session_Message_Compaction_Pending_status": {
    "1": "pending",
  },
  "ycoding.v5.Session_Message_Compaction_RunningV1_type": {
    "1": "compaction",
  },
  "ycoding.v5.Session_Message_Compaction_RunningV1_reason": {
    "1": "auto",
    "2": "manual",
  },
  "ycoding.v5.Session_Message_Compaction_RunningV1_status": {
    "1": "running",
  },
  "ycoding.v5.Session_Message_Compaction_Running_type": {
    "1": "compaction",
  },
  "ycoding.v5.Session_Message_Compaction_Running_trigger": {
    "1": "consider",
    "2": "advised",
    "3": "mandatory",
    "4": "manual",
  },
  "ycoding.v5.Session_Message_Compaction_Running_status": {
    "1": "running",
  },
  "ycoding.v5.Session_Message_Compaction_CompletedV1_type": {
    "1": "compaction",
  },
  "ycoding.v5.Session_Message_Compaction_CompletedV1_reason": {
    "1": "auto",
    "2": "manual",
  },
  "ycoding.v5.Session_Message_Compaction_CompletedV1_status": {
    "1": "completed",
  },
  "ycoding.v5.Session_Message_Compaction_Completed_type": {
    "1": "compaction",
  },
  "ycoding.v5.Session_Message_Compaction_Completed_trigger": {
    "1": "consider",
    "2": "advised",
    "3": "mandatory",
    "4": "manual",
  },
  "ycoding.v5.Session_Message_Compaction_Completed_status": {
    "1": "completed",
  },
  "ycoding.v5.Session_Message_Compaction_FailedV1_type": {
    "1": "compaction",
  },
  "ycoding.v5.Session_Message_Compaction_FailedV1_reason": {
    "1": "auto",
    "2": "manual",
  },
  "ycoding.v5.Session_Message_Compaction_FailedV1_status": {
    "1": "failed",
  },
  "ycoding.v5.Session_Message_Compaction_Failed_type": {
    "1": "compaction",
  },
  "ycoding.v5.Session_Message_Compaction_Failed_trigger": {
    "1": "consider",
    "2": "advised",
    "3": "mandatory",
    "4": "manual",
  },
  "ycoding.v5.Session_Message_Compaction_Failed_status": {
    "1": "failed",
  },
  "ycoding.v5.Session_Message_Compaction_Failed_code": {
    "1": "cancelled",
    "2": "superseded",
    "3": "invalid_manifest",
    "4": "protected_state_changed",
    "5": "context_limit_unresolved",
    "6": "migration_failed",
    "7": "provider_failed",
  },
  "ycoding.v5.session_create_Request_payload_scope": {
    "1": "bound",
    "2": "standalone",
  },
  "ycoding.v5.Session_Info_scope": {
    "1": "bound",
    "2": "standalone",
  },
  "ycoding.v5.Model_Daybreak": {
    "1": "daybreak_blue",
    "2": "daybreak_red",
  },
  "ycoding.v5.Session_Origin": {
    "1": "dots-executor",
  },
  "ycoding.v5.MessageNotFoundError__tag": {
    "1": "MessageNotFoundError",
  },
  "ycoding.v5.MessageDeleteRefusedError__tag": {
    "1": "MessageDeleteRefusedError",
  },
  "ycoding.v5.MessageDeleteRefusedError_reason": {
    "1": "read",
    "2": "not_owned",
  },
  "ycoding.v5.Session_GenerationSpeedHistory_live_phase": {
    "1": "preparing",
    "2": "waiting",
    "3": "reasoning",
    "4": "streaming",
    "5": "tool",
    "6": "completed",
    "7": "failed",
    "8": "cancelled",
  },
  "ycoding.v5.HistoryPrunedError__tag": {
    "1": "HistoryPrunedError",
  },
  "ycoding.v5.FormAlreadySettledError__tag": {
    "1": "FormAlreadySettledError",
  },
  "ycoding.v5.FormNotFoundError__tag": {
    "1": "FormNotFoundError",
  },
  "ycoding.v5.FormInvalidAnswerError__tag": {
    "1": "FormInvalidAnswerError",
  },
  "ycoding.v5.Form_StateValue1_status": {
    "1": "pending",
  },
  "ycoding.v5.Form_StateValue2_status": {
    "1": "answered",
  },
  "ycoding.v5.Form_StateValue3_status": {
    "1": "cancelled",
  },
  "ycoding.v5.Form_StateValue4_status": {
    "1": "timed_out",
  },
  "ycoding.v5.Form_StateValue5_status": {
    "1": "deferred",
  },
  "ycoding.v5.GuardrailRequestNotFoundError__tag": {
    "1": "GuardrailRequestNotFoundError",
  },
  "ycoding.v5.Guardrail_Risk_metric": {
    "1": "confidence",
    "2": "probability",
  },
  "ycoding.v5.Guardrail_Reply": {
    "1": "once",
    "2": "always",
    "3": "reject",
  },
  "ycoding.v5.Guardrail_Counter_scope": {
    "1": "session",
    "2": "family",
  },
  "ycoding.v5.Guardrail_ClosedReason": {
    "1": "cancelled",
    "2": "expired",
  },
  "ycoding.v5.InstructionEntryValueTooLargeError__tag": {
    "1": "InstructionEntryValueTooLargeError",
  },
  "ycoding.v5.Interaction_PreviewValue1_state": {
    "1": "unavailable",
  },
  "ycoding.v5.Interaction_PreviewValue2_state": {
    "1": "ready",
  },
  "ycoding.v5.Interaction_Frame_mimeType": {
    "1": "image/png",
    "2": "image/jpeg",
  },
  "ycoding.v5.Interaction_RequestValue1_platform": {
    "1": "macos",
  },
  "ycoding.v5.Interaction_RequestValue2_platform": {
    "1": "chrome",
  },
  "ycoding.v5.Interaction_RequestValue2_mode": {
    "1": "tab",
  },
  "ycoding.v5.Interaction_RequestValue3_platform": {
    "1": "chrome",
  },
  "ycoding.v5.Interaction_RequestValue3_mode": {
    "1": "owned",
    "2": "isolated",
  },
  "ycoding.v5.Interaction_StatusValue1_state": {
    "1": "unavailable",
  },
  "ycoding.v5.Interaction_StatusValue2_state": {
    "1": "pending",
  },
  "ycoding.v5.Interaction_Platform": {
    "1": "chrome",
    "2": "macos",
  },
  "ycoding.v5.Interaction_StatusValue3_state": {
    "1": "active",
  },
  "ycoding.v5.Interaction_StatusValue4_state": {
    "1": "paused",
  },
  "ycoding.v5.Interaction_PauseReason": {
    "1": "foreground_required",
    "2": "file_chooser",
    "3": "dialog",
    "4": "captcha",
    "5": "sensitive",
    "6": "user_takeover",
  },
  "ycoding.v5.Interaction_StatusValue5_state": {
    "1": "stopped",
  },
  "ycoding.v5.Interaction_StopReason": {
    "1": "stopped",
    "2": "rejected",
    "3": "expired",
    "4": "disconnected",
    "5": "target_lost",
    "6": "uncertain",
    "7": "permission",
    "8": "shutdown",
  },
  "ycoding.v5.Interaction_StatusValue5_cleanup": {
    "1": "pending",
    "2": "complete",
    "3": "failed",
  },
  "ycoding.v5.SessionsQuery_order": {
    "1": "asc",
    "2": "desc",
    "3": "pinned",
    "4": "active",
  },
  "ycoding.v5.SessionsQuery_status": {
    "1": "running",
    "2": "idle",
    "3": "waiting",
  },
  "ycoding.v5.SessionsQuery_searchFields": {
    "1": "summary",
  },
  "ycoding.v5.SessionsQuery_background": {
    "1": "include",
    "2": "exclude",
  },
  "ycoding.v5.SessionPending_Synthetic_type": {
    "1": "synthetic",
  },
  "ycoding.v5.SessionPending_Synthetic_delivery": {
    "1": "steer",
    "2": "queue",
  },
  "ycoding.v5.PendingInputNotFoundError__tag": {
    "1": "PendingInputNotFoundError",
  },
  "ycoding.v5.PermissionNotFoundError__tag": {
    "1": "PermissionNotFoundError",
  },
  "ycoding.v5.Permission_Reply": {
    "1": "once",
    "2": "always",
    "3": "reject",
  },
  "ycoding.v5.session_prediction_Request_payload_memoryItem": {
    "1": "repository",
    "2": "knowledge",
  },
  "ycoding.v5.SessionPredictionResponse_dataValue1_status": {
    "1": "suggested",
  },
  "ycoding.v5.SessionPredictionResponse_dataValue2_status": {
    "1": "unavailable",
  },
  "ycoding.v5.session_prompt_Request_payload_delivery": {
    "1": "steer",
    "2": "queue",
  },
  "ycoding.v5.UsageAccounting_PromptCosts_history": {
    "1": "retained",
    "2": "partial",
  },
  "ycoding.v5.UsageAccounting_PromptCost_status": {
    "1": "settled",
    "2": "so-far",
  },
  "ycoding.v5.UsageAccounting_PromptCost_attribution": {
    "1": "complete",
    "2": "partial",
    "3": "unattributed",
  },
  "ycoding.v5.UsageAccounting_PromptCost_history": {
    "1": "retained",
    "2": "partial",
  },
  "ycoding.v5.UsageAccounting_Cost_provenance": {
    "1": "recorded",
    "2": "current_catalog",
  },
  "ycoding.v5.UsageAccounting_Helper_source": {
    "1": "step",
    "2": "title",
    "3": "goal",
    "4": "compaction",
    "5": "decision",
    "6": "prediction",
    "7": "prompt",
  },
  "ycoding.v5.session_promptGenerate_Request_payload_mode": {
    "1": "start",
    "2": "steer",
    "3": "queue",
    "4": "goal",
  },
  "ycoding.v5.session_promptGenerate_Request_payload_memoryItem": {
    "1": "repository",
    "2": "knowledge",
  },
  "ycoding.v5.SessionPromptGenerateResponse_dataValue1_status": {
    "1": "generated",
  },
  "ycoding.v5.SessionPromptGenerateResponse_dataValue2_status": {
    "1": "unavailable",
  },
  "ycoding.v5.QuestionNotFoundError__tag": {
    "1": "QuestionNotFoundError",
  },
  "ycoding.v5.SkillConflictNotFoundError__tag": {
    "1": "SkillConflictNotFoundError",
  },
  "ycoding.v5.SessionBusyError__tag": {
    "1": "SessionBusyError",
  },
  "ycoding.v5.SessionReview_DecisionValue1_kind": {
    "1": "question",
  },
  "ycoding.v5.SessionReview_DecisionValue2_kind": {
    "1": "subagent_question",
  },
  "ycoding.v5.SessionReview_DecisionValue3_kind": {
    "1": "guardrail",
  },
  "ycoding.v5.SessionReview_DecisionValue4_kind": {
    "1": "permission",
  },
  "ycoding.v5.SessionReview_DecisionValue5_kind": {
    "1": "recovery",
  },
  "ycoding.v5.SessionReview_DecisionValue5_choice": {
    "1": "continue",
    "2": "stop",
  },
  "ycoding.v5.SessionReview_DecisionValue6_kind": {
    "1": "question",
    "2": "subagent_question",
  },
  "ycoding.v5.ReviewItemNotFoundError__tag": {
    "1": "ReviewItemNotFoundError",
  },
  "ycoding.v5.SessionReview_ItemValue1_kind": {
    "1": "question",
  },
  "ycoding.v5.SessionReview_Reason": {
    "1": "disabled",
    "2": "free_text",
    "3": "refused",
    "4": "low_confidence",
    "5": "escalated",
    "6": "error",
    "7": "timeout",
    "8": "sleep_entry",
    "9": "restart",
    "10": "unavailable",
    "11": "invalid-request",
    "12": "provider-failed",
    "13": "input-too-large",
    "14": "invalid-output",
    "15": "truncated-output",
    "16": "unsupported-output",
    "17": "conflicting_grades",
    "18": "defer_entry",
  },
  "ycoding.v5.SessionReview_ItemValue2_kind": {
    "1": "subagent_question",
  },
  "ycoding.v5.SessionReview_ItemValue3_kind": {
    "1": "guardrail",
  },
  "ycoding.v5.SessionReview_ItemValue4_kind": {
    "1": "permission",
  },
  "ycoding.v5.SessionReview_ItemValue5_kind": {
    "1": "recovery",
  },
  "ycoding.v5.SkillNotFoundError__tag": {
    "1": "SkillNotFoundError",
  },
  "ycoding.v5.session_skills_Result_dataItemValue1_activatedBy": {
    "1": "reference",
    "2": "tool",
  },
  "ycoding.v5.session_skills_Result_dataItemValue1_state": {
    "1": "active",
  },
  "ycoding.v5.session_skills_Result_dataItemValue1_conflictsItem_type": {
    "1": "skill",
    "2": "instruction",
  },
  "ycoding.v5.session_skills_Result_dataItemValue2_activatedBy": {
    "1": "reference",
    "2": "tool",
  },
  "ycoding.v5.session_skills_Result_dataItemValue2_state": {
    "1": "inactive",
  },
  "ycoding.v5.session_skills_Result_dataItemValue2_inactiveReason": {
    "1": "agent_switched",
    "2": "compacted",
    "3": "conflict_resolved",
  },
  "ycoding.v5.session_skills_Result_dataItemValue2_conflictsItem_type": {
    "1": "skill",
    "2": "instruction",
  },
  "ycoding.v5.EventLog_Synced_type": {
    "1": "log.synced",
  },
  "ycoding.v5.SessionOrchestration_Task_state": {
    "1": "starting",
    "2": "running",
    "3": "waiting",
    "4": "cancelling",
    "5": "cancelled",
    "6": "completed",
    "7": "failed",
    "8": "lost",
    "9": "supervising",
  },
  "ycoding.v5.SessionSubagentMessage_delivery": {
    "1": "steer",
    "2": "queue",
  },
  "ycoding.v5.ModelSwitchBlockedError__tag": {
    "1": "ModelSwitchBlockedError",
  },
  "ycoding.v5.ModelSwitchBlockedError_status": {
    "1": "blocked",
  },
  "ycoding.v5.ModelSwitchBlockedError_reason": {
    "1": "context-window-exceeded",
  },
  "ycoding.v5.session_synthetic_Request_payload_delivery": {
    "1": "steer",
    "2": "queue",
  },
  "ycoding.v5.UsageAccounting_TaskCosts_history": {
    "1": "retained",
    "2": "partial",
  },
  "ycoding.v5.UsageAccounting_TaskCost_status": {
    "1": "settled",
    "2": "so-far",
  },
  "ycoding.v5.UsageAccounting_TaskCost_attribution": {
    "1": "complete",
    "2": "partial",
    "3": "unattributed",
  },
  "ycoding.v5.UsageAccounting_TaskCost_history": {
    "1": "retained",
    "2": "partial",
  },
  "ycoding.v5.SessionTodo_Info_status": {
    "1": "pending",
    "2": "in_progress",
    "3": "completed",
    "4": "cancelled",
  },
  "ycoding.v5.SessionTodo_Info_priority": {
    "1": "high",
    "2": "medium",
    "3": "low",
  },
  "ycoding.v5.SessionLogItemValue1_type": {
    "1": "session.created",
  },
  "ycoding.v5.SessionLogItemValue1_data_scope": {
    "1": "bound",
    "2": "standalone",
  },
  "ycoding.v5.SessionLogItemValue67_type": {
    "1": "session.dots.access.changed",
  },
  "ycoding.v5.SessionLogItemValue2_type": {
    "1": "session.agent.selected",
  },
  "ycoding.v5.SessionLogItemValue3_type": {
    "1": "session.model.selected",
  },
  "ycoding.v5.SessionLogItemValue4_type": {
    "1": "session.daybreak.set",
  },
  "ycoding.v5.SessionLogItemValue53_type": {
    "1": "session.guardrail.dismissed",
  },
  "ycoding.v5.SessionLogItemValue54_type": {
    "1": "session.guardrail.escalated",
  },
  "ycoding.v5.SessionLogItemValue55_type": {
    "1": "session.guardrail.decided",
  },
  "ycoding.v5.SessionLogItemValue55_data_actor": {
    "1": "coordinator",
  },
  "ycoding.v5.SessionLogItemValue61_type": {
    "1": "session.decision.audited",
  },
  "ycoding.v5.SessionLogItemValue61_data_purpose": {
    "1": "permission",
    "2": "guardrail",
    "3": "answer",
    "4": "advisory",
  },
  "ycoding.v5.SessionLogItemValue61_data_outcome": {
    "1": "succeeded",
    "2": "failed",
    "3": "cancelled",
  },
  "ycoding.v5.DecisionFailure_Reason": {
    "1": "unavailable",
    "2": "invalid-request",
    "3": "provider-failed",
    "4": "timeout",
    "5": "input-too-large",
    "6": "invalid-output",
    "7": "refused",
    "8": "truncated-output",
    "9": "unsupported-output",
  },
  "ycoding.v5.SessionLogItemValue61_data_answersItem_type": {
    "1": "predicate",
    "2": "choice",
    "3": "score",
    "4": "text",
    "5": "refusal",
  },
  "ycoding.v5.SessionLogItemValue62_type": {
    "1": "session.permission.assessed",
  },
  "ycoding.v5.SessionLogItemValue62_data_outcome": {
    "1": "allow",
    "2": "deny",
    "3": "escalate",
  },
  "ycoding.v5.SessionLogItemValue62_data_via": {
    "1": "auto-permission",
    "2": "baseline",
    "3": "yolo",
    "4": "coordination",
  },
  "ycoding.v5.SessionLogItemValue62_data_actor": {
    "1": "coordinator",
  },
  "ycoding.v5.SessionLogItemValue56_type": {
    "1": "session.review.deferred",
  },
  "ycoding.v5.SessionReview_Kind": {
    "1": "question",
    "2": "subagent_question",
    "3": "guardrail",
    "4": "permission",
    "5": "recovery",
  },
  "ycoding.v5.SessionLogItemValue57_type": {
    "1": "session.review.decided",
  },
  "ycoding.v5.Form_DotsClientReplySource_kind": {
    "1": "dots-client",
  },
  "ycoding.v5.Form_NativeReplySource_kind": {
    "1": "dots-native",
  },
  "ycoding.v5.SessionLogItemValue58_type": {
    "1": "session.review.withdrawn",
  },
  "ycoding.v5.SessionLogItemValue58_data_reason": {
    "1": "reverted",
    "2": "task_closed",
    "3": "autonomy",
  },
  "ycoding.v5.SessionLogItemValue59_type": {
    "1": "session.review.consumed",
  },
  "ycoding.v5.SessionLogItemValue6_type": {
    "1": "session.moved",
  },
  "ycoding.v5.SessionLogItemValue7_type": {
    "1": "session.renamed",
  },
  "ycoding.v5.SessionLogItemValue8_type": {
    "1": "session.deleted",
  },
  "ycoding.v5.SessionLogItemValue9_type": {
    "1": "session.archived",
  },
  "ycoding.v5.SessionLogItemValue10_type": {
    "1": "session.unarchived",
  },
  "ycoding.v5.SessionLogItemValue11_type": {
    "1": "session.pinned",
  },
  "ycoding.v5.SessionLogItemValue12_type": {
    "1": "session.unpinned",
  },
  "ycoding.v5.SessionLogItemValue13_type": {
    "1": "session.forked",
  },
  "ycoding.v5.SessionLogItemValue14_type": {
    "1": "session.input.promoted",
  },
  "ycoding.v5.SessionLogItemValue15_type": {
    "1": "session.input.admitted",
  },
  "ycoding.v5.SessionPending_UserMessage_type": {
    "1": "user",
  },
  "ycoding.v5.SessionPending_UserMessage_delivery": {
    "1": "steer",
    "2": "queue",
  },
  "ycoding.v5.SessionPending_SyntheticMessage_type": {
    "1": "synthetic",
  },
  "ycoding.v5.SessionPending_SyntheticMessage_delivery": {
    "1": "steer",
    "2": "queue",
  },
  "ycoding.v5.SessionLogItemValue73_type": {
    "1": "session.input.withdrawn",
  },
  "ycoding.v5.SessionLogItemValue74_type": {
    "1": "session.input.steered",
  },
  "ycoding.v5.SessionLogItemValue16_type": {
    "1": "session.input.consumed",
  },
  "ycoding.v5.SessionLogItemValue75_type": {
    "1": "session.input.deleted",
  },
  "ycoding.v5.SessionLogItemValue63_type": {
    "1": "session.dots.exchange.created",
  },
  "ycoding.v5.Dots_RoutineInstructionValue1_operation": {
    "1": "continue",
  },
  "ycoding.v5.Dots_RoutineInstructionValue2_operation": {
    "1": "presentation",
  },
  "ycoding.v5.Dots_RoutineInstructionValue2_preferences_format": {
    "1": "prose",
    "2": "bullets",
  },
  "ycoding.v5.Dots_RoutineInstructionValue2_preferences_detail": {
    "1": "concise",
    "2": "standard",
    "3": "detailed",
  },
  "ycoding.v5.Dots_DelegatedInstructionValue1_operation": {
    "1": "task",
  },
  "ycoding.v5.Dots_DelegatedInstructionValue2_operation": {
    "1": "decision",
  },
  "ycoding.v5.Dots_DelegatedInstructionValue2_reply": {
    "1": "once",
    "2": "reject",
  },
  "ycoding.v5.Dots_DelegatedInstructionValue2_target_kind": {
    "1": "permission",
  },
  "ycoding.v5.Dots_DelegatedInstructionValue3_operation": {
    "1": "decision",
  },
  "ycoding.v5.Dots_DelegatedInstructionValue3_reply": {
    "1": "once",
    "2": "reject",
  },
  "ycoding.v5.Dots_DelegatedInstructionValue3_target_kind": {
    "1": "guardrail",
  },
  "ycoding.v5.Dots_DelegatedInstructionValue4_operation": {
    "1": "decision",
  },
  "ycoding.v5.Dots_DelegatedInstructionValue4_target_kind": {
    "1": "form",
  },
  "ycoding.v5.Dots_DelegatedInstructionValue5_operation": {
    "1": "decision",
  },
  "ycoding.v5.Dots_DelegatedInstructionValue5_target_kind": {
    "1": "question",
  },
  "ycoding.v5.Dots_DelegatedInstructionValue6_operation": {
    "1": "decision",
  },
  "ycoding.v5.Dots_DelegatedInstructionValue6_target_kind": {
    "1": "form",
  },
  "ycoding.v5.Dots_DelegatedInstructionValue7_operation": {
    "1": "decision",
  },
  "ycoding.v5.Dots_DelegatedInstructionValue7_target_kind": {
    "1": "question",
  },
  "ycoding.v5.Dots_DelegatedInstructionValue8_operation": {
    "1": "decision",
  },
  "ycoding.v5.Dots_DelegatedInstructionValue8_target_kind": {
    "1": "subagent_question",
  },
  "ycoding.v5.Dots_DelegatedInstructionValue9_operation": {
    "1": "decision",
  },
  "ycoding.v5.Dots_DelegatedInstructionValue9_target_kind": {
    "1": "subagent_question",
  },
  "ycoding.v5.Dots_DelegatedInstructionValue10_operation": {
    "1": "decision",
  },
  "ycoding.v5.Dots_DelegatedInstructionValue10_target_kind": {
    "1": "review",
  },
  "ycoding.v5.Dots_ReviewDecisionValue1_kind": {
    "1": "question",
  },
  "ycoding.v5.Dots_ReviewDecisionValue2_kind": {
    "1": "subagent_question",
  },
  "ycoding.v5.Dots_ReviewDecisionValue3_kind": {
    "1": "guardrail",
  },
  "ycoding.v5.Dots_ReviewDecisionValue3_reply": {
    "1": "once",
    "2": "reject",
  },
  "ycoding.v5.Dots_ReviewDecisionValue4_kind": {
    "1": "permission",
  },
  "ycoding.v5.Dots_ReviewDecisionValue4_reply": {
    "1": "once",
    "2": "reject",
  },
  "ycoding.v5.Dots_ReviewDecisionValue5_kind": {
    "1": "recovery",
  },
  "ycoding.v5.Dots_ReviewDecisionValue5_choice": {
    "1": "continue",
    "2": "stop",
  },
  "ycoding.v5.Dots_ReviewDecisionValue6_kind": {
    "1": "question",
    "2": "subagent_question",
  },
  "ycoding.v5.SessionLogItemValue68_type": {
    "1": "session.dots.binding.bound",
  },
  "ycoding.v5.SessionLogItemValue69_type": {
    "1": "session.dots.binding.unbound",
  },
  "ycoding.v5.SessionLogItemValue70_type": {
    "1": "session.dots.device-delegation.created",
  },
  "ycoding.v5.Dots_DeviceDelegationInfo_basis": {
    "1": "device",
  },
  "ycoding.v5.Dots_DeviceDelegationScope_target": {
    "1": "device",
  },
  "ycoding.v5.Dots_DeviceDelegationScope_operationsItem": {
    "1": "task",
    "2": "decision",
  },
  "ycoding.v5.SessionLogItemValue71_type": {
    "1": "session.dots.device-delegation.revoked",
  },
  "ycoding.v5.SessionLogItemValue72_type": {
    "1": "session.dots.decision.settled",
  },
  "ycoding.v5.SessionLogItemValue72_data_reply": {
    "1": "once",
    "2": "reject",
  },
  "ycoding.v5.Form_DelegatedReplySource_kind": {
    "1": "dots-delegation",
  },
  "ycoding.v5.Dots_DecisionTargetValue1_kind": {
    "1": "permission",
  },
  "ycoding.v5.Dots_DecisionTargetValue2_kind": {
    "1": "guardrail",
  },
  "ycoding.v5.Dots_DecisionTargetValue3_kind": {
    "1": "form",
  },
  "ycoding.v5.Dots_DecisionTargetValue4_kind": {
    "1": "question",
  },
  "ycoding.v5.Dots_DecisionTargetValue5_kind": {
    "1": "subagent_question",
  },
  "ycoding.v5.Dots_DecisionTargetValue6_kind": {
    "1": "review",
  },
  "ycoding.v5.SessionLogItemValue64_type": {
    "1": "session.dots.instruction.rejected",
  },
  "ycoding.v5.SessionLogItemValue64_data_reason": {
    "1": "delegation_invalid",
  },
  "ycoding.v5.SessionLogItemValue65_type": {
    "1": "session.dots.report.recorded",
  },
  "ycoding.v5.Dots_ReportEnvelope_kind": {
    "1": "progress",
    "2": "blocker",
    "3": "decision_request",
    "4": "completion",
  },
  "ycoding.v5.Dots_ReportEnvelope_origin": {
    "1": "agent",
  },
  "ycoding.v5.SessionLogItemValue17_type": {
    "1": "session.execution.started",
  },
  "ycoding.v5.SessionLogItemValue18_type": {
    "1": "session.execution.succeeded",
  },
  "ycoding.v5.SessionLogItemValue19_type": {
    "1": "session.execution.failed",
  },
  "ycoding.v5.SessionLogItemValue20_type": {
    "1": "session.execution.interrupted",
  },
  "ycoding.v5.SessionLogItemValue20_data_reason": {
    "1": "user",
    "2": "shutdown",
    "3": "superseded",
  },
  "ycoding.v5.SessionLogItemValue21_type": {
    "1": "session.work.completed",
  },
  "ycoding.v5.SessionLogItemValue22_type": {
    "1": "session.instructions.updated",
  },
  "ycoding.v5.SessionLogItemValue22_data_deltaEntryValueValue2": {
    "1": "removed",
  },
  "ycoding.v5.SessionLogItemValue23_type": {
    "1": "session.context.observed",
  },
  "ycoding.v5.SessionLogItemValue23_data_source": {
    "1": "session-state",
    "2": "team-view",
    "3": "step-limit",
    "4": "dots",
  },
  "ycoding.v5.Dots_CoordinationContextValue1_state": {
    "1": "enabled",
  },
  "ycoding.v5.Dots_CoordinationContextValue1_tool": {
    "1": "dots_report",
  },
  "ycoding.v5.Dots_TaskEnvelope_kind": {
    "1": "task",
  },
  "ycoding.v5.Dots_TaskEnvelope_origin": {
    "1": "plugin",
  },
  "ycoding.v5.Dots_CoordinationContextValue2_state": {
    "1": "disabled",
  },
  "ycoding.v5.Dots_CoordinationContextValue2_reason": {
    "1": "capability_disabled",
    "2": "no_task",
    "3": "task_settled",
    "4": "unavailable",
    "5": "tool_unavailable",
  },
  "ycoding.v5.SessionLogItemValue24_type": {
    "1": "session.task.updated",
  },
  "ycoding.v5.SessionLogItemValue24_data_changeValue1_type": {
    "1": "launched",
  },
  "ycoding.v5.SessionLogItemValue24_data_changeValue1_delivery": {
    "1": "steer",
    "2": "queue",
  },
  "ycoding.v5.SessionLogItemValue24_data_changeValue2_type": {
    "1": "started",
  },
  "ycoding.v5.SessionLogItemValue24_data_changeValue3_type": {
    "1": "backgrounded",
  },
  "ycoding.v5.SessionLogItemValue24_data_changeValue14_type": {
    "1": "supervising",
  },
  "ycoding.v5.SessionLogItemValue24_data_changeValue4_type": {
    "1": "progressed",
  },
  "ycoding.v5.SessionLogItemValue24_data_changeValue5_type": {
    "1": "question_asked",
  },
  "ycoding.v5.SessionLogItemValue24_data_changeValue6_type": {
    "1": "question_answered",
  },
  "ycoding.v5.SessionLogItemValue24_data_changeValue12_type": {
    "1": "question_timed_out",
  },
  "ycoding.v5.SessionLogItemValue24_data_changeValue7_type": {
    "1": "cancel_requested",
  },
  "ycoding.v5.SessionLogItemValue24_data_changeValue8_type": {
    "1": "cancelled",
  },
  "ycoding.v5.SessionLogItemValue24_data_changeValue9_type": {
    "1": "completed",
  },
  "ycoding.v5.SessionLogItemValue24_data_changeValue10_type": {
    "1": "failed",
  },
  "ycoding.v5.SessionLogItemValue24_data_changeValue11_type": {
    "1": "lost",
  },
  "ycoding.v5.SessionLogItemValue24_data_changeValue13_type": {
    "1": "resumed",
  },
  "ycoding.v5.SessionLogItemValue25_type": {
    "1": "session.synthetic",
  },
  "ycoding.v5.SessionLogItemValue26_type": {
    "1": "session.skill.activated",
  },
  "ycoding.v5.SessionLogItemValue27_type": {
    "1": "session.skill.deactivated",
  },
  "ycoding.v5.SessionLogItemValue27_data_reason": {
    "1": "conflict_resolved",
  },
  "ycoding.v5.SessionLogItemValue76_type": {
    "1": "session.cue.detected",
  },
  "ycoding.v5.Recall_CueKind": {
    "1": "explicit",
    "2": "command",
    "3": "path",
    "4": "symbol",
    "5": "tool_call",
    "6": "tool_result",
    "7": "tool_error",
    "8": "workspace",
    "9": "lifecycle",
    "10": "compaction",
    "11": "recovery",
    "12": "memory_revision",
    "13": "skill_revision",
  },
  "ycoding.v5.SessionLogItemValue77_type": {
    "1": "session.recall.recorded",
  },
  "ycoding.v5.Recall_Trigger": {
    "1": "prompt",
    "2": "cue",
    "3": "explicit",
    "4": "compaction",
    "5": "recovery",
    "6": "delegation",
  },
  "ycoding.v5.Recall_Outcome": {
    "1": "injected",
    "2": "abstained",
    "3": "restored",
  },
  "ycoding.v5.Recall_Abstention": {
    "1": "no_match",
    "2": "below_threshold",
    "3": "explicit_unavailable",
    "4": "out_of_budget",
    "5": "offline",
  },
  "ycoding.v5.Recall_Method": {
    "1": "explicit",
    "2": "cue",
    "3": "exact",
    "4": "bm25",
    "5": "semantic",
    "6": "rrf",
  },
  "ycoding.v5.Recall_Kind": {
    "1": "memory",
    "2": "skill",
  },
  "ycoding.v5.Recall_Stage": {
    "1": "candidate",
    "2": "rejected",
    "3": "selected",
    "4": "injected",
    "5": "restored",
  },
  "ycoding.v5.Recall_Rejection": {
    "1": "denied",
    "2": "disabled",
    "3": "stale",
    "4": "out_of_scope",
    "5": "over_budget",
    "6": "duplicate",
    "7": "conflict",
    "8": "below_threshold",
    "9": "manual_only",
    "10": "missing",
    "11": "untrusted",
  },
  "ycoding.v5.Recall_Trust": {
    "1": "trusted",
    "2": "unverified",
  },
  "ycoding.v5.Recall_Freshness": {
    "1": "fresh",
    "2": "stale",
    "3": "unknown",
  },
  "ycoding.v5.Recall_Lifecycle": {
    "1": "active",
    "2": "draft",
    "3": "deprecated",
    "4": "superseded",
    "5": "archived",
    "6": "unknown",
  },
  "ycoding.v5.SessionLogItemValue78_type": {
    "1": "session.lifecycle.recorded",
  },
  "ycoding.v5.Lifecycle_Decision": {
    "1": "continue",
    "2": "recover",
    "3": "complete",
  },
  "ycoding.v5.Lifecycle_Basis": {
    "1": "tool_results",
    "2": "answered",
    "3": "truncated",
    "4": "silent",
    "5": "unsettled",
  },
  "ycoding.v5.SessionLogItemValue79_type": {
    "1": "session.harness.evaluated",
  },
  "ycoding.v5.Harness_Stage": {
    "1": "baseline",
    "2": "propose",
    "3": "probe",
    "4": "compose",
    "5": "adopt",
  },
  "ycoding.v5.Harness_Mode": {
    "1": "adaptive",
    "2": "parallel",
    "3": "sequential",
    "4": "disabled",
  },
  "ycoding.v5.SessionLogItemValue80_type": {
    "1": "session.harness.probed",
  },
  "ycoding.v5.SessionLogItemValue81_type": {
    "1": "session.harness.adopted",
  },
  "ycoding.v5.SessionLogItemValue82_type": {
    "1": "session.harness.rolled-back",
  },
  "ycoding.v5.SessionLogItemValue83_type": {
    "1": "session.harness.reflected",
  },
  "ycoding.v5.SessionLogItemValue28_type": {
    "1": "session.shell.started",
  },
  "ycoding.v5.SessionLogItemValue29_type": {
    "1": "session.shell.ended",
  },
  "ycoding.v5.SessionLogItemValue30_type": {
    "1": "session.step.started",
  },
  "ycoding.v5.SessionLogItemValue31_type": {
    "1": "session.step.ended",
  },
  "ycoding.v5.SessionLogItemValue31_data_finish": {
    "1": "stop",
    "2": "length",
    "3": "tool-calls",
    "4": "content-filter",
    "5": "error",
    "6": "unknown",
  },
  "ycoding.v5.SessionLogItemValue32_type": {
    "1": "session.step.failed",
  },
  "ycoding.v5.SessionLogItemValue60_type": {
    "1": "session.step.rerouted",
  },
  "ycoding.v5.SessionLogItemValue33_type": {
    "1": "session.text.started",
  },
  "ycoding.v5.SessionLogItemValue33_data_phase": {
    "1": "commentary",
    "2": "final_answer",
  },
  "ycoding.v5.SessionLogItemValue34_type": {
    "1": "session.text.ended",
  },
  "ycoding.v5.SessionLogItemValue34_data_phase": {
    "1": "commentary",
    "2": "final_answer",
  },
  "ycoding.v5.SessionLogItemValue35_type": {
    "1": "session.reasoning.started",
  },
  "ycoding.v5.SessionLogItemValue36_type": {
    "1": "session.reasoning.ended",
  },
  "ycoding.v5.SessionLogItemValue37_type": {
    "1": "session.tool.input.started",
  },
  "ycoding.v5.SessionLogItemValue38_type": {
    "1": "session.tool.input.ended",
  },
  "ycoding.v5.SessionLogItemValue39_type": {
    "1": "session.tool.called",
  },
  "ycoding.v5.SessionLogItemValue66_type": {
    "1": "session.tool.invocation-settled",
  },
  "ycoding.v5.ToolInvocation_Settled_status": {
    "1": "completed",
    "2": "error",
  },
  "ycoding.v5.SessionLogItemValue41_type": {
    "1": "session.tool.success",
  },
  "ycoding.v5.SessionLogItemValue42_type": {
    "1": "session.tool.failed",
  },
  "ycoding.v5.SessionLogItemValue43_type": {
    "1": "session.file-change.recorded",
  },
  "ycoding.v5.SessionLogItemValue44_type": {
    "1": "session.retry.scheduled",
  },
  "ycoding.v5.SessionLogItemValue45_type": {
    "1": "session.compaction.admitted",
  },
  "ycoding.v5.SessionLogItemValue46_type": {
    "1": "session.compaction.started",
  },
  "ycoding.v5.SessionLogItemValue47_type": {
    "1": "session.compaction.ended",
  },
  "ycoding.v5.SessionLogItemValue48_type": {
    "1": "session.compaction.failed",
  },
  "ycoding.v5.SessionLogItemValue48_data_code": {
    "1": "cancelled",
    "2": "superseded",
    "3": "invalid_manifest",
    "4": "protected_state_changed",
    "5": "context_limit_unresolved",
    "6": "migration_failed",
    "7": "provider_failed",
  },
  "ycoding.v5.SessionLogItemValue49_type": {
    "1": "session.revert.staged",
  },
  "ycoding.v5.SessionLogItemValue50_type": {
    "1": "session.revert.cleared",
  },
  "ycoding.v5.SessionLogItemValue51_type": {
    "1": "session.revert.committed",
  },
  "ycoding.v5.SessionLogItemValue52_type": {
    "1": "log.synced",
  },
  "ycoding.v5.Connector_AuthInfo_methodsItem_type": {
    "1": "key",
    "2": "oauth",
    "3": "command",
  },
  "ycoding.v5.Connector_AuthPromptValue1_type": {
    "1": "text",
  },
  "ycoding.v5.Connector_AuthPromptValue1_when_op": {
    "1": "eq",
    "2": "neq",
  },
  "ycoding.v5.Connector_AuthPromptValue2_type": {
    "1": "select",
  },
  "ycoding.v5.Connector_AuthPromptValue2_when_op": {
    "1": "eq",
    "2": "neq",
  },
  "ycoding.v5.Connector_Error_code": {
    "1": "invalid_message",
    "2": "message_too_large",
    "3": "unknown_operation",
    "4": "session_required",
    "5": "session_not_allowed",
    "6": "subagent_read_only",
    "7": "not_found",
    "8": "not_subscribed",
    "9": "rate_limited",
    "10": "agent_unavailable",
    "11": "outcome_unknown",
    "12": "forbidden",
    "13": "telemetry_disabled",
    "14": "unauthorized",
    "15": "internal_error",
  },
  "ycoding.v5.provider_auth_key_Result_data_status": {
    "1": "complete",
  },
  "ycoding.v5.Connector_AuthAttempt_type": {
    "1": "oauth",
    "2": "command",
  },
  "ycoding.v5.Connector_AuthAttempt_mode": {
    "1": "auto",
    "2": "code",
  },
  "ycoding.v5.provider_auth_status_Result_data_status": {
    "1": "pending",
    "2": "complete",
    "3": "failed",
    "4": "expired",
  },
  "ycoding.v5.provider_auth_complete_Result_data_status": {
    "1": "submitted",
  },
  "ycoding.v5.provider_auth_cancel_Result_data_status": {
    "1": "cancelled",
  },
  "ycoding.v5.provider_auth_refresh_Result_dataValue1_status": {
    "1": "refreshed",
  },
  "ycoding.v5.provider_auth_refresh_Result_dataValue2_status": {
    "1": "failed",
  },
  "ycoding.v5.Connector_CapturedGroup_status": {
    "1": "created",
    "2": "deleted",
    "3": "modified",
  },
  "ycoding.v5.Connector_CapturedFile_status": {
    "1": "created",
    "2": "deleted",
    "3": "modified",
  },
  "ycoding.v5.session_family_activity_Result_dataItem_activity_kind": {
    "1": "tool",
    "2": "thinking",
    "3": "replying",
  },
  "ycoding.v5.session_family_activity_Result_dataItem_activity_room": {
    "1": "research",
    "2": "qa",
    "3": "meeting",
    "4": "developer",
    "5": "hold",
  },
  "ycoding.v5.Connector_Catalog_agentsItem_mode": {
    "1": "primary",
    "2": "subagent",
    "3": "all",
  },
  "ycoding.v5.Coordination_RequestKind": {
    "1": "question",
    "2": "permission",
    "3": "review",
  },
  "ycoding.v5.CoordinationError__tag": {
    "1": "CoordinationError",
  },
  "ycoding.v5.Coordination_PausedReason": {
    "1": "interrupted",
    "2": "restart",
  },
  "ycoding.v5.Coordination_MemberState": {
    "1": "idle",
    "2": "running",
    "3": "waiting",
    "4": "failed",
  },
  "ycoding.v5.Coordination_BoardNode_role": {
    "1": "master",
    "2": "supervisor",
    "3": "member",
    "4": "subagent",
  },
  "ycoding.v5.Coordination_BoardNode_state": {
    "1": "idle",
    "2": "starting",
    "3": "running",
    "4": "waiting",
    "5": "supervising",
    "6": "cancelling",
    "7": "cancelled",
    "8": "completed",
    "9": "failed",
    "10": "lost",
  },
  "ycoding.v5.Coordination_BoardTask_state": {
    "1": "queued",
    "2": "blocked",
    "3": "running",
    "4": "waiting",
    "5": "completed",
    "6": "failed",
    "7": "cancelled",
  },
  "ycoding.v5.PublicEvent_models_dev_refreshed_type": {
    "1": "models-dev.refreshed",
  },
  "ycoding.v5.PublicEvent_integration_updated_type": {
    "1": "integration.updated",
  },
  "ycoding.v5.PublicEvent_integration_connection_updated_type": {
    "1": "integration.connection.updated",
  },
  "ycoding.v5.PublicEvent_catalog_updated_type": {
    "1": "catalog.updated",
  },
  "ycoding.v5.PublicEvent_agent_updated_type": {
    "1": "agent.updated",
  },
  "ycoding.v5.PublicEvent_session_usage_updated_type": {
    "1": "session.usage.updated",
  },
  "ycoding.v5.PublicEvent_session_prediction_updated_type": {
    "1": "session.prediction.updated",
  },
  "ycoding.v5.PublicEvent_session_diagnostics_updated_type": {
    "1": "session.diagnostics.updated",
  },
  "ycoding.v5.PublicEvent_session_text_delta_type": {
    "1": "session.text.delta",
  },
  "ycoding.v5.PublicEvent_session_reasoning_delta_type": {
    "1": "session.reasoning.delta",
  },
  "ycoding.v5.PublicEvent_session_tool_input_delta_type": {
    "1": "session.tool.input.delta",
  },
  "ycoding.v5.PublicEvent_session_tool_progress_type": {
    "1": "session.tool.progress",
  },
  "ycoding.v5.PublicEvent_session_compaction_delta_type": {
    "1": "session.compaction.delta",
  },
  "ycoding.v5.PublicEvent_coordination_group_created_type": {
    "1": "coordination.group.created",
  },
  "ycoding.v5.PublicEvent_coordination_group_changed_type": {
    "1": "coordination.group.changed",
  },
  "ycoding.v5.PublicEvent_coordination_group_deleted_type": {
    "1": "coordination.group.deleted",
  },
  "ycoding.v5.PublicEvent_coordination_member_owner_changed_type": {
    "1": "coordination.member.owner.changed",
  },
  "ycoding.v5.PublicEvent_coordination_member_owner_changed_data_reason": {
    "1": "completed",
    "2": "released",
  },
  "ycoding.v5.PublicEvent_coordination_subagent_request_blocked_type": {
    "1": "coordination.subagent.request.blocked",
  },
  "ycoding.v5.PublicEvent_coordination_subagent_request_blocked_data_reason": {
    "1": "concurrency-ceiling",
    "2": "agent-missing",
    "3": "permission-denied",
    "4": "project-paused",
    "5": "route-unavailable",
  },
  "ycoding.v5.PublicEvent_coordination_updated_type": {
    "1": "coordination.updated",
  },
  "ycoding.v5.PublicEvent_coordination_request_escalated_type": {
    "1": "coordination.request.escalated",
  },
  "ycoding.v5.PublicEvent_filesystem_changed_type": {
    "1": "filesystem.changed",
  },
  "ycoding.v5.PublicEvent_filesystem_changed_data_event": {
    "1": "add",
    "2": "change",
    "3": "unlink",
  },
  "ycoding.v5.PublicEvent_reference_updated_type": {
    "1": "reference.updated",
  },
  "ycoding.v5.PublicEvent_permission_asked_type": {
    "1": "permission.asked",
  },
  "ycoding.v5.PublicEvent_permission_replied_type": {
    "1": "permission.replied",
  },
  "ycoding.v5.PublicEvent_permission_deferred_type": {
    "1": "permission.deferred",
  },
  "ycoding.v5.PublicEvent_permission_cancelled_type": {
    "1": "permission.cancelled",
  },
  "ycoding.v5.PublicEvent_guardrail_asked_type": {
    "1": "guardrail.asked",
  },
  "ycoding.v5.PublicEvent_guardrail_replied_type": {
    "1": "guardrail.replied",
  },
  "ycoding.v5.PublicEvent_guardrail_replied_data_decidedBy": {
    "1": "decision-model",
  },
  "ycoding.v5.PublicEvent_guardrail_decided_type": {
    "1": "guardrail.decided",
  },
  "ycoding.v5.Guardrail_Decision": {
    "1": "allow",
    "2": "ask",
    "3": "deny",
    "4": "cap_exceeded",
  },
  "ycoding.v5.PublicEvent_guardrail_deferred_type": {
    "1": "guardrail.deferred",
  },
  "ycoding.v5.PublicEvent_guardrail_cancelled_type": {
    "1": "guardrail.cancelled",
  },
  "ycoding.v5.PublicEvent_plugin_added_type": {
    "1": "plugin.added",
  },
  "ycoding.v5.PublicEvent_plugin_updated_type": {
    "1": "plugin.updated",
  },
  "ycoding.v5.PublicEvent_project_directories_updated_type": {
    "1": "project.directories.updated",
  },
  "ycoding.v5.PublicEvent_command_updated_type": {
    "1": "command.updated",
  },
  "ycoding.v5.PublicEvent_config_updated_type": {
    "1": "config.updated",
  },
  "ycoding.v5.PublicEvent_skill_updated_type": {
    "1": "skill.updated",
  },
  "ycoding.v5.PublicEvent_pty_created_type": {
    "1": "pty.created",
  },
  "ycoding.v5.PublicEvent_pty_updated_type": {
    "1": "pty.updated",
  },
  "ycoding.v5.PublicEvent_pty_exited_type": {
    "1": "pty.exited",
  },
  "ycoding.v5.PublicEvent_pty_exited_data_reason": {
    "1": "exit",
    "2": "timeout",
  },
  "ycoding.v5.PublicEvent_pty_deleted_type": {
    "1": "pty.deleted",
  },
  "ycoding.v5.PublicEvent_shell_created_type": {
    "1": "shell.created",
  },
  "ycoding.v5.PublicEvent_shell_exited_type": {
    "1": "shell.exited",
  },
  "ycoding.v5.PublicEvent_shell_exited_data_status": {
    "1": "running",
    "2": "exited",
    "3": "timeout",
    "4": "memory-limit",
    "5": "killed",
  },
  "ycoding.v5.PublicEvent_shell_deleted_type": {
    "1": "shell.deleted",
  },
  "ycoding.v5.PublicEvent_question_asked_type": {
    "1": "question.asked",
  },
  "ycoding.v5.PublicEvent_question_replied_type": {
    "1": "question.replied",
  },
  "ycoding.v5.PublicEvent_question_rejected_type": {
    "1": "question.rejected",
  },
  "ycoding.v5.PublicEvent_question_timed_out_type": {
    "1": "question.timed_out",
  },
  "ycoding.v5.PublicEvent_question_deferred_type": {
    "1": "question.deferred",
  },
  "ycoding.v5.PublicEvent_form_created_type": {
    "1": "form.created",
  },
  "ycoding.v5.PublicEvent_form_replied_type": {
    "1": "form.replied",
  },
  "ycoding.v5.Form_ReplySourceValue1_kind": {
    "1": "coordinator",
  },
  "ycoding.v5.Form_ReplySourceValue1_via": {
    "1": "auto-answer",
    "2": "yolo",
    "3": "goal",
    "4": "coordination",
  },
  "ycoding.v5.PublicEvent_form_cancelled_type": {
    "1": "form.cancelled",
  },
  "ycoding.v5.PublicEvent_form_timed_out_type": {
    "1": "form.timed_out",
  },
  "ycoding.v5.PublicEvent_form_deferred_type": {
    "1": "form.deferred",
  },
  "ycoding.v5.PublicEvent_form_assessed_type": {
    "1": "form.assessed",
  },
  "ycoding.v5.PublicEvent_todo_updated_type": {
    "1": "todo.updated",
  },
  "ycoding.v5.PublicEvent_provider_quota_pace_type": {
    "1": "provider.quota.pace",
  },
  "ycoding.v5.ProviderUsage_PaceMilestone": {
    "1": "almost-out",
    "2": "cutting-it-close",
    "3": "will-run-out",
  },
  "ycoding.v5.PublicEvent_session_interaction_changed_type": {
    "1": "session.interaction.changed",
  },
  "ycoding.v5.PublicEvent_session_status_type": {
    "1": "session.status",
  },
  "ycoding.v5.SessionStatusValue1_type": {
    "1": "idle",
  },
  "ycoding.v5.SessionStatusValue2_type": {
    "1": "retry",
  },
  "ycoding.v5.SessionStatusValue3_type": {
    "1": "busy",
  },
  "ycoding.v5.PublicEvent_session_idle_type": {
    "1": "session.idle",
  },
  "ycoding.v5.PublicEvent_tui_prompt_append_type": {
    "1": "tui.prompt.append",
  },
  "ycoding.v5.PublicEvent_tui_command_execute_type": {
    "1": "tui.command.execute",
  },
  "ycoding.v5.PublicEvent_tui_command_execute_data_commandValue1": {
    "1": "session.list",
    "2": "session.new",
    "3": "session.share",
    "4": "session.interrupt",
    "5": "session.background",
    "6": "session.compact",
    "7": "session.page.up",
    "8": "session.page.down",
    "9": "session.line.up",
    "10": "session.line.down",
    "11": "session.half.page.up",
    "12": "session.half.page.down",
    "13": "session.first",
    "14": "session.last",
    "15": "prompt.clear",
    "16": "prompt.submit",
    "17": "agent.cycle",
  },
  "ycoding.v5.PublicEvent_tui_toast_show_type": {
    "1": "tui.toast.show",
  },
  "ycoding.v5.PublicEvent_tui_toast_show_data_variant": {
    "1": "info",
    "2": "success",
    "3": "warning",
    "4": "error",
  },
  "ycoding.v5.PublicEvent_tui_session_select_type": {
    "1": "tui.session.select",
  },
  "ycoding.v5.PublicEvent_installation_updated_type": {
    "1": "installation.updated",
  },
  "ycoding.v5.PublicEvent_installation_update_available_type": {
    "1": "installation.update-available",
  },
  "ycoding.v5.PublicEvent_vcs_branch_updated_type": {
    "1": "vcs.branch.updated",
  },
  "ycoding.v5.PublicEvent_mcp_status_changed_type": {
    "1": "mcp.status.changed",
  },
  "ycoding.v5.PublicEvent_mcp_resources_changed_type": {
    "1": "mcp.resources.changed",
  },
  "ycoding.v5.browser_action_Request_payload_actionValue1_type": {
    "1": "navigate",
  },
  "ycoding.v5.browser_action_Request_payload_actionValue2_type": {
    "1": "click",
  },
  "ycoding.v5.browser_action_Request_payload_actionValue3_type": {
    "1": "type",
  },
  "ycoding.v5.browser_action_Request_payload_actionValue21_type": {
    "1": "fill",
  },
  "ycoding.v5.browser_action_Request_payload_actionValue22_type": {
    "1": "select",
  },
  "ycoding.v5.browser_action_Request_payload_actionValue23_type": {
    "1": "check",
  },
  "ycoding.v5.browser_action_Request_payload_actionValue24_type": {
    "1": "hover",
  },
  "ycoding.v5.browser_action_Request_payload_actionValue4_type": {
    "1": "scroll",
  },
  "ycoding.v5.browser_action_Request_payload_actionValue5_type": {
    "1": "capture",
  },
  "ycoding.v5.browser_action_Request_payload_actionValue6_type": {
    "1": "group",
  },
  "ycoding.v5.browser_action_Request_payload_actionValue7_type": {
    "1": "ungroup",
  },
  "ycoding.v5.browser_action_Request_payload_actionValue26_type": {
    "1": "group_control",
  },
  "ycoding.v5.browser_action_Request_payload_actionValue8_type": {
    "1": "back",
  },
  "ycoding.v5.browser_action_Request_payload_actionValue9_type": {
    "1": "forward",
  },
  "ycoding.v5.browser_action_Request_payload_actionValue10_type": {
    "1": "reload",
  },
  "ycoding.v5.browser_action_Request_payload_actionValue11_type": {
    "1": "key",
  },
  "ycoding.v5.browser_action_Request_payload_actionValue11_modifiersItem": {
    "1": "Alt",
    "2": "Control",
    "3": "Meta",
    "4": "Shift",
  },
  "ycoding.v5.browser_action_Request_payload_actionValue12_type": {
    "1": "wait",
  },
  "ycoding.v5.browser_action_Request_payload_actionValue12_state": {
    "1": "attached",
    "2": "visible",
    "3": "hidden",
    "4": "detached",
  },
  "ycoding.v5.browser_action_Request_payload_actionValue12_load": {
    "1": "domcontentloaded",
    "2": "load",
    "3": "networkidle",
  },
  "ycoding.v5.browser_action_Request_payload_actionValue13_type": {
    "1": "clipboard_read",
  },
  "ycoding.v5.browser_action_Request_payload_actionValue14_type": {
    "1": "clipboard_write",
  },
  "ycoding.v5.browser_action_Request_payload_actionValue15_type": {
    "1": "upload",
  },
  "ycoding.v5.browser_action_Request_payload_actionValue16_type": {
    "1": "download",
  },
  "ycoding.v5.browser_action_Request_payload_actionValue17_type": {
    "1": "logs",
  },
  "ycoding.v5.browser_action_Request_payload_actionValue18_type": {
    "1": "export",
  },
  "ycoding.v5.browser_action_Request_payload_actionValue19_type": {
    "1": "webmcp_list",
  },
  "ycoding.v5.browser_action_Request_payload_actionValue20_type": {
    "1": "webmcp_invoke",
  },
  "ycoding.v5.browser_action_Request_payload_actionValue25_type": {
    "1": "dialog",
  },
  "ycoding.v5.Browser_ActionResult_status": {
    "1": "completed",
    "2": "paused",
    "3": "rejected",
    "4": "uncertain",
  },
  "ycoding.v5.Browser_Tab_status": {
    "1": "shared",
    "2": "paused",
    "3": "unavailable",
  },
  "ycoding.v5.Browser_Tab_pauseReason": {
    "1": "user_active",
    "2": "requested",
    "3": "uncertain",
    "4": "disconnected",
  },
  "ycoding.v5.Browser_Tab_mode": {
    "1": "owned",
    "2": "profile",
  },
  "ycoding.v5.Browser_Tab_lease": {
    "1": "self",
    "2": "other",
  },
  "ycoding.v5.Browser_CaptureOutput_mediaType": {
    "1": "image/png",
  },
  "ycoding.v5.Browser_DialogInfo_kind": {
    "1": "alert",
    "2": "confirm",
    "3": "prompt",
    "4": "beforeunload",
  },
  "ycoding.v5.Browser_ControlState_checkedValue2": {
    "1": "mixed",
  },
  "ycoding.v5.Browser_ControlInput_action": {
    "1": "pause",
    "2": "resume",
  },
  "ycoding.v5.Browser_Status_state": {
    "1": "unavailable",
    "2": "pairing",
    "3": "connected",
    "4": "paused",
  },
  "ycoding.v5.Browser_Element_checkedValue2": {
    "1": "mixed",
  },
  "ycoding.v5.Browser_Element_pressedValue2": {
    "1": "mixed",
  },
  "ycoding.v5.fs_find_Request_query_type": {
    "1": "file",
    "2": "directory",
  },
  "ycoding.v5.FileSystem_Entry_type": {
    "1": "file",
    "2": "directory",
  },
  "ycoding.v5.isolatedBrowser_action_Request_payload_actionValue1_type": {
    "1": "navigate",
  },
  "ycoding.v5.isolatedBrowser_action_Request_payload_actionValue2_type": {
    "1": "click",
  },
  "ycoding.v5.isolatedBrowser_action_Request_payload_actionValue3_type": {
    "1": "type",
  },
  "ycoding.v5.isolatedBrowser_action_Request_payload_actionValue21_type": {
    "1": "fill",
  },
  "ycoding.v5.isolatedBrowser_action_Request_payload_actionValue22_type": {
    "1": "select",
  },
  "ycoding.v5.isolatedBrowser_action_Request_payload_actionValue23_type": {
    "1": "check",
  },
  "ycoding.v5.isolatedBrowser_action_Request_payload_actionValue24_type": {
    "1": "hover",
  },
  "ycoding.v5.isolatedBrowser_action_Request_payload_actionValue4_type": {
    "1": "scroll",
  },
  "ycoding.v5.isolatedBrowser_action_Request_payload_actionValue5_type": {
    "1": "capture",
  },
  "ycoding.v5.isolatedBrowser_action_Request_payload_actionValue6_type": {
    "1": "group",
  },
  "ycoding.v5.isolatedBrowser_action_Request_payload_actionValue7_type": {
    "1": "ungroup",
  },
  "ycoding.v5.isolatedBrowser_action_Request_payload_actionValue26_type": {
    "1": "group_control",
  },
  "ycoding.v5.isolatedBrowser_action_Request_payload_actionValue8_type": {
    "1": "back",
  },
  "ycoding.v5.isolatedBrowser_action_Request_payload_actionValue9_type": {
    "1": "forward",
  },
  "ycoding.v5.isolatedBrowser_action_Request_payload_actionValue10_type": {
    "1": "reload",
  },
  "ycoding.v5.isolatedBrowser_action_Request_payload_actionValue11_type": {
    "1": "key",
  },
  "ycoding.v5.isolatedBrowser_action_Request_payload_actionValue11_modifiersItem": {
    "1": "Alt",
    "2": "Control",
    "3": "Meta",
    "4": "Shift",
  },
  "ycoding.v5.isolatedBrowser_action_Request_payload_actionValue12_type": {
    "1": "wait",
  },
  "ycoding.v5.isolatedBrowser_action_Request_payload_actionValue12_state": {
    "1": "attached",
    "2": "visible",
    "3": "hidden",
    "4": "detached",
  },
  "ycoding.v5.isolatedBrowser_action_Request_payload_actionValue12_load": {
    "1": "domcontentloaded",
    "2": "load",
    "3": "networkidle",
  },
  "ycoding.v5.isolatedBrowser_action_Request_payload_actionValue13_type": {
    "1": "clipboard_read",
  },
  "ycoding.v5.isolatedBrowser_action_Request_payload_actionValue14_type": {
    "1": "clipboard_write",
  },
  "ycoding.v5.isolatedBrowser_action_Request_payload_actionValue15_type": {
    "1": "upload",
  },
  "ycoding.v5.isolatedBrowser_action_Request_payload_actionValue16_type": {
    "1": "download",
  },
  "ycoding.v5.isolatedBrowser_action_Request_payload_actionValue17_type": {
    "1": "logs",
  },
  "ycoding.v5.isolatedBrowser_action_Request_payload_actionValue18_type": {
    "1": "export",
  },
  "ycoding.v5.isolatedBrowser_action_Request_payload_actionValue19_type": {
    "1": "webmcp_list",
  },
  "ycoding.v5.isolatedBrowser_action_Request_payload_actionValue20_type": {
    "1": "webmcp_invoke",
  },
  "ycoding.v5.isolatedBrowser_action_Request_payload_actionValue25_type": {
    "1": "dialog",
  },
  "ycoding.v5.IsolatedBrowser_ActionResult_mode": {
    "1": "isolated",
  },
  "ycoding.v5.IsolatedBrowser_ActionResult_status": {
    "1": "completed",
    "2": "rejected",
    "3": "uncertain",
  },
  "ycoding.v5.IsolatedBrowser_ControlInput_action": {
    "1": "pause",
    "2": "resume",
  },
  "ycoding.v5.IsolatedBrowser_Status_mode": {
    "1": "isolated",
  },
  "ycoding.v5.IsolatedBrowser_Status_state": {
    "1": "unavailable",
    "2": "starting",
    "3": "ready",
    "4": "paused",
    "5": "stopped",
  },
  "ycoding.v5.IsolatedBrowser_Observation_mode": {
    "1": "isolated",
  },
  "ycoding.v5.KeepAwake_State": {
    "1": "off",
    "2": "on",
    "3": "unsupported",
    "4": "error",
  },
  "ycoding.v5.KeepAwake_Status_lid": {
    "1": "off",
    "2": "on",
    "3": "held",
    "4": "unsupported",
    "5": "error",
  },
  "ycoding.v5.KeepAwake_Status_system": {
    "1": "off",
    "2": "on",
    "3": "held",
    "4": "setup",
    "5": "unsupported",
    "6": "error",
  },
  "ycoding.v5.ProjectCopyError_name": {
    "1": "ProjectCopyError",
  },
  "ycoding.v5.pty_connectToken_Request_headers_x_ycoding_ticket": {
    "1": "1",
  },
  "ycoding.v5.pty_connectToken_Request_payload_access": {
    "1": "inspect",
    "2": "control",
  },
  "ycoding.v5.PtyTicket_ConnectToken_access": {
    "1": "inspect",
    "2": "control",
  },
  "ycoding.v5.PtyConflictError__tag": {
    "1": "PtyConflictError",
  },
  "ycoding.v5.PtyNotFoundError__tag": {
    "1": "PtyNotFoundError",
  },
  "ycoding.v5.pty_control_Request_payload_action": {
    "1": "take",
    "2": "pause",
    "3": "agent",
  },
  "ycoding.v5.PtyResourceLimitError__tag": {
    "1": "PtyResourceLimitError",
  },
  "ycoding.v5.pty_update_Request_payload_actor": {
    "1": "agent",
    "2": "user",
  },
  "ycoding.v5.remote_get_Result_data_state": {
    "1": "off",
    "2": "connecting",
    "3": "on",
    "4": "error",
  },
  "ycoding.v5.remote_set_Result_data_state": {
    "1": "off",
    "2": "connecting",
    "3": "on",
    "4": "error",
  },
  "ycoding.v5.ShellNotFoundError__tag": {
    "1": "ShellNotFoundError",
  },
  "ycoding.v5.Telemetry_RequestSample_kind": {
    "1": "request",
  },
  "ycoding.v5.Telemetry_RequestSample_operation": {
    "1": "provider.auth.list",
    "2": "provider.auth.key",
    "3": "provider.auth.begin",
    "4": "provider.auth.status",
    "5": "provider.auth.complete",
    "6": "provider.auth.cancel",
    "7": "workspace.list",
    "8": "session.list",
    "9": "session.active",
    "10": "session.get",
    "11": "session.messages",
    "12": "session.capturedChanges.list",
    "13": "session.compaction.list",
    "14": "session.compact",
    "15": "session.snapshot",
    "16": "session.pending.list",
    "17": "session.attachment.read",
    "18": "session.message.stream",
    "19": "session.todo.list",
    "20": "session.subagent.list",
    "21": "session.pin",
    "22": "session.unpin",
    "23": "session.subagent.cancel",
    "24": "session.subagent.answer",
    "25": "session.team.economics",
    "26": "session.team.shell.list",
    "27": "session.team.shell.kill",
    "28": "session.side-chat.list",
    "29": "session.side-chat.create",
    "30": "session.family.activity",
    "31": "session.log",
    "32": "session.subscribe",
    "33": "session.unsubscribe",
    "34": "session.prompt",
    "35": "session.attachment.upload",
    "36": "session.interrupt",
    "37": "session.prediction",
    "38": "session.promptGenerate",
    "39": "session.permission.list",
    "40": "session.permission.reply",
    "41": "session.guardrail.status",
    "42": "session.guardrail.request.list",
    "43": "session.guardrail.reply",
    "44": "session.form.list",
    "45": "session.form.reply",
    "46": "session.form.cancel",
    "47": "session.shell.output",
    "48": "session.autonomy.get",
    "49": "session.autonomy.set",
    "50": "session.goal.set",
    "51": "session.goal.stop",
    "52": "session.create",
    "53": "session.status",
    "54": "session.catalog",
    "55": "workspace.catalog",
    "56": "session.file.find",
    "57": "workspace.file.find",
    "58": "session.switchModel",
    "59": "session.switchAgent",
    "60": "session.command",
    "61": "session.skill",
    "62": "usage.providers",
    "63": "usage.summary",
    "64": "usage.report",
    "65": "machine.keepAwake.get",
    "66": "machine.keepAwake.set",
    "67": "session.usageReport",
    "68": "session.promptCosts",
    "69": "session.taskCosts",
    "70": "usage.forecast",
    "71": "session.review.list",
    "72": "session.review.decide",
    "73": "incident.report",
    "74": "incident.recent",
    "75": "incident.guidance",
    "76": "incident.guidance.get",
    "77": "incident.guidance.clear",
    "86": "coordination.settings",
    "87": "coordination.list",
    "88": "coordination.create",
    "89": "coordination.get",
    "90": "coordination.update",
    "91": "coordination.delete",
    "92": "session.delete",
    "105": "dots.get",
    "106": "dots.set",
    "107": "usage.dashboard",
    "108": "dots.attach",
    "109": "provider.auth.refresh",
    "110": "dots.detach",
    "111": "dots.remove",
    "112": "session.fork",
    "113": "coordination.attach",
    "114": "coordination.detach",
    "115": "session.pending.remove",
    "116": "session.pending.steer",
    "117": "session.interaction.status",
    "118": "session.interaction.preview",
    "119": "session.interaction.stop",
    "120": "session.interaction.resume",
    "121": "session.guardrail.cancel",
    "122": "session.guardrail.retry",
    "123": "session.deleteMessage",
    "124": "session.message.delete",
    "125": "coordination.board",
  },
  "ycoding.v5.Telemetry_RequestSample_outcome": {
    "1": "ok",
    "2": "failed",
    "3": "unknown",
    "4": "unavailable",
  },
  "ycoding.v5.Telemetry_RequestSample_reason": {
    "1": "not-connected",
    "2": "in-flight-limit",
    "3": "request-limit",
    "4": "cancelled",
  },
  "ycoding.v5.Telemetry_LongTaskSample_kind": {
    "1": "long-task",
  },
  "ycoding.v5.Telemetry_ClientSample_kind": {
    "1": "client",
  },
  "ycoding.v5.Telemetry_ClientSample_surface": {
    "1": "tui",
    "2": "web",
  },
  "ycoding.v5.Telemetry_ClientSample_metric": {
    "1": "prompt.admit",
    "2": "stream.delay",
    "3": "transcript.load",
  },
  "ycoding.v5.TelemetryDisabled__tag": {
    "1": "TelemetryDisabled",
  },
  "ycoding.v5.Vcs_Mode": {
    "1": "working",
    "2": "branch",
  },
  "ycoding.v5.Vcs_FileStatus_status": {
    "1": "added",
    "2": "deleted",
    "3": "modified",
  },
  "ycoding.v5.RemoteDeviceCredentialState": {
    "1": "not_authenticated",
    "2": "valid",
    "3": "expired",
    "4": "revoked",
  },
  "ycoding.v5.RemoteEnrollmentError__tag": {
    "1": "RemoteEnrollmentError",
  },
  "ycoding.v5.RemoteEnrollmentError_code": {
    "1": "invalid_origin",
    "2": "invalid_code",
    "3": "already_enrolled",
    "4": "relay_rejected",
    "5": "relay_unavailable",
    "6": "key_failed",
    "7": "store_failed",
  },
  "ycoding.v5.RemoteEnrollmentPartialFailure__tag": {
    "1": "RemoteEnrollmentPartialFailure",
  },
  "ycoding.v5.Agent_Info_mode": {
    "1": "subagent",
    "2": "primary",
    "3": "all",
  },
  "ycoding.v5.Agent_ColorValue2": {
    "1": "primary",
    "2": "secondary",
    "3": "accent",
    "4": "success",
    "5": "warning",
    "6": "error",
    "7": "info",
  },
  "ycoding.v5.Config_DiagnosticReason": {
    "1": "invalid-json",
    "2": "invalid-values",
    "3": "removed-keys",
  },
  "ycoding.v5.Integration_RefreshResultValue1_status": {
    "1": "refreshed",
  },
  "ycoding.v5.Integration_RefreshResultValue2_status": {
    "1": "failed",
  },
  "ycoding.v5.Dots_NativeStatus_connection_state": {
    "1": "unavailable",
    "2": "off",
    "3": "connecting",
    "4": "connected",
    "5": "error",
  },
  "ycoding.v5.Dots_NativeStatus_computer_state": {
    "1": "attached",
    "2": "detached",
    "3": "unavailable",
    "4": "removed",
  },
  "ycoding.v5.Dots_NativeStatus_computer_readiness": {
    "1": "connected",
    "2": "offline",
    "3": "unknown",
  },
  "ycoding.v5.Dots_ResumeResult_outcome": {
    "1": "resumed",
    "2": "unconfirmed",
    "3": "unknown",
  },
  "ycoding.v5.Dots_InterruptResult_outcome": {
    "1": "interrupted",
    "2": "unknown",
  },
  "ycoding.v5.Dots_ConversationThread_kind": {
    "1": "root",
    "2": "task",
  },
  "ycoding.v5.Dots_ConversationStatus": {
    "1": "idle",
    "2": "active",
    "3": "waiting-approval",
    "4": "waiting-input",
    "5": "not-loaded",
    "6": "error",
  },
  "ycoding.v5.Dots_TranscriptTurn_status": {
    "1": "inProgress",
    "2": "completed",
    "3": "interrupted",
    "4": "failed",
  },
  "ycoding.v5.Dots_TranscriptItemValue1_type": {
    "1": "userMessage",
  },
  "ycoding.v5.Dots_TranscriptItemValue2_type": {
    "1": "agentMessage",
  },
  "ycoding.v5.Dots_TranscriptItemValue3_type": {
    "1": "commandExecution",
  },
  "ycoding.v5.Dots_TranscriptItemValue4_type": {
    "1": "fileChange",
  },
  "ycoding.v5.Dots_TranscriptItemValue5_type": {
    "1": "other",
  },
  "ycoding.v5.Dots_PendingRequest_kind": {
    "1": "command-approval",
    "2": "file-change-approval",
    "3": "permissions-approval",
    "4": "user-input",
  },
  "ycoding.v5.Dots_RequestResponse_decision": {
    "1": "accept",
    "2": "acceptForSession",
    "3": "decline",
    "4": "cancel",
  },
  "ycoding.v5.Dots_RespondResult_outcome": {
    "1": "sent",
    "2": "unknown",
  },
  "ycoding.v5.Dots_ThreadSend_mode": {
    "1": "send",
    "2": "queue",
  },
  "ycoding.v5.Dots_SendResult_admission": {
    "1": "started",
    "2": "steered",
    "3": "duplicate",
    "4": "unknown",
  },
  "ycoding.v5.ModelIncident_Kind": {
    "1": "fallback",
    "2": "guardrail-escalated",
    "3": "guardrail-rejected",
  },
  "ycoding.v5.ModelIncident_DecidedBy": {
    "1": "decision-model",
    "3": "client",
  },
  "ycoding.v5.ModelIncident_Group": {
    "1": "model",
    "2": "agent",
  },
  "ycoding.v5.Integration_CommandAttemptStatusValue1_status": {
    "1": "pending",
  },
  "ycoding.v5.Integration_CommandAttemptStatusValue2_status": {
    "1": "complete",
  },
  "ycoding.v5.Integration_CommandAttemptStatusValue3_status": {
    "1": "failed",
  },
  "ycoding.v5.Integration_CommandAttemptStatusValue4_status": {
    "1": "expired",
  },
  "ycoding.v5.Integration_OAuthMethod_type": {
    "1": "oauth",
  },
  "ycoding.v5.Integration_TextPrompt_type": {
    "1": "text",
  },
  "ycoding.v5.Integration_When_op": {
    "1": "eq",
    "2": "neq",
  },
  "ycoding.v5.Integration_SelectPrompt_type": {
    "1": "select",
  },
  "ycoding.v5.Integration_CommandMethod_type": {
    "1": "command",
  },
  "ycoding.v5.Integration_KeyMethod_type": {
    "1": "key",
  },
  "ycoding.v5.Integration_EnvMethod_type": {
    "1": "env",
  },
  "ycoding.v5.Connection_CredentialInfo_type": {
    "1": "credential",
  },
  "ycoding.v5.Connection_CredentialInfo_kind": {
    "1": "oauth",
    "2": "key",
  },
  "ycoding.v5.Connection_CredentialInfo_status": {
    "1": "connected",
    "2": "expired",
    "3": "refresh_failed",
  },
  "ycoding.v5.Connection_EnvInfo_type": {
    "1": "env",
  },
  "ycoding.v5.Integration_Attempt_mode": {
    "1": "auto",
    "2": "code",
  },
  "ycoding.v5.Integration_AttemptStatusValue1_status": {
    "1": "pending",
  },
  "ycoding.v5.Integration_AttemptStatusValue2_status": {
    "1": "complete",
  },
  "ycoding.v5.Integration_AttemptStatusValue3_status": {
    "1": "failed",
  },
  "ycoding.v5.Integration_AttemptStatusValue4_status": {
    "1": "expired",
  },
  "ycoding.v5.Mcp_LocalConfig_type": {
    "1": "local",
  },
  "ycoding.v5.Mcp_RemoteConfig_type": {
    "1": "remote",
  },
  "ycoding.v5.McpServerNotFoundError__tag": {
    "1": "McpServerNotFoundError",
  },
  "ycoding.v5.Mcp_Status_Connected_status": {
    "1": "connected",
  },
  "ycoding.v5.Mcp_Status_Pending_status": {
    "1": "pending",
  },
  "ycoding.v5.Mcp_Status_Disabled_status": {
    "1": "disabled",
  },
  "ycoding.v5.Mcp_Status_Failed_status": {
    "1": "failed",
  },
  "ycoding.v5.Mcp_Status_NeedsAuth_status": {
    "1": "needs_auth",
  },
  "ycoding.v5.Mcp_Status_NeedsClientRegistration_status": {
    "1": "needs_client_registration",
  },
  "ycoding.v5.Model_Default_status": {
    "1": "alpha",
    "2": "beta",
    "3": "deprecated",
    "4": "active",
  },
  "ycoding.v5.Model_API": {
    "1": "chat",
    "2": "responses",
  },
  "ycoding.v5.Model_Cost_tier_type": {
    "1": "context",
  },
  "ycoding.v5.Model_Info_status": {
    "1": "alpha",
    "2": "beta",
    "3": "deprecated",
    "4": "active",
  },
  "ycoding.v5.Project_Vcs": {
    "1": "git",
    "2": "hg",
  },
  "ycoding.v5.ProviderNotFoundError__tag": {
    "1": "ProviderNotFoundError",
  },
  "ycoding.v5.providerUsage_forecast_Request_query_localScope": {
    "1": "backend",
    "2": "location",
  },
  "ycoding.v5.UsageForecast_Info_localScope": {
    "1": "backend",
    "2": "location",
  },
  "ycoding.v5.ProviderUsage_Unit": {
    "1": "percent",
    "2": "usd",
    "3": "requests",
    "4": "tokens",
    "5": "count",
  },
  "ycoding.v5.ProviderUsage_Source": {
    "1": "provider_api",
    "2": "local_client_rpc",
    "3": "response_headers",
    "4": "provider_internal_api",
    "5": "local_session",
    "6": "response_stream",
  },
  "ycoding.v5.ProviderUsage_Stability": {
    "1": "stable",
    "2": "client_contract",
    "3": "observed",
    "4": "best_effort",
  },
  "ycoding.v5.UsageForecast_Quota_state": {
    "1": "estimated",
    "2": "insufficient",
    "3": "exhausted",
    "4": "unlimited",
  },
  "ycoding.v5.UsageForecast_Quota_method": {
    "1": "quota-delta-ema",
    "2": "window-mean",
  },
  "ycoding.v5.UsageForecast_Quota_evidence": {
    "1": "low",
    "2": "medium",
    "3": "insufficient",
  },
  "ycoding.v5.UsageForecast_Pace_verdict": {
    "1": "ahead",
    "2": "cutting-it-close",
    "3": "will-run-out",
  },
  "ycoding.v5.ProviderUsage_Status": {
    "1": "available",
    "2": "stale",
    "3": "unsupported",
    "4": "unauthorized",
    "5": "error",
  },
  "ycoding.v5.Reference_LocalSource_type": {
    "1": "local",
  },
  "ycoding.v5.Reference_GitSource_type": {
    "1": "git",
  },
  "ycoding.v5.ConfigurationScope": {
    "1": "global",
    "2": "project",
  },
  "ycoding.v5.ProviderRequest_ReportInput_group": {
    "1": "model",
    "2": "hour",
    "3": "day",
    "4": "month",
    "5": "session",
    "6": "project",
    "7": "agent",
    "8": "provider",
    "9": "provider-profile-model",
    "10": "provider-model",
    "11": "model-id",
    "12": "profile",
    "13": "prompt",
    "14": "task",
  },
  "ycoding.v5.ProviderRequest_ReportInput_sort": {
    "1": "key",
    "2": "tokens",
    "3": "cost",
    "4": "steps",
    "5": "input",
    "6": "output",
    "7": "reasoning",
    "8": "cacheRead",
    "9": "cacheWrite",
  },
  "ycoding.v5.ProviderRequest_ReportInput_order": {
    "1": "asc",
    "2": "desc",
  },
  "ycoding.v5.UsageDashboard_Preparing_status": {
    "1": "preparing",
  },
  "ycoding.v5.UsageDashboard_Error_status": {
    "1": "error",
  },
  "ycoding.v5.UsageDashboard_Ready_status": {
    "1": "ready",
  },
  "ycoding.v5.UsageDashboard_QuotaPreparing_status": {
    "1": "preparing",
  },
  "ycoding.v5.UsageDashboard_QuotaReady_status": {
    "1": "ready",
  },
  "ycoding.v5.UsageDashboard_QuotaFailed_status": {
    "1": "error",
  },
  "ycoding.v5.ConfigurationWriteError__tag": {
    "1": "ConfigurationWriteError",
  },
  "ycoding.v5.ConfigurationWriteError_code": {
    "1": "invalid_config",
    "2": "scope_not_allowed",
    "3": "provider_collision",
    "4": "write_failed",
  },
  "ycoding.v5.ConfigurationPartialFailure__tag": {
    "1": "ConfigurationPartialFailure",
  },
  "ycoding.v5.ConfigurationPartialFailure_stage": {
    "1": "reload",
    "2": "registration",
  },
  "ycoding.v5.ProviderEndpointAPI": {
    "1": "chat",
    "2": "responses",
  },
  "ycoding.v5.ProviderEndpointWorker": {
    "1": "ollama",
    "2": "vllm",
  },
  "ycoding.v5.ProviderEndpointCatalog": {
    "1": "openai-models",
  },
  "ycoding.v5.FrontendPackageError__tag": {
    "1": "FrontendPackageError",
  },
  "ycoding.v5.FrontendPackageError_code": {
    "1": "invalid_package",
    "2": "permission_denied",
    "3": "install_failed",
    "4": "entrypoint_missing",
    "5": "integrity_failed",
  },
}
export const unionLiterals: Readonly<Record<string, Readonly<Record<string, string | number | boolean>>>> = {
  "ycoding.v5.SessionAutonomySetValue1_goal": {
    value2: true,
  },
  "ycoding.v5.Mcp_RemoteConfig_oauth": {
    value2: false,
  },
}
