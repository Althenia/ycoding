pub fn success(provider: Option<&str>, auto_close: bool) -> String {
    let message = provider.map_or_else(
        || "YCoding is now authorized.".into(),
        |provider| format!("YCoding is now connected to {}.", escape_html(provider)),
    );
    document(
        "Authorization successful",
        &card(
            "success",
            "Authorization successful",
            &message,
            None,
            "You can close this window.",
        ),
        auto_close.then_some(AUTO_CLOSE),
    )
}

pub fn error(detail: &str, provider: Option<&str>) -> String {
    let message = provider.map_or_else(
        || "YCoding couldn't complete authorization.".into(),
        |provider| {
            format!(
                "YCoding couldn't finish connecting to {}.",
                escape_html(provider)
            )
        },
    );
    document(
        "Authorization failed",
        &card(
            "error",
            "Authorization failed",
            &message,
            Some(detail),
            "Close this window and try again from YCoding.",
        ),
        None,
    )
}

pub fn bootstrap(token_path: &str, provider: Option<&str>) -> String {
    let message = provider.map_or_else(
        || "Completing authorization.".into(),
        |provider| format!("Completing your {} authorization.", escape_html(provider)),
    );
    let script = format!(
        "var PROVIDER={};\nvar TOKEN_URL=new URL({},window.location.origin).href;\n{}",
        script_string(provider.unwrap_or("")),
        script_string(token_path),
        BOOTSTRAP
    );
    document(
        "Finishing sign-in",
        &card(
            "pending",
            "Finishing sign-in",
            &message,
            None,
            "You can close this window once sign-in finishes.",
        ),
        Some(&script),
    )
}

fn card(
    status: &str,
    headline: &str,
    message: &str,
    detail: Option<&str>,
    footnote: &str,
) -> String {
    let detail = detail.map(str::trim).filter(|value| !value.is_empty());
    format!(
        r#"<main class="card" id="oc-card" data-status="{status}" role="status" aria-live="polite">
      <div class="brand">{WORDMARK}</div>
      <div class="status" aria-hidden="true">
        <span class="icon icon-pending">{ICON_SPINNER}</span>
        <span class="icon icon-success">{ICON_CHECK}</span>
        <span class="icon icon-error">{ICON_CROSS}</span>
      </div>
      <h1 class="headline" id="oc-headline">{}</h1>
      <p class="message" id="oc-message">{message}</p>
      <pre class="detail" id="oc-detail"{}>{}</pre>
      <p class="footnote" id="oc-footnote">{}</p>
    </main>"#,
        escape_html(headline),
        if detail.is_some() { "" } else { " hidden" },
        detail.map(escape_html).unwrap_or_default(),
        escape_html(footnote)
    )
}

fn document(title: &str, body: &str, script: Option<&str>) -> String {
    let styles = STYLES
        .replace("${LIGHT_VARS}", LIGHT_VARS)
        .replace("${DARK_VARS}", DARK_VARS);
    format!(
        r#"<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex" />
    <title>{} · YCoding</title>
    <style>{styles}</style>
  </head>
  <body>
    {body}{}
  </body>
</html>"#,
        escape_html(title),
        script
            .map(|script| format!("\n    <script>{script}</script>"))
            .unwrap_or_default()
    )
}
fn script_string(value: &str) -> String {
    serde_json::to_string(value)
        .expect("string serialization")
        .replace('<', "\\u003c")
}
fn escape_html(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

const AUTO_CLOSE: &str = "setTimeout(function(){try{window.close()}catch(e){}},2500)";
const BOOTSTRAP: &str = r#"(function(){
  var card=document.getElementById("oc-card"),headline=document.getElementById("oc-headline"),message=document.getElementById("oc-message"),detail=document.getElementById("oc-detail"),footnote=document.getElementById("oc-footnote");
  function fail(text){card.dataset.status="error";headline.textContent="Authorization failed";message.textContent=PROVIDER?("YCoding couldn't finish connecting to "+PROVIDER+"."):"YCoding couldn't complete authorization.";if(text){detail.textContent=text;detail.hidden=false}footnote.textContent="Close this window and try again from YCoding."}
  function ok(){card.dataset.status="success";headline.textContent="Authorization successful";message.textContent=PROVIDER?("YCoding is now connected to "+PROVIDER+"."):"YCoding is now authorized.";detail.hidden=true;footnote.textContent="You can close this window.";setTimeout(function(){try{window.close()}catch(e){}},2500)}
  try{
    var hash=new URLSearchParams((window.location.hash||"").slice(1));
    var search=new URLSearchParams(window.location.search||"");
    var err=hash.get("error")||search.get("error");
    var errDescription=hash.get("error_description")||search.get("error_description");
    var body=err?{error:err,error_description:errDescription||""}:{access_token:hash.get("access_token")||"",expires_in:hash.get("expires_in")||"0",state:hash.get("state")||""};
    fetch(TOKEN_URL,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)}).then(function(res){
      if(!res.ok)return res.text().catch(function(){return""}).then(function(t){throw new Error(t||("callback failed ("+res.status+")"))});
      if(err){fail(errDescription||err);return}
      ok();
    }).catch(function(e){fail(String(e&&e.message?e.message:e))});
  }catch(e){fail(String(e&&e.message?e.message:e))}
})()"#;
const LIGHT_VARS: &str = r#"
    --oc-bg: #f8f8f8;
    --oc-card: #fcfcfc;
    --oc-text-strong: #171717;
    --oc-text-base: #6f6f6f;
    --oc-text-weak: #8f8f8f;
    --oc-border-weak: #e5e5e5;
    --oc-success: #2dba26;
    --oc-error: #ed4831;
    --oc-detail-bg: #fff8f6;
    --oc-detail-border: #fdc3b7;
    --oc-shadow: 0 16px 48px -6px rgba(0,0,0,.10), 0 6px 12px -2px rgba(0,0,0,.05), 0 1px 2px rgba(0,0,0,.06);"#;
const DARK_VARS: &str = r#"
    --oc-bg: #101010;
    --oc-card: #161616;
    --oc-text-strong: rgba(255,255,255,.936);
    --oc-text-base: rgba(255,255,255,.618);
    --oc-text-weak: rgba(255,255,255,.422);
    --oc-border-weak: #282828;
    --oc-success: #12c905;
    --oc-error: #fc533a;
    --oc-detail-bg: #28110c;
    --oc-detail-border: #6a1206;
    --oc-shadow: 0 16px 48px -6px rgba(0,0,0,.55), 0 6px 12px -2px rgba(0,0,0,.35), 0 1px 2px rgba(0,0,0,.4);"#;
const STYLES: &str = r#"
  :root { color-scheme: light dark;${LIGHT_VARS}
    --oc-font-sans: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    --oc-font-mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
  }
  @media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) {${DARK_VARS} } }
  :root[data-theme="dark"] {${DARK_VARS} }
  :root[data-theme="light"] {${LIGHT_VARS} }

  * { box-sizing: border-box; }
  html, body { margin: 0; height: 100%; }
  body {
    min-height: 100vh;
    display: grid;
    place-items: center;
    padding: 24px;
    background: var(--oc-bg);
    color: var(--oc-text-base);
    font-family: var(--oc-font-sans);
    line-height: 1.5;
    -webkit-font-smoothing: antialiased;
    text-rendering: optimizeLegibility;
  }
  .card {
    width: min(100%, 28rem);
    padding: 2.25rem 2rem 1.75rem;
    background: var(--oc-card);
    border: 1px solid var(--oc-border-weak);
    border-radius: 14px;
    box-shadow: var(--oc-shadow);
    text-align: center;
  }
  .brand { display: flex; align-items: center; justify-content: center; gap: 0.5rem; margin-bottom: 1.75rem; color: var(--oc-text-strong); font-family: var(--oc-font-mono); font-size: 1.375rem; font-weight: 600; }
  .brand svg { height: 36px; width: 36px; flex-shrink: 0; }
  .status { display: flex; justify-content: center; margin-bottom: 1.125rem; }
  .icon { display: none; line-height: 0; }
  .icon svg { display: block; }
  .card[data-status="pending"] .icon-pending,
  .card[data-status="success"] .icon-success,
  .card[data-status="error"] .icon-error { display: block; }
  .icon-success { color: var(--oc-success); }
  .icon-error { color: var(--oc-error); }
  .icon-pending { color: var(--oc-text-weak); }
  .headline { margin: 0; font-size: 1.1875rem; font-weight: 500; line-height: 1.3; letter-spacing: -0.012em; color: var(--oc-text-strong); }
  .message { margin: 0.5rem 0 0; font-size: 0.9375rem; color: var(--oc-text-base); }
  .detail {
    margin: 1.25rem 0 0;
    padding: 0.75rem 0.875rem;
    text-align: left;
    font-family: var(--oc-font-mono);
    font-size: 0.8125rem;
    line-height: 1.55;
    color: var(--oc-text-strong);
    background: var(--oc-detail-bg);
    border: 1px solid var(--oc-detail-border);
    border-radius: 8px;
    white-space: pre-wrap;
    word-break: break-word;
    max-height: 9.5rem;
    overflow: auto;
  }
  .detail[hidden] { display: none; }
  .footnote { margin: 1.5rem 0 0; font-size: 0.8125rem; color: var(--oc-text-weak); }
  .spinner { animation: oc-spin 0.8s linear infinite; transform-origin: center; }
  @keyframes oc-spin { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { .spinner { animation: none; } }
"#;
const WORDMARK: &str = r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" fill="none" aria-hidden="true">
        <path d="M40 40h32v64H40zm144 0h32v64h-32zM40 112h64v64H72v-32H40zm112 0h64v32h-32v32h-32zm-40 72h32v32h-32z" fill="#67D7A4"/>
      </svg><span>YCoding</span>"##;
const ICON_CHECK: &str = r#"<svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9" /><path d="m8.5 12.5 2.4 2.4 4.6-5.4" /></svg>"#;
const ICON_CROSS: &str = r#"<svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9" /><path d="m9 9 6 6m0-6-6 6" /></svg>"#;
const ICON_SPINNER: &str = r#"<svg class="spinner" viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9" opacity="0.2" /><path d="M21 12a9 9 0 0 0-9-9" /></svg>"#;
