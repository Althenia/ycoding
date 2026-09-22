import { For, Show, createSignal, type JSX } from "solid-js"
import { Link, useRouter } from "../router/router"
import { SITE } from "../content/site"
import { useTheme } from "../theme/theme-store"
import { themePreferenceLabel } from "../theme/theme"
import { shouldShowOfflineNotice, useOnlineStatus } from "./online"
import { Modal } from "./modal"
import { Icon } from "./icon"
import { CodeBlock } from "./docs"

export function BrandMark(props: { readonly compact?: boolean }): JSX.Element {
  return (
    <>
      <span class="brand__mark">
        <img src="/brand/ycoding-mark.svg" alt="" width="28" height="28" />
      </span>
      <span class="brand__text">
        <span class="brand__name">{SITE.productName}</span>
        <Show when={!props.compact}>
          <span class="brand__descriptor">{SITE.descriptor}</span>
        </Show>
      </span>
    </>
  )
}

export function ThemeToggle(): JSX.Element {
  const theme = useTheme()
  const label = () => `Theme: ${themePreferenceLabel(theme.preference())}. Switch theme.`
  const icon = () => (theme.preference() === "system" ? "monitor" : theme.resolved() === "dark" ? "moon" : "sun")
  return (
    <button
      type="button"
      class="button button--ghost button--icon"
      aria-label={label()}
      title={label()}
      onClick={() => theme.cycle()}
    >
      <Icon name={icon()} />
    </button>
  )
}

export function OfflineBanner(): JSX.Element {
  const online = useOnlineStatus()
  return (
    <Show when={shouldShowOfflineNotice(online())}>
      <div class="offline-banner" role="status">
        <Icon name="alert" size={16} />
        <span>You are offline. Documentation already loaded stays readable; remote controls need a live connection.</span>
      </div>
    </Show>
  )
}

export function MarketingLayout(props: { readonly children: JSX.Element }): JSX.Element {
  const [open, setOpen] = createSignal(false)
  const router = useRouter()
  const inDocs = () => router.path().startsWith("/docs")
  const inChangelog = () => router.path().startsWith("/changelog")
  return (
    <div class="marketing">
      <a class="skip-link" href="#main">
        Skip to content
      </a>
      <OfflineBanner />
      <header class="app-header">
        <div class="container app-header__inner">
          <Link href="/" class="brand">
            <BrandMark />
          </Link>
          <nav class="nav" aria-label="Primary">
            <Link href="/" class={`nav__link${router.path() === "/" ? " nav__link--active" : ""}`}>
              Home
            </Link>
            <Link href="/docs" class={`nav__link${inDocs() ? " nav__link--active" : ""}`}>
              Documentation
            </Link>
            <Link href="/changelog" class={`nav__link${inChangelog() ? " nav__link--active" : ""}`}>
              Changelog
            </Link>
          </nav>
          <div class="app-header__end">
            <span class="app-header__theme">
              <ThemeToggle />
            </span>
            <span class="app-header__cta">
              <Link href="/remote" class="button button--primary">
                Open workspace
                <Icon name="chevron-right" size={16} />
              </Link>
            </span>
            <button
              type="button"
              class="button button--ghost button--icon app-header__menu"
              aria-label="Navigation"
              aria-expanded={open()}
              aria-haspopup="dialog"
              onClick={() => setOpen(true)}
            >
              <Icon name="menu" />
            </button>
          </div>
        </div>
      </header>

      <Show when={open()}>
        <Modal class="overlay--sheet" label="Navigation" onClose={() => setOpen(false)}>
          <nav class="docs-nav pane" aria-label="Site">
            <Link href="/" class="docs-nav__link" onClick={() => setOpen(false)}>
              Home
            </Link>
            <Link href="/docs" class="docs-nav__link" onClick={() => setOpen(false)}>
              Documentation
            </Link>
            <Link href="/changelog" class="docs-nav__link" onClick={() => setOpen(false)}>
              Changelog
            </Link>
            <Link href="/remote" class="docs-nav__link" onClick={() => setOpen(false)}>
              Remote workspace
            </Link>
            <a class="docs-nav__link" href={SITE.repositoryURL} rel="noreferrer noopener" target="_blank">
              GitHub
            </a>
          </nav>
        </Modal>
      </Show>

      <main id="main" tabindex="-1">
        {props.children}
      </main>

      <footer class="site-footer">
        <div class="container">
          <div class="footer__grid">
            <div class="footer__brand">
              <Link href="/" class="brand">
                <BrandMark />
              </Link>
              <p class="footer__note">{SITE.description}</p>
            </div>
            <For each={SITE.footerColumns}>
              {(column) => (
                <div>
                  <h2 class="footer__title">{column.title}</h2>
                  <div class="footer__links">
                    <For each={column.links}>
                      {(link) =>
                        link.href.startsWith("http") ? (
                          <a href={link.href} rel="noreferrer noopener" target="_blank">
                            {link.label}
                          </a>
                        ) : (
                          <Link href={link.href}>{link.label}</Link>
                        )
                      }
                    </For>
                  </div>
                </div>
              )}
            </For>
          </div>
          <div class="footer__legal">
            <span>MIT licensed. Terminal-first, local execution.</span>
            <span>{SITE.origin.replace("https://", "")}</span>
          </div>
        </div>
      </footer>
    </div>
  )
}

export function LandingPage(): JSX.Element {
  const router = useRouter()
  return (
    <>
      <section class="hero">
        <div class="container hero__content">
          <h1 class="hero__headline">{SITE.hero.headline}</h1>
          <p class="hero__support">{SITE.hero.support}</p>
          <div class="hero__actions">
            <button
              type="button"
              class="button button--primary button--large"
              onClick={() => router.navigate(SITE.hero.primaryAction.href)}
            >
              {SITE.hero.primaryAction.label}
            </button>
            <button
              type="button"
              class="button button--secondary button--large"
              onClick={() => router.navigate(SITE.hero.secondaryAction.href)}
            >
              {SITE.hero.secondaryAction.label}
            </button>
          </div>
          <CodeBlock code={SITE.installing.command} language="shell" label="Install command" />
        </div>
      </section>

      <section class="section features" aria-label="Capabilities">
        <div class="container">
          <div class="features__grid">
            <For each={SITE.features}>
              {(feature) => (
                <article class="feature">
                  <h2 class="feature__title">{feature.title}</h2>
                  <p class="feature__text">{feature.text}</p>
                </article>
              )}
            </For>
          </div>
        </div>
      </section>

    </>
  )
}

export function NotFoundPage(): JSX.Element {
  return (
    <div class="not-found">
      <p class="not-found__eyebrow">404</p>
      <h1>That page does not exist.</h1>
      <p class="prose">The link may be outdated, or the page may have moved into the documentation.</p>
      <div class="not-found__actions">
        <Link href="/docs" class="button button--primary">
          Browse documentation
        </Link>
        <Link href="/" class="button button--secondary">
          Go home
        </Link>
      </div>
    </div>
  )
}
