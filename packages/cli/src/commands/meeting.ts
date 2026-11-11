import { Argument, Flag } from "effect/unstable/cli"
import { Spec } from "../framework/spec"

export const MeetingCommand = Spec.make("meeting", {
  description: "Start local meeting capture and open its live page",
  params: {
    directory: Argument.string("directory").pipe(
      Argument.withDescription("Project directory for the meeting (defaults to the current directory)"),
      Argument.optional,
    ),
    open: Flag.boolean("open").pipe(
      Flag.withDescription("Open the live meeting page in the browser"),
      Flag.withDefault(true),
    ),
    meet: Flag.string("meet").pipe(Flag.withDescription("Google Meet code or URL for the meeting"), Flag.optional),
    title: Flag.string("title").pipe(Flag.withDescription("Title for a newly armed meeting"), Flag.optional),
    speechProvider: Flag.string("speech-provider").pipe(
      Flag.withDescription("Transcription provider to configure"),
      Flag.optional,
    ),
    speechModel: Flag.string("speech-model").pipe(Flag.withDescription("Transcription model to configure"), Flag.optional),
    openaiProfile: Flag.string("openai-profile").pipe(
      Flag.withDescription("OpenAI API-key profile label stored in YCoding credentials"),
      Flag.optional,
    ),
    status: Flag.boolean("status").pipe(
      Flag.withDescription("Print the running meeting status and exit"),
      Flag.withDefault(false),
    ),
    catchup: Flag.boolean("catchup").pipe(
      Flag.withDescription("Print a catch-up summary of the running meeting and exit"),
      Flag.withDefault(false),
    ),
    ask: Flag.string("ask").pipe(Flag.withDescription("Ask a question about the running meeting and exit"), Flag.optional),
    summarizeKnowledge: Flag.boolean("summarize-knowledge").pipe(
      Flag.withDescription("Create a pending knowledge summary proposal for the running meeting and exit"),
      Flag.withDefault(false),
    ),
    approveProposal: Flag.string("approve-proposal").pipe(
      Flag.withDescription("Approve a pending knowledge proposal by ID (requires --confirm)"),
      Flag.optional,
    ),
    rejectProposal: Flag.string("reject-proposal").pipe(
      Flag.withDescription("Reject a pending knowledge proposal by ID (requires --confirm)"),
      Flag.optional,
    ),
    confirm: Flag.boolean("confirm").pipe(
      Flag.withDescription("Confirm an approve or reject proposal action"),
      Flag.withDefault(false),
    ),
  },
})
