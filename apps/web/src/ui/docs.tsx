import { For, Show, createEffect, createMemo, createSignal, onCleanup, type JSX } from "solid-js"
import { Link, useRouter } from "../router/router"
import { DOC_INDEX, DOC_PAGES, docsByGroup, findDocPage, sectionId } from "../content/docs/registry"
import { searchDocs } from "../content/docs/search"
import type { DocBlock, DocPage, DocSection } from "../content/docs/types"
import { Modal } from "./modal"
import { Icon } from "./icon"

export function DocsNav(props: { readonly onNavigate?: () => void }): JSX.Element {
  const router = useRouter()
  const groups = docsByGroup()
  const current = () => router.path()
  return (
    <nav class="docs-nav" aria-label="Documentation">
      <For each={groups}>
        {(group) => (
          <div class="docs-nav__group">
            <p class="docs-nav__title">{group.group}</p>
            <For each={group.pages}>
              {(page) => (
                <Link
                  href={`/docs/${page.slug}`}
                  class={`docs-nav__link${current() === `/docs/${page.slug}` ? " docs-nav__link--active" : ""}`}
                  onClick={props.onNavigate}
                >
                  {page.title}
                </Link>
              )}
            </For>
          </div>
        )}
      </For>
    </nav>
  )
}

/**
 * A terminal plate with a label and a copy control.
 *
 * The body scrolls horizontally instead of wrapping, so a long command stays one
 * readable line, and the copy control sits in a 44px header row on the plate.
 */
export function CodeBlock(props: {
  readonly code: string
  readonly language: string
  readonly label?: string
}): JSX.Element {
  const [copied, setCopied] = createSignal(false)
  let timer: ReturnType<typeof setTimeout> | undefined
  onCleanup(() => clearTimeout(timer))
  const name = () => props.label ?? props.language
  return (
    <figure class="code-block">
      <figcaption class="code-block__head">
        <span class="code-block__label">{name()}</span>
        <button
          type="button"
          class="button button--ghost button--small code-block__copy"
          aria-label={copied() ? "Copied" : `Copy ${name()} block`}
          onClick={() => {
            void navigator.clipboard?.writeText(props.code)
            setCopied(true)
            clearTimeout(timer)
            timer = setTimeout(() => setCopied(false), 1_500)
          }}
        >
          <Icon name={copied() ? "check" : "copy"} size={16} />
          <span>{copied() ? "Copied" : "Copy"}</span>
        </button>
      </figcaption>
      <pre tabindex="0">
        <code>{props.code}</code>
      </pre>
    </figure>
  )
}

function Block(props: { readonly block: DocBlock }): JSX.Element {
  const block = props.block
  switch (block.kind) {
    case "paragraph":
      return <p class="prose">{block.text}</p>
    case "code":
      return <CodeBlock code={block.code} language={block.language} label={block.label} />
    case "list":
      return block.ordered ? (
        <ol class="prose">
          <For each={block.items}>{(item) => <li>{item}</li>}</For>
        </ol>
      ) : (
        <ul class="prose">
          <For each={block.items}>{(item) => <li>{item}</li>}</For>
        </ul>
      )
    case "steps":
      return (
        <ol class="steps">
          <For each={block.items}>
            {(item) => (
              <li class="steps__item">
                <div>
                  <p class="steps__title">{item.title}</p>
                  <p class="steps__text">{item.text}</p>
                </div>
              </li>
            )}
          </For>
        </ol>
      )
    case "callout":
      return (
        <aside class={`callout callout--${block.tone}`}>
          <p class="callout__title">{block.title}</p>
          <p>{block.text}</p>
        </aside>
      )
    case "table":
      return (
        <div class="table-scroll" tabindex="0">
          <table class="doc-table">
            <thead>
              <tr>
                <For each={block.head}>{(cell) => <th scope="col">{cell}</th>}</For>
              </tr>
            </thead>
            <tbody>
              <For each={block.rows}>
                {(row) => (
                  <tr>
                    <For each={row}>{(cell) => <td>{cell}</td>}</For>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
        </div>
      )
    case "cards":
      return (
        <ul class="card-grid">
          <For each={block.items}>
            {(item) => (
              <li class="card">
                <Link href={item.href} class="card__link">
                  <span class="card__title">{item.title}</span>
                  <span class="card__text">{item.text}</span>
                  <Icon name="chevron-right" size={16} />
                </Link>
              </li>
            )}
          </For>
        </ul>
      )
    case "related":
      return (
        <ul class="related">
          <For each={block.slugs}>
            {(slug) => {
              const page = findDocPage(slug)
              return (
                <Show when={page}>
                  <li>
                    <Link href={`/docs/${slug}`}>{page!.title}</Link>
                  </li>
                </Show>
              )
            }}
          </For>
        </ul>
      )
    default:
      return null
  }
}

function Section(props: { readonly page: DocPage; readonly section: DocSection; readonly index: number }): JSX.Element {
  return (
    <section class="doc-section">
      <h2 id={sectionId(props.page, props.index)}>{props.section.heading}</h2>
      <For each={props.section.blocks}>{(block) => <Block block={block} />}</For>
    </section>
  )
}

function Breadcrumbs(props: { readonly page: DocPage; readonly label: string; readonly class?: string }): JSX.Element {
  // The surface already names itself in the bar title, so the crumb only repeats the
  // page title when it adds information.
  const showTitle = () => props.page.title !== props.label
  return (
    <nav class={`breadcrumbs${props.class ? ` ${props.class}` : ""}`} aria-label="Breadcrumb">
      <Link href="/docs">{props.label}</Link>
      <Show when={showTitle()}>
        <span aria-hidden="true">/</span>
        <span>{props.page.title}</span>
      </Show>
    </nav>
  )
}

export function DocsSearch(props: { readonly onNavigate?: () => void }): JSX.Element {
  const [open, setOpen] = createSignal(false)
  const [query, setQuery] = createSignal("")
  const [active, setActive] = createSignal(0)
  const router = useRouter()
  const hits = createMemo(() => searchDocs(query(), 8))
  const optionId = (index: number) => `docs-search-option-${index}`

  const keydown = (event: KeyboardEvent) => {
    const target = event.target
    const typing =
      target instanceof HTMLElement &&
      (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)
    if ((event.key === "k" && (event.metaKey || event.ctrlKey)) || (event.key === "/" && !typing)) {
      event.preventDefault()
      setOpen(true)
      return
    }
    if (!open()) return
    if (event.key === "ArrowDown") {
      event.preventDefault()
      setActive((current) => Math.min(current + 1, Math.max(hits().length - 1, 0)))
      return
    }
    if (event.key === "ArrowUp") {
      event.preventDefault()
      setActive((current) => Math.max(current - 1, 0))
      return
    }
    if (event.key === "Enter") {
      const hit = hits()[active()]
      if (!hit) return
      event.preventDefault()
      navigateTo(hit)
    }
  }

  const navigateTo = (hit: ReturnType<typeof searchDocs>[number]) => {
    setOpen(false)
    props.onNavigate?.()
    router.navigate(`/docs/${hit.page.slug}${hit.matchedHeading ? `#${anchorFor(hit.matchedHeading)}` : ""}`)
  }

  window.addEventListener("keydown", keydown)
  onCleanup(() => window.removeEventListener("keydown", keydown))

  return (
    <>
      <button
        type="button"
        class="docs-search-trigger"
        aria-label="Search docs"
        aria-haspopup="dialog"
        aria-expanded={open()}
        onClick={() => setOpen(true)}
      >
        <Icon name="search" size={16} />
        <span>Search docs</span>
        <kbd>/</kbd>
      </button>
      <Show when={open()}>
        <Modal class="overlay--dialog" label="Search docs" onClose={() => setOpen(false)}>
          <div class="pane">
            <label class="field" for="docs-search-field">
              <span class="visually-hidden">Search documentation</span>
              <input
                class="input"
                id="docs-search-field"
                type="search"
                placeholder="Search documentation"
                aria-controls="docs-search-results"
                aria-activedescendant={hits()[active()] ? optionId(active()) : undefined}
                autofocus
                value={query()}
                onInput={(event) => {
                  setQuery(event.currentTarget.value)
                  setActive(0)
                }}
              />
            </label>
            <Show
              when={hits().length > 0}
              fallback={
                <p class="search__empty">
                  {query().length === 0 ? "Type to search the documentation." : "No matching page."}
                </p>
              }
            >
              <ul class="search__results" id="docs-search-results" role="listbox" aria-label="Search results">
                <For each={hits()}>
                  {(hit, index) => (
                    <li>
                      <button
                        type="button"
                        id={optionId(index())}
                        role="option"
                        aria-selected={index() === active()}
                        class={`search__result${index() === active() ? " search__result--active" : ""}`}
                        onClick={() => navigateTo(hit)}
                      >
                        <span class="search__result-title">{hit.page.title}</span>
                        <span class="search__result-text">{hit.matchedHeading ?? hit.page.description}</span>
                      </button>
                    </li>
                  )}
                </For>
              </ul>
            </Show>
          </div>
        </Modal>
      </Show>
    </>
  )
}

function anchorFor(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
}

export function DocsShell(props: {
  readonly page: DocPage
  readonly title: string
  readonly crumbLabel: string
  readonly navLabel: string
  readonly children: JSX.Element
  readonly rail?: JSX.Element
}): JSX.Element {
  const [navOpen, setNavOpen] = createSignal(false)
  // A surface without sections has nothing to put on this page, so it renders no
  // rail instead of an empty one.
  const showToc = () => props.page.sections.length > 0
  return (
    <div class="docs">
      <div class="docs-bar">
        <div class="container docs-bar__inner">
          <button
            type="button"
            class="docs-bar__nav-toggle"
            aria-label={props.navLabel}
            aria-haspopup="dialog"
            aria-expanded={navOpen()}
            onClick={() => setNavOpen(true)}
          >
            <Icon name="menu" size={18} />
            <span>{props.navLabel}</span>
          </button>
          <span class="docs-bar__title">{props.title}</span>
          <DocsSearch />
        </div>
        <div class="container docs-bar__crumbs">
          <Breadcrumbs page={props.page} label={props.crumbLabel} />
        </div>
      </div>
      <div class="container docs-shell">
        <div class="docs-shell__nav">
          <Show when={props.rail} fallback={<DocsNav />}>
            {props.rail}
          </Show>
        </div>
        <article class="docs-article">
          <Breadcrumbs page={props.page} label={props.crumbLabel} class="breadcrumbs--article" />
          <h1>{props.page.title}</h1>
          <p class="docs-article__lede">{props.page.description}</p>
          {props.children}
        </article>
        <Show when={showToc()}>
          <div class="docs-shell__toc">
            <nav class="docs-toc" aria-label="On this page">
              <p class="docs-toc__title">On this page</p>
              <div class="docs-toc__list">
                <For each={props.page.sections}>
                  {(section, index) => <a href={`#${sectionId(props.page, index())}`}>{section.heading}</a>}
                </For>
              </div>
            </nav>
          </div>
        </Show>
      </div>
      <Show when={navOpen()}>
        <Modal class="overlay--sheet" label={props.navLabel} onClose={() => setNavOpen(false)}>
          <div class="pane">
            <Show when={props.rail} fallback={<DocsNav onNavigate={() => setNavOpen(false)} />}>
              {props.rail}
            </Show>
          </div>
        </Modal>
      </Show>
    </div>
  )
}

export function DocsIndexPage(): JSX.Element {
  return (
    <DocsShell page={DOC_INDEX} title="Docs" crumbLabel="Docs" navLabel="Docs menu">
      <For each={DOC_INDEX.sections}>
        {(section, index) => <Section page={DOC_INDEX} section={section} index={index()} />}
      </For>
    </DocsShell>
  )
}

export function DocsPage(props: { readonly slug: string }): JSX.Element {
  const page = () => findDocPage(props.slug)
  return (
    <Show when={page()} fallback={<DocsNotFound />}>
      <DocsShell page={page()!} title="Docs" crumbLabel="Docs" navLabel="Docs menu">
        <For each={page()!.sections}>
          {(section, index) => <Section page={page()!} section={section} index={index()} />}
        </For>
      </DocsShell>
    </Show>
  )
}

function DocsNotFound(): JSX.Element {
  return (
    <DocsShell
      page={{ ...DOC_INDEX, title: "Page not found", description: "That documentation page is not published." }}
      title="Docs"
      crumbLabel="Docs"
      navLabel="Docs menu"
    >
      <p class="prose">The requested documentation page is not part of the published documentation.</p>
      <ul class="related">
        <li>
          <Link href="/docs">Documentation index</Link>
        </li>
        <For each={DOC_PAGES.slice(0, 4)}>
          {(entry) => (
            <li>
              <Link href={`/docs/${entry.slug}`}>{entry.title}</Link>
            </li>
          )}
        </For>
      </ul>
    </DocsShell>
  )
}

/** Scrolls to a documentation anchor after navigation. */
export function useDocAnchor(hash: () => string) {
  createEffect(() => {
    const id = hash()
    if (id.length === 0) return
    const element = document.getElementById(id)
    if (element) element.scrollIntoView({ block: "start" })
  })
}
