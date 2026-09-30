import { createSignal } from "solid-js"
import { render } from "solid-js/web"
import { CustomSelect } from "../src/ui/custom-select"
import { Icon } from "../src/ui/icon"
import { ImagePreview } from "../src/remote/ui/image"
import "../src/styles/tokens.css"
import "../src/styles/base.css"

function CursorFixture() {
  const [clicks, setClicks] = createSignal(0)
  const [choice, setChoice] = createSignal("first")
  return <main class="container section" id="cursor-fixture">
    <h1>Cursor roles</h1>
    <p id="prose">Selectable interface prose.</p>
    <a id="link" href="#prose"><span>Read the prose</span></a>
    <button id="action" type="button" class="button" onClick={() => setClicks((value) => value + 1)}><Icon name="plus" /><span>Add</span></button>
    <output aria-live="polite">{clicks()} actions</output>
    <button id="disabled" type="button" class="button" disabled><Icon name="plus" /><span>Unavailable</span></button>
    <button id="aria-disabled" type="button" class="button" aria-disabled="true">Unavailable action</button>
    <button id="busy" type="button" class="button" disabled aria-busy="true"><span>Saving</span></button>
    <div aria-busy="true"><button id="busy-disabled" type="button" disabled>Checking</button><button id="busy-cancel" type="button">Cancel</button></div>
    <label class="field">Name<input id="text" class="input" value="Editable name" /></label>
    <label class="field">Read-only value<input id="readonly" class="input" value="Copyable value" readOnly /></label>
    <label class="field">Unavailable value<input id="disabled-text" class="input" value="Unavailable" disabled /></label>
    <label class="field">Details<textarea id="textarea" class="textarea">Editable details</textarea></label>
    <label class="check" id="toggle-label"><input id="toggle" type="checkbox" /><span>Enable setting</span></label>
    <label class="check" id="disabled-toggle-label"><input id="disabled-toggle" type="checkbox" disabled /><span>Unavailable setting</span></label>
    <fieldset disabled><legend><button id="fieldset-legend-action" type="button">Manage group</button></legend><label class="check" id="fieldset-label"><input id="fieldset-toggle" type="checkbox" /><span>Unavailable group</span></label></fieldset>
    <label class="field">Upload<input id="disabled-file" type="file" disabled /></label>
    <label class="field">Count<input id="number" type="number" value="1" /></label>
    <ImagePreview src="/icons/icon-256.png" name="YCoding mark" />
    <details><summary id="summary"><span>Details</span></summary><p>Expanded content</p></details>
    <CustomSelect label="Example selection" placeholder="Choose" value={choice()} options={[{ value: "first", label: "First" }, { value: "second", label: "Second" }]} footer={<button type="button">Manage choices</button>} onChange={setChoice} />
    <CustomSelect label="Unavailable selection" placeholder="Choose" options={[{ value: "first", label: "First" }]} disabled onChange={setChoice} />
  </main>
}

render(() => <CursorFixture />, document.getElementById("root")!)
