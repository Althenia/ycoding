import { render } from "solid-js/web"
import { createSignal } from "solid-js"
import { createSessionView, generationSpeedDisplay } from "../src/remote/projection"
import { SubagentBar } from "../src/remote/ui/subagent-bar"
import "../src/styles/tokens.css"
import "../src/styles/base.css"
import "../src/styles/remote.css"

const model = { providerID: "openai", id: "child-model", variant: "low", profile: "work" }
const [mode, setMode] = createSignal("blank")
const view = () => ({ ...createSessionView("ses_child"), model,
  generationSpeed: { model, recent: [], ...(mode() === "blank" ? {} : { latest: {
    model: { ...model, variant: "high", profile: "other" }, tokens: 100, durationNs: 1_000_000_000,
    tokensPerSecond: 100, ...(mode() === "estimated" ? { estimated: true } : {}),
  } }) } })
Object.assign(window, { generationSet: setMode })
render(() => <SubagentBar sessionID="ses_child" parentTitle="Parent Session" agent="Reviewer" status="running"
  economics={{ speed: generationSpeedDisplay(view(), model) }} onMain={() => undefined} onPrevious={() => undefined} onNext={() => undefined} />,
  document.getElementById("root")!)
