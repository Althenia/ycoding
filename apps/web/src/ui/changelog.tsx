import { For, Show, createMemo, createSignal, type JSX } from "solid-js"
import { Link } from "../router/router"
import { RELEASES, releaseYears, type ChangeEntry, type ChangeTag } from "../content/changelog"
import { DOC_INDEX } from "../content/docs/registry"
import { DocsShell } from "./docs"

const tags: readonly ChangeTag[] = ["Added", "Changed", "Fixed"]

/** The shell needs a page identity; the changelog owns no sections, so it renders no on-this-page rail. */
const CHANGELOG_PAGE = {
  ...DOC_INDEX,
  title: "Changelog",
  description: "Every release ships per-version notes. The entries below describe user-visible behavior only.",
  sections: [],
} as const

export function ChangelogPage(): JSX.Element {
  const [year, setYear] = createSignal("all")
  const [tag, setTag] = createSignal<ChangeTag | "all">("all")
  const years = releaseYears(RELEASES)
  const releases = createMemo(() =>
    RELEASES.filter((release) => year() === "all" || release.date.startsWith(year()))
      .map((release) => ({
        ...release,
        changes: tag() === "all" ? release.changes : release.changes.filter((change) => change.tag === tag()),
      }))
      .filter((release) => release.changes.length > 0),
  )

  const filters = (
    <Filters year={year()} tag={tag()} years={years} onYear={setYear} onTag={setTag} />
  )

  return (
    <DocsShell
      page={CHANGELOG_PAGE}
      title="Changelog"
      crumbLabel="Changelog"
      navLabel="Filters"
      rail={filters}
      class="docs--changelog"
    >
      <Show when={releases().length > 0} fallback={<p class="prose">No releases match these filters.</p>}>
        <ol class="releases releases--timeline">
          <For each={releases()}>
            {(release) => (
              <li class="release" id={release.version}>
                <div class="release__meta">
                  <h2 class="release__version">v{release.version}</h2>
                  <time class="release__date" datetime={release.date}>
                    {release.date}
                  </time>
                  <ChangeTags tags={release.tags} />
                </div>
                <div class="release__changes">
                  <h3>{release.title}</h3>
                  <For each={release.tags}>
                    {(tag) => <ReleaseChangeGroup tag={tag} changes={release.changes.filter((change) => change.tag === tag)} />}
                  </For>
                </div>
              </li>
            )}
          </For>
        </ol>
      </Show>
      <p class="docs-footnote">
        <Link href="/docs/installation" class="text-link">
          Installation guide
        </Link>
        <Link href="/docs" class="text-link">
          Documentation
        </Link>
      </p>
    </DocsShell>
  )
}

function ReleaseChangeGroup(props: { readonly tag: ChangeTag; readonly changes: readonly ChangeEntry[] }): JSX.Element {
  return (
    <section class="release__change">
      <h4>
        <span class={`tag tag--${props.tag.toLowerCase()}`}>{props.tag}</span>
      </h4>
      <ul>
        <For each={props.changes}>{(change) => <li>{change.text}</li>}</For>
      </ul>
    </section>
  )
}

/** The change-type vocabulary a release uses, in the order it declares them. */
function ChangeTags(props: { readonly tags: readonly ChangeTag[] }): JSX.Element {
  return (
    <span class="release__tags">
      <For each={props.tags}>{(value) => <span class={`tag tag--${value.toLowerCase()}`}>{value}</span>}</For>
    </span>
  )
}

function Filters(props: {
  readonly year: string
  readonly tag: ChangeTag | "all"
  readonly years: readonly string[]
  readonly onYear: (value: string) => void
  readonly onTag: (value: ChangeTag | "all") => void
}): JSX.Element {
  return (
    <div class="filters filters--release">
      <fieldset class="filters__group">
        <legend>Year</legend>
        <button
          type="button"
          class={`filters__option${props.year === "all" ? " filters__option--active" : ""}`}
          aria-pressed={props.year === "all"}
          onClick={() => props.onYear("all")}
        >
          All releases
        </button>
        <For each={props.years}>
          {(value) => (
            <button
              type="button"
              class={`filters__option${props.year === value ? " filters__option--active" : ""}`}
              aria-pressed={props.year === value}
              onClick={() => props.onYear(value)}
            >
              {value}
            </button>
          )}
        </For>
      </fieldset>
      <fieldset class="filters__group">
        <legend>Change type</legend>
        <button
          type="button"
          class={`filters__option${props.tag === "all" ? " filters__option--active" : ""}`}
          aria-pressed={props.tag === "all"}
          onClick={() => props.onTag("all")}
        >
          Everything
        </button>
        <For each={tags}>
          {(value) => (
            <button
              type="button"
              class={`filters__option${props.tag === value ? " filters__option--active" : ""}`}
              aria-pressed={props.tag === value}
              onClick={() => props.onTag(value)}
            >
              {value}
            </button>
          )}
        </For>
      </fieldset>
    </div>
  )
}
