import { InputRenderable, RGBA, TextAttributes } from "@opentui/core"
import { Index, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { useTheme } from "../context/theme"
import { useDialog } from "../ui/dialog"
import { Keymap } from "../context/keymap"
import { DialogHeader, DialogTitle, type DialogContext } from "../ui/dialog"

export type CustomEndpointResult = {
  baseURL: string
  api: "chat" | "responses"
  provider?: string
  apiKey?: string
  profile?: string
  credentialID?: string
  catalog?: "openai-models"
  models: CustomEndpointModel[]
}

export type CustomEndpointModel = {
  id: string
  name?: string
  family?: string
  api?: "chat" | "responses"
  disabled?: boolean
}

type CustomEndpointModelDraft = {
  id: string
  name: string
  family: string
  api: string
  disabled?: boolean
}

const API_OPTIONS = ["chat", "responses"] as const

function isValidURL(url: string): boolean {
  if (!url.trim()) return false
  try {
    new URL(url.trim())
    return true
  } catch {
    return false
  }
}

export function DialogCustomEndpoint(props: {
  providerOptions?: { id: string; name?: string; profiles?: { id: string; label: string; active: boolean }[] }[]
  onComplete?: (result: CustomEndpointResult) => void
  onCancel?: () => void
}) {
  const dialog = useDialog()
  const { themeV2 } = useTheme().contextual("elevated")
  const [baseURL, setBaseURL] = createSignal("")
  const [api, setApi] = createSignal<"chat" | "responses">("chat")
  const [provider, setProvider] = createSignal("")
  const [apiKey, setApiKey] = createSignal("")
  const [profile, setProfile] = createSignal("default")
  const [credentialID, setCredentialID] = createSignal("")
  const [catalog, setCatalog] = createSignal<"none" | "openai-models">("none")
  const [models, setModels] = createSignal<CustomEndpointModelDraft[]>([])
  const [error, setError] = createSignal("")
  let baseURLInput: InputRenderable | undefined
  let providerInput: InputRenderable | undefined
  let apiKeyInput: InputRenderable | undefined
  const modelInputs: { id?: InputRenderable; name?: InputRenderable; family?: InputRenderable; api?: InputRenderable }[] = []
  let focusIndex = 0
  let settled = false
  onCleanup(() => {
    if (settled) return
    props.onCancel?.()
  })

  const validURL = createMemo(() => isValidURL(baseURL()))

  function submit() {
    const url = baseURL().trim()
    if (!url) {
      setError("Endpoint URL is required")
      return
    }
    if (!isValidURL(url)) {
      setError("Invalid URL format")
      return
    }
    const modelEntries = models().map((model) => ({
      id: model.id.trim(),
      ...(model.name.trim() ? { name: model.name.trim() } : {}),
      ...(model.family.trim() ? { family: model.family.trim() } : {}),
      ...(model.api.trim() ? { api: model.api.trim() as "chat" | "responses" } : {}),
      ...(model.disabled === undefined ? {} : { disabled: model.disabled }),
    }))
    if (modelEntries.some((model) => !model.id)) {
      setError("Model IDs cannot be empty")
      return
    }
    if (modelEntries.some((model) => model.api && !API_OPTIONS.includes(model.api))) {
      setError("Model API type must be chat or responses")
      return
    }
    if (new Set(modelEntries.map((model) => model.id)).size !== modelEntries.length) {
      setError("Model IDs must be unique")
      return
    }
    settled = true
    props.onComplete?.({
      baseURL: url,
      api: api(),
      provider: provider().trim() || undefined,
      apiKey: apiKey().trim() || undefined,
      profile: profile().trim() || "default",
      ...(credentialID() ? { credentialID: credentialID() } : {}),
      catalog: catalog() === "openai-models" ? "openai-models" : undefined,
      models: modelEntries,
    })
    dialog.clear()
  }

  function cancel() {
    props.onCancel?.()
    dialog.clear()
  }

  function focusNext() {
    const inputs = [
      baseURLInput,
      ...modelInputs.flatMap((fields) => [fields.id, fields.name, fields.family, fields.api]),
      providerInput,
      apiKeyInput,
    ].filter((input): input is InputRenderable => !!input)
    focusIndex = (focusIndex + 1) % inputs.length
    inputs[focusIndex]?.focus()
  }

  function addModel() {
    const index = models().length
    modelInputs[index] = {}
    setModels((current) => [...current, { id: "", name: "", family: "", api: "" }])
    focusIndex = index * 4 + 1
    setTimeout(() => modelInputs[index]?.id?.focus(), 1)
  }

  function handleInputKeyDown(event: { name: string; ctrl: boolean; preventDefault(): void }, modelIndex?: number) {
    if (event.name === "tab" && !event.ctrl) {
      event.preventDefault()
      focusNext()
      return
    }
    if (!event.ctrl) return
    const action = {
      n: addModel,
      o: () => setCatalog((current) => current === "none" ? "openai-models" : "none"),
      p: () => {
        const options = props.providerOptions ?? []
        if (!options.length) return
        const current = options.findIndex((option) => option.id === provider())
        setProvider(options[(current + 1) % options.length]!.id)
      },
      d: () => {
        if (modelIndex === undefined) return
        setModels((current) => current.map((model, index) => index === modelIndex
          ? { ...model, disabled: model.disabled === undefined ? true : !model.disabled }
          : model))
      },
      s: submit,
    }[event.name]
    if (!action) return
    event.preventDefault()
    action()
  }

  Keymap.createLayer(() => ({
    mode: "modal",
    commands: [
      {
        id: "custom-endpoint.submit",
        bind: "return",
        title: "Submit endpoint",
        group: "Dialog",
        run: submit,
      },
      {
        id: "custom-endpoint.cancel",
        bind: "escape",
        title: "Cancel",
        group: "Dialog",
        run: cancel,
      },
      {
        id: "custom-endpoint.add-model",
        bind: "ctrl+n",
        title: "Add model ID",
        group: "Dialog",
        run: addModel,
      },
      {
        id: "custom-endpoint.next-field",
        bind: "tab",
        title: "Focus next endpoint field",
        group: "Dialog",
        run: focusNext,
      },
      {
        id: "custom-endpoint.catalog",
        bind: "ctrl+o",
        title: "Toggle OpenAI model catalog",
        group: "Dialog",
        run: () => setCatalog((current) => current === "none" ? "openai-models" : "none"),
      },
      {
        id: "custom-endpoint.provider",
        bind: "ctrl+p",
        title: "Select next configured provider",
        group: "Dialog",
        run: () => {
          const options = props.providerOptions ?? []
          if (!options.length) return
          const current = options.findIndex((option) => option.id === provider())
          setProvider(options[(current + 1) % options.length]!.id)
        },
      },
      {
        id: "custom-endpoint.save",
        bind: "ctrl+s",
        title: "Save endpoint",
        group: "Dialog",
        run: submit,
      },
    ],
  }))

  onMount(() => {
    dialog.setSize("medium")
    setTimeout(() => baseURLInput?.focus(), 1)
  })

  return (
    <box paddingTop={1} paddingBottom={1}>
      <DialogHeader title={<DialogTitle>Custom OpenAI-Compatible Endpoint</DialogTitle>} />
      <box flexDirection="column" paddingTop={1} paddingLeft={6} paddingRight={4}>
        <box flexDirection="column">
          <text fg={themeV2.text.default} attributes={TextAttributes.BOLD}>
            Endpoint URL
          </text>
          <input
            ref={(value: InputRenderable) => {
              baseURLInput = value
            }}
            value={baseURL()}
            onInput={(e) => {
              setBaseURL(e)
              setError("")
            }}
            onKeyDown={handleInputKeyDown}
            placeholder="https://api.example.com/v1"
            placeholderColor={themeV2.text.subdued}
            textColor={themeV2.text.formfield.default}
            focusedTextColor={themeV2.text.formfield.default}
            cursorColor={themeV2.text.formfield.default}
            onSubmit={submit}
          />
          <Show when={error()}>
            <text fg={themeV2.text.feedback.error.default}>{error()}</text>
          </Show>
          <Show when={validURL()}>
            <text fg={themeV2.text.feedback.success.default}>Valid endpoint URL</text>
          </Show>
        </box>

        <box flexDirection="column" paddingTop={1}>
          <text fg={themeV2.text.default} attributes={TextAttributes.BOLD}>Catalog source</text>
          <box flexDirection="row" gap={1}>
            {(["none", "openai-models"] as const).map((source) => (
              <box paddingX={1} onMouseUp={() => setCatalog(source)} backgroundColor={catalog() === source ? themeV2.background.action.primary.focused : RGBA.fromInts(0, 0, 0, 0)}>
                <text fg={catalog() === source ? themeV2.text.action.primary.focused : themeV2.text.subdued}>{source}</text>
              </box>
            ))}
          </box>
        </box>

        <box flexDirection="column" paddingTop={1}>
          <text fg={themeV2.text.default} attributes={TextAttributes.BOLD}>Models</text>
          <Index each={models()}>
            {(model, index) => (
            <box flexDirection="column">
              <input
                ref={(value: InputRenderable) => { modelInputs[index]!.id = value }}
                value={model().id}
                onInput={(value) => setModels((current) => current.map((item, i) => i === index ? { ...item, id: value } : item))}
                onKeyDown={(event) => handleInputKeyDown(event, index)}
                placeholder="Model ID"
                placeholderColor={themeV2.text.subdued}
                textColor={themeV2.text.formfield.default}
                focusedTextColor={themeV2.text.formfield.default}
                cursorColor={themeV2.text.formfield.default}
              />
            <input ref={(value: InputRenderable) => { modelInputs[index]!.name = value }} value={model().name}
              onInput={(value) => setModels((current) => current.map((item, i) => i === index ? { ...item, name: value } : item))}
              onKeyDown={(event) => handleInputKeyDown(event, index)} placeholder="Name (optional)" placeholderColor={themeV2.text.subdued}
              textColor={themeV2.text.formfield.default} focusedTextColor={themeV2.text.formfield.default} cursorColor={themeV2.text.formfield.default} />
            <input ref={(value: InputRenderable) => { modelInputs[index]!.family = value }} value={model().family}
              onInput={(value) => setModels((current) => current.map((item, i) => i === index ? { ...item, family: value } : item))}
              onKeyDown={(event) => handleInputKeyDown(event, index)} placeholder="Family (optional)" placeholderColor={themeV2.text.subdued}
              textColor={themeV2.text.formfield.default} focusedTextColor={themeV2.text.formfield.default} cursorColor={themeV2.text.formfield.default} />
            <input ref={(value: InputRenderable) => { modelInputs[index]!.api = value }} value={model().api}
              onInput={(value) => setModels((current) => current.map((item, i) => i === index ? { ...item, api: value } : item))}
              onKeyDown={(event) => handleInputKeyDown(event, index)} placeholder="API type (chat/responses, optional)" placeholderColor={themeV2.text.subdued}
              textColor={themeV2.text.formfield.default} focusedTextColor={themeV2.text.formfield.default} cursorColor={themeV2.text.formfield.default} />
            <text fg={model().disabled ? themeV2.text.action.primary.focused : themeV2.text.subdued} onMouseUp={() => setModels((current) => current.map((item, i) => i === index ? { ...item, disabled: item.disabled === undefined ? true : !item.disabled } : item))}>
              Disabled: {model().disabled ? "yes" : "no"} · Ctrl+D
            </text>
            <text fg={themeV2.text.subdued} onMouseUp={() => setModels((current) => current.filter((_, i) => i !== index))}>Remove model ×</text>
            </box>
            )}
          </Index>
          <box onMouseUp={addModel}>
            <text fg={themeV2.text.action.primary.focused}>+ Add model · Ctrl+N</text>
          </box>
        </box>

        <box flexDirection="column" paddingTop={1}>
          <text fg={themeV2.text.default} attributes={TextAttributes.BOLD}>Credential profile</text>
          <input value={profile()} onInput={setProfile} onKeyDown={handleInputKeyDown} placeholder="Profile name" placeholderColor={themeV2.text.subdued} textColor={themeV2.text.formfield.default} focusedTextColor={themeV2.text.formfield.default} cursorColor={themeV2.text.formfield.default} />
          <Show when={(props.providerOptions?.find((option) => option.id === provider())?.profiles?.length ?? 0) > 0}>
            <box flexDirection="row" gap={1}>
              {props.providerOptions?.find((option) => option.id === provider())?.profiles?.map((item) => (
                <text fg={credentialID() === item.id ? themeV2.text.action.primary.focused : themeV2.text.subdued} onMouseUp={() => { setCredentialID(item.id); setProfile(item.label) }}>
                  {item.label}{item.active ? " (active)" : ""}
                </text>
              ))}
            </box>
          </Show>
        </box>

        <box flexDirection="column" paddingTop={1}>
          <text fg={themeV2.text.default} attributes={TextAttributes.BOLD}>
            API Type
          </text>
          <box flexDirection="row" gap={1}>
            <box
              paddingX={1}
              backgroundColor={
                api() === "chat"
                  ? themeV2.background.action.primary.focused
                  : RGBA.fromInts(0, 0, 0, 0)
              }
              onMouseUp={() => setApi("chat")}
            >
              <text
                fg={
                  api() === "chat"
                    ? themeV2.text.action.primary.focused
                    : themeV2.text.subdued
                }
                attributes={api() === "chat" ? TextAttributes.BOLD : undefined}
              >
                Chat
              </text>
            </box>
            <box
              paddingX={1}
              backgroundColor={
                api() === "responses"
                  ? themeV2.background.action.primary.focused
                  : RGBA.fromInts(0, 0, 0, 0)
              }
              onMouseUp={() => setApi("responses")}
            >
              <text
                fg={
                  api() === "responses"
                    ? themeV2.text.action.primary.focused
                    : themeV2.text.subdued
                }
                attributes={api() === "responses" ? TextAttributes.BOLD : undefined}
              >
                Responses
              </text>
            </box>
          </box>
        </box>

        <box flexDirection="column" paddingTop={1}>
          <text fg={themeV2.text.default} attributes={TextAttributes.BOLD}>
            Provider (optional)
          </text>
          <input
            ref={(value: InputRenderable) => { providerInput = value }}
            value={provider()}
            onInput={(e) => setProvider(e)}
            onKeyDown={handleInputKeyDown}
            placeholder="e.g., openai"
            placeholderColor={themeV2.text.subdued}
            textColor={themeV2.text.formfield.default}
            focusedTextColor={themeV2.text.formfield.default}
            cursorColor={themeV2.text.formfield.default}
          />
          <Show when={(props.providerOptions?.length ?? 0) > 0}>
            <box flexDirection="row" gap={1}>
              {props.providerOptions?.map((option) => (
                <text
                  fg={provider() === option.id ? themeV2.text.action.primary.focused : themeV2.text.subdued}
                  onMouseUp={() => setProvider(option.id)}
                >
                  {option.name ? `${option.name} (${option.id})` : option.id}
                </text>
              ))}
            </box>
          </Show>
        </box>

        <box flexDirection="column" paddingTop={1}>
          <text fg={themeV2.text.default} attributes={TextAttributes.BOLD}>
            API Key (optional)
          </text>
          <input
            ref={(value: InputRenderable) => { apiKeyInput = value }}
            value={apiKey()}
            onInput={(e) => setApiKey(e)}
            onKeyDown={handleInputKeyDown}
            placeholder="sk-..."
            placeholderColor={themeV2.text.subdued}
            textColor={themeV2.text.formfield.default}
            focusedTextColor={themeV2.text.formfield.default}
            cursorColor={themeV2.text.formfield.default}
          />
        </box>
      </box>
      <box paddingTop={2} paddingLeft={6} paddingRight={4}>
        <text fg={themeV2.text.action.primary.focused} onMouseUp={submit}>Save endpoint</text>
        <text fg={themeV2.text.default}>Ctrl+S <span style={{ fg: themeV2.text.subdued }}>save · Tab next field · Ctrl+O catalog · Ctrl+P provider · Esc cancel</span></text>
      </box>
    </box>
  )
}

DialogCustomEndpoint.show = (dialog: DialogContext, opts?: { onComplete?: (result: CustomEndpointResult) => void; onCancel?: () => void }) =>
  dialog.replace(() => <DialogCustomEndpoint onComplete={opts?.onComplete} onCancel={opts?.onCancel} />)
