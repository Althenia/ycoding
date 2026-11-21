use std::collections::HashMap;

pub const SECRET_AUTOCOMPLETE: [&str; 8] = [
    "current-password",
    "new-password",
    "one-time-code",
    "cc-number",
    "cc-csc",
    "cc-exp",
    "cc-exp-month",
    "cc-exp-year",
];

fn separated(left: &str, right: &str, text: &str) -> bool {
    let mut offset = 0;
    while let Some(found) = text[offset..].find(left) {
        let after = &text[offset + found + left.len()..];
        if after.starts_with(right)
            || after
                .strip_prefix([' ', '\t', '\n', '\r', '_', '-'])
                .is_some_and(|rest| rest.starts_with(right))
        {
            return true;
        }
        offset += found + left.len();
    }
    false
}

fn secret_name(text: &str) -> bool {
    let lower = text.to_lowercase();
    if lower.contains("password")
        || lower.contains("passcode")
        || lower.contains("passphrase")
        || separated("one", "time", &lower)
        || separated("verification", "code", &lower)
        || separated("security", "code", &lower)
        || separated("card", "number", &lower)
        || separated("card", "no", &lower)
    {
        return true;
    }
    if lower.match_indices("secret").any(|(index, _)| {
        let rest = &lower[index + "secret".len()..];
        let rest = rest.strip_prefix('s').unwrap_or(rest);
        !rest.as_bytes().first().is_some_and(u8::is_ascii_lowercase)
    }) {
        return true;
    }
    let bytes = lower.as_bytes();
    for token in [
        "otp", "totp", "mfa", "2fa", "pin", "cvv", "cvc", "csc", "ccnum",
    ] {
        let token = token.as_bytes();
        for start in 0..bytes.len().saturating_sub(token.len() - 1) {
            if &bytes[start..start + token.len()] != token {
                continue;
            }
            let before = start == 0 || !bytes[start - 1].is_ascii_alphanumeric();
            let after_index = start + token.len();
            let after = after_index >= bytes.len() || !bytes[after_index].is_ascii_alphanumeric();
            if before && after {
                return true;
            }
        }
    }
    false
}

pub fn is_sensitive_attributes(
    node_name: &str,
    attributes: &HashMap<String, String>,
    accessible_name: &str,
) -> bool {
    if !is_editable_field(node_name, attributes) {
        return false;
    }
    let tag = node_name.to_lowercase();
    if tag == "input"
        && attributes
            .get("type")
            .map_or("text", String::as_str)
            .eq_ignore_ascii_case("password")
    {
        return true;
    }
    if attributes
        .get("autocomplete")
        .map_or("", String::as_str)
        .to_lowercase()
        .split_whitespace()
        .any(|token| SECRET_AUTOCOMPLETE.contains(&token))
    {
        return true;
    }
    if ["name", "id", "aria-label", "placeholder"]
        .iter()
        .any(|key| secret_name(attributes.get(*key).map_or("", String::as_str)))
    {
        return true;
    }
    let normalized: String = accessible_name
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    secret_name(&normalized.chars().take(256).collect::<String>())
}

pub fn is_editable_field(node_name: &str, attributes: &HashMap<String, String>) -> bool {
    node_name.eq_ignore_ascii_case("input")
        || node_name.eq_ignore_ascii_case("textarea")
        || attributes
            .get("contenteditable")
            .is_some_and(|value| value != "false")
}

pub fn is_safe_navigation_key(key: &str, modifiers: &[String]) -> bool {
    if key == "Tab" {
        return modifiers.is_empty() || (modifiers.len() == 1 && modifiers[0] == "Shift");
    }
    modifiers.is_empty()
        && [
            "Escape",
            "ArrowUp",
            "ArrowDown",
            "ArrowLeft",
            "ArrowRight",
            "Home",
            "End",
            "PageUp",
            "PageDown",
        ]
        .contains(&key)
}

pub fn refuses_editing_key(
    sensitive: Option<bool>,
    closed_shadow_root: Option<bool>,
    unreachable_inspected: Option<Option<bool>>,
) -> bool {
    if sensitive != Some(false) || closed_shadow_root != Some(false) {
        return true;
    }
    match unreachable_inspected {
        None | Some(None) => false,
        Some(Some(inspected)) => !inspected,
    }
}

pub fn glob_match(pattern: &str, value: &str) -> bool {
    let pattern: Vec<char> = pattern.chars().collect();
    let value: Vec<char> = value.chars().collect();
    let (mut p, mut v) = (0, 0);
    let (mut star, mut mark) = (None, 0);
    while v < value.len() {
        if p < pattern.len() && pattern[p] != '*' && pattern[p] == value[v] {
            p += 1;
            v += 1;
        } else if p < pattern.len() && pattern[p] == '*' {
            star = Some(p);
            p += 1;
            mark = v;
        } else if let Some(star) = star {
            p = star + 1;
            mark += 1;
            v = mark;
        } else {
            return false;
        }
    }
    while p < pattern.len() && pattern[p] == '*' {
        p += 1;
    }
    p == pattern.len()
}

const SECRET_NAME_JS: &str = r"/pass(?:word|code|phrase)|one[\s_-]?time|verification[\s_-]?code|security[\s_-]?code|card[\s_-]?(?:number|no)|secrets?(?![a-z])|(?:^|[^a-z0-9])(?:otp|totp|mfa|2fa|pin|cvv|cvc|csc|ccnum)(?:$|[^a-z0-9])/i";

fn is_sensitive_js() -> String {
    format!(
        r#"const isSensitive = (el) => {{
  const tag = el.localName
  if (tag !== "input" && tag !== "textarea" && !el.isContentEditable) return false
  if (tag === "input" && el.type === "password") return true
  if ((el.getAttribute("autocomplete") || "").toLowerCase().split(/\s+/).some((token) => ["current-password","new-password","one-time-code","cc-number","cc-csc","cc-exp","cc-exp-month","cc-exp-year"].includes(token))) return true
  if (["name", "id", "aria-label", "placeholder"].some((key) => {pattern}.test(el.getAttribute(key) || ""))) return true
  const labels = [...(el.labels || [])]
  for (const id of (el.getAttribute("aria-labelledby") || "").split(/\s+/)) {{
    const referenced = id ? el.ownerDocument.getElementById(id) : null
    if (referenced) labels.push(referenced)
  }}
  return labels.some((label) => {pattern}.test(String(label.textContent).replace(/\s+/g, " ").trim().slice(0, 256)))
}}"#,
        pattern = SECRET_NAME_JS
    )
}

pub fn f_control_state() -> String {
    format!(
        r#"function () {{ {}
  const el = this
  if (isSensitive(el)) return {{ sensitive: true }}
  if (el.localName === "select") return {{ selected: [...el.selectedOptions].slice(0, 32).map((o) => ({{ value: o.value.slice(0, 1024), label: (o.label || o.text).trim().slice(0, 1024), index: o.index }})) }}
  if (el.localName === "input" && (el.type === "checkbox" || el.type === "radio")) return {{ checked: el.indeterminate ? "mixed" : el.checked }}
  if (el.localName === "input" || el.localName === "textarea") return {{ value: String(el.value).slice(0, 1024) }}
  if (el.isContentEditable) return {{ value: String(el.innerText).slice(0, 1024) }}
  return {{}}
}}"#,
        is_sensitive_js()
    )
}

pub fn f_fill() -> String {
    format!(
        r#"function (text, apply) {{ {}
  const el = this
  if (isSensitive(el)) return {{ error: "Sensitive fields cannot be filled" }}
  const setTypes = ["color", "date", "datetime-local", "month", "range", "time", "week"]
  const textTypes = ["email", "number", "search", "tel", "text", "url"]
  const input = el.localName === "input", area = el.localName === "textarea"
  if ((input || area) && (el.disabled || el.readOnly)) return {{ error: "Field is not editable" }}
  const kind = input ? (setTypes.includes(el.type) ? "set" : textTypes.includes(el.type) ? "insert" : undefined) : area || el.isContentEditable ? "insert" : undefined
  if (!kind) return {{ error: "Element cannot be filled" }}
  if (!apply) return {{ kind }}
  el.focus()
  if (kind === "set") {{
    el.value = text
    if (el.value !== text) return {{ error: "Field rejected the value" }}
    el.dispatchEvent(new Event("input", {{ bubbles: true, composed: true }}))
    el.dispatchEvent(new Event("change", {{ bubbles: true }}))
    return {{ kind }}
  }}
  if (input || area) el.select()
  else {{ const range = el.ownerDocument.createRange(); range.selectNodeContents(el); const selection = el.ownerDocument.getSelection(); selection.removeAllRanges(); selection.addRange(range) }}
  return {{ kind }}
}}"#,
        is_sensitive_js()
    )
}

pub const F_SELECT: &str = r#"function (criteria, apply) {
  const el = this
  if (el.localName !== "select") return { error: "Element is not a select" }
  if (el.disabled) return { error: "Select is disabled" }
  const options = [...el.options], picked = []
  const lists = [["value", criteria.values], ["label", criteria.labels], ["index", criteria.indexes]]
  for (const [kind, list] of lists) for (const wanted of list || []) {
    const option = options.find((candidate) => kind === "value" ? candidate.value === wanted : kind === "label" ? (candidate.label || candidate.text).trim() === String(wanted).trim() : candidate.index === wanted)
    if (!option) return { error: "Option not found" }
    if (option.disabled) return { error: "Option is disabled" }
    if (!picked.includes(option)) picked.push(option)
  }
  if (picked.length > 1 && !el.multiple) return { error: "Select accepts one option" }
  if (!apply) return { ok: true }
  for (const option of options) option.selected = picked.includes(option)
  el.dispatchEvent(new Event("input", { bubbles: true, composed: true }))
  el.dispatchEvent(new Event("change", { bubbles: true }))
  return { ok: true }
}"#;

pub const F_ACTIVE_ELEMENT: &str = r#"function () {
  let el = document.activeElement
  while (el) {
    if (el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement
    else if (el.contentDocument && el.contentDocument.activeElement) el = el.contentDocument.activeElement
    else break
  }
  return el
}"#;

pub fn f_refuse_field() -> String {
    format!(
        r#"function () {{ {}
  const el = this
  return (el.localName === "input" && el.type === "file") || isSensitive(el)
}}"#,
        is_sensitive_js()
    )
}

pub const F_FRAME_UNREACHABLE: &str = r#"function () {
  const el = this
  return ["iframe", "frame", "object", "embed"].includes(el.localName)
}"#;

const HIT_TEST: &str = r#"const hitTestable = (el) => {
  const box = el.getBoundingClientRect()
  const view = el.ownerDocument.defaultView
  const x = box.left + box.width / 2, y = box.top + box.height / 2
  if (!view || box.width <= 0 || box.height <= 0 || x < 0 || y < 0 || x >= view.innerWidth || y >= view.innerHeight) return false
  const hit = el.ownerDocument.elementFromPoint(x, y)
  return Boolean(hit && el.contains(hit))
}"#;

pub fn f_popup_rows() -> String {
    format!(
        r#"function (limit, nodes, visits) {{ {HIT_TEST}
  const container = this
  const interactive = "a[href],button,input,select,textarea,summary,iframe,frame,object,embed,[contenteditable]:not([contenteditable='false']),[role=button],[role=checkbox],[role=combobox],[role=link],[role=listbox],[role=menuitem],[role=menuitemcheckbox],[role=menuitemradio],[role=option],[role=radio],[role=searchbox],[role=slider],[role=spinbutton],[role=switch],[role=tab],[role=textbox]"
  const view = container.ownerDocument.defaultView
  const pointer = (el) => view.getComputedStyle(el).cursor === "pointer"
  const plain = (el) => {{
    const inner = el.ownerDocument.createTreeWalker(el, NodeFilter.SHOW_ELEMENT)
    let count = 0
    for (let node = inner.nextNode(); node; node = inner.nextNode()) if (++count >= nodes || node.matches(interactive)) return false
    return true
  }}
  const walker = container.ownerDocument.createTreeWalker(container, NodeFilter.SHOW_ELEMENT)
  const rows = []
  let visited = 0
  for (let el = walker.nextNode(); el; el = walker.nextNode()) {{
    if (++visited > visits) return {{ rows, truncated: true }}
    if (!pointer(el) || (el.parentElement !== container && pointer(el.parentElement))) continue
    const owner = el.closest(interactive)
    if ((owner && owner !== container && container.contains(owner)) || el.closest("[aria-hidden=true],[inert]")) continue
    if (!plain(el) || !String(el.innerText).replace(/\s+/g, " ").trim() || !hitTestable(el)) continue
    if (rows.length >= limit) return {{ rows, truncated: true }}
    rows.push(el)
  }}
  return {{ rows, truncated: false }}
}}"#
    )
}

pub const F_ROW_NAME: &str =
    r#"function () { return String(this.innerText).replace(/\s+/g, " ").trim().slice(0, 1024) }"#;

pub fn f_hit_testable() -> String {
    format!("function () {{ {HIT_TEST}\n  return this.isConnected && hitTestable(this)\n}}")
}

pub const F_CONNECTED: &str = "function () { return this.isConnected }";
pub const F_READY: &str = "function () { return document.readyState }";
pub const F_TEXT_PRESENT: &str = r#"function (needle) {
  const normalize = (value) => String(value).replace(/\s+/g, " ").trim()
  return normalize(document.body ? document.body.innerText : "").includes(normalize(needle))
}"#;

#[cfg(test)]
mod tests {
    use super::{is_editable_field, is_sensitive_attributes};
    use std::collections::HashMap;

    #[test]
    fn secret_names_are_limited_to_editable_fields_and_keep_account_codes_ordinary() {
        for name in [
            "client_secret",
            "apiSecret",
            "Shared secrets",
            "Password",
            "One-time code",
        ] {
            assert!(
                is_sensitive_attributes("input", &HashMap::new(), name),
                "{name}"
            );
            assert!(
                !is_sensitive_attributes("button", &HashMap::new(), name),
                "{name}"
            );
            for attribute in ["name", "id", "aria-label", "placeholder"] {
                let attributes = HashMap::from([(attribute.into(), name.into())]);
                assert!(
                    is_sensitive_attributes("input", &attributes, ""),
                    "{attribute}: {name}"
                );
            }
        }
        for name in [
            "Account Code",
            "Secretary name",
            "shipping address",
            "spinning",
        ] {
            assert!(
                !is_sensitive_attributes("input", &HashMap::new(), name),
                "{name}"
            );
        }
        for (tag, attributes, expected) in [
            ("INPUT", HashMap::new(), true),
            ("textarea", HashMap::new(), true),
            (
                "div",
                HashMap::from([("contenteditable".into(), String::new())]),
                true,
            ),
            (
                "div",
                HashMap::from([("contenteditable".into(), "false".into())]),
                false,
            ),
            ("body", HashMap::new(), false),
            (
                "div",
                HashMap::from([("role".into(), "option".into())]),
                false,
            ),
        ] {
            assert_eq!(is_editable_field(tag, &attributes), expected, "{tag}");
        }
    }
}
