use ycoding_schema::{
    DomainEncode, JsonValue, LosslessString, ObjectEncoder, browser, parse_json, stringify_json,
};

pub struct Identity {
    pub digest: String,
    pub reusable: bool,
}

pub fn digest(value: &JsonValue) -> String {
    ring::digest::digest(&ring::digest::SHA256, stringify_json(value).as_bytes())
        .as_ref()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

pub fn element_identity(
    url: &LosslessString,
    element: &browser::Element,
    destination: Option<&LosslessString>,
) -> String {
    digest(
        &ObjectEncoder::new()
            .field("url", url)
            .field("role", &element.role)
            .field("name", &element.name)
            .field(
                "description",
                element.description.as_ref().unwrap_or(&"".into()),
            )
            .field("disabled", &element.disabled.unwrap_or(false))
            .optional(
                "destination",
                &destination
                    .cloned()
                    .map(JsonValue::String)
                    .or_else(|| element.destination.as_ref().map(DomainEncode::encode)),
            )
            .optional("frame", &element.frame)
            .finish(),
    )
}

pub struct Classification {
    pub permission: &'static str,
    pub mutation: bool,
    pub element: bool,
}

pub fn classify(action: &browser::Action) -> Classification {
    match action {
        browser::Action::Navigate(_) => Classification {
            permission: "browser_navigate",
            mutation: true,
            element: false,
        },
        browser::Action::Group(_)
        | browser::Action::Ungroup(_)
        | browser::Action::GroupControl(_) => Classification {
            permission: "browser_control",
            mutation: true,
            element: false,
        },
        browser::Action::Dialog(dialog) => Classification {
            permission: if dialog.accept.is_none() {
                "browser_read"
            } else {
                "browser_interact"
            },
            mutation: true,
            element: false,
        },
        browser::Action::Scroll(_)
        | browser::Action::Capture(_)
        | browser::Action::Wait(_)
        | browser::Action::ClipboardRead(_)
        | browser::Action::Download(_)
        | browser::Action::Logs(_)
        | browser::Action::Export(_)
        | browser::Action::WebMcpList(_) => Classification {
            permission: "browser_read",
            mutation: false,
            element: false,
        },
        action => Classification {
            permission: "browser_interact",
            mutation: true,
            element: is_element_action(action),
        },
    }
}

pub fn is_element_action(action: &browser::Action) -> bool {
    matches!(
        action,
        browser::Action::Click(_)
            | browser::Action::Type(_)
            | browser::Action::Upload(_)
            | browser::Action::Fill(_)
            | browser::Action::Select(_)
            | browser::Action::Check(_)
            | browser::Action::Hover(_)
    )
}

pub struct ParsedLocator {
    pub role: String,
    pub name: String,
    pub nth: usize,
}

pub fn parse_locator(locator: &str) -> Option<ParsedLocator> {
    let rest = locator.strip_prefix("role=")?;
    let open = rest.find("[name=\"")?;
    let role = &rest[..open];
    if role.is_empty() || role.chars().count() > 64 || role.contains(['[', ']', '|']) {
        return None;
    }
    let name_start = open + "[name=".len();
    let quoted = &rest[name_start..];
    if !quoted.starts_with('"') {
        return None;
    }
    let mut end = None;
    let mut escaped = false;
    for (index, character) in quoted.char_indices().skip(1) {
        if escaped {
            escaped = false;
            continue;
        }
        if character == '\\' {
            escaped = true;
        } else if character == '"' {
            end = Some(index);
            break;
        }
    }
    let end = end?;
    let literal = &quoted[..=end];
    let name = match parse_json(literal) {
        Ok(JsonValue::String(value)) => value.to_utf8().ok()?,
        _ => return None,
    };
    let tail = &quoted[end + 1..];
    if tail == "]" {
        return Some(ParsedLocator {
            role: role.into(),
            name,
            nth: 0,
        });
    }
    let nth = tail.strip_prefix("]|nth=")?;
    if nth.is_empty()
        || nth.len() > 4
        || nth.starts_with('0')
        || !nth.bytes().all(|byte| byte.is_ascii_digit())
    {
        return None;
    }
    Some(ParsedLocator {
        role: role.into(),
        name,
        nth: nth.parse().ok()?,
    })
}

pub fn locator_name_matches(name: &str, accessible_name: &LosslessString) -> bool {
    let prefix: Vec<u16> = accessible_name.code_units().take(128).collect();
    String::from_utf16_lossy(&prefix) == name
}

pub fn same_element_state(left: &browser::Element, right: &browser::Element) -> bool {
    left.checked == right.checked
        && left.pressed == right.pressed
        && left.expanded == right.expanded
        && left.selected == right.selected
        && left.value == right.value
        && left.sensitive == right.sensitive
}

pub fn sanitize_control(control: browser::ControlState) -> browser::ControlState {
    if control.sensitive == Some(true) {
        return browser::ControlState {
            checked: None,
            value: None,
            selected: None,
            sensitive: Some(true),
        };
    }
    browser::ControlState {
        checked: control.checked,
        value: control
            .value
            .map(|value| super::payload::bounded(value, browser::MAX_NAME_LENGTH)),
        selected: control.selected.map(|selected| {
            selected
                .into_iter()
                .filter(|option| option.index.get() >= 0)
                .take(browser::MAX_SELECT_OPTIONS)
                .map(|option| browser::SelectedOption {
                    value: option
                        .value
                        .map(|value| super::payload::bounded(value, browser::MAX_NAME_LENGTH)),
                    label: super::payload::bounded(option.label, browser::MAX_NAME_LENGTH),
                    index: option.index,
                })
                .collect()
        }),
        sensitive: None,
    }
}

pub fn wait_budget_ms(action: &browser::Action) -> u64 {
    match action {
        browser::Action::Wait(wait) => wait.timeout_ms.map_or(5_000, |value| value.get()) as u64,
        browser::Action::Download(download) => {
            download.timeout_ms.map_or(30_000, |value| value.get()) as u64
        }
        _ => 0,
    }
}

pub fn make_locator(
    role: &LosslessString,
    name: &LosslessString,
    nth: Option<usize>,
) -> LosslessString {
    let truncated = LosslessString::from_utf16(name.code_units().take(128).collect());
    let base = format!(
        "role={}[name={}]",
        role.to_utf8().unwrap_or_default(),
        stringify_json(&truncated.encode())
    );
    match nth {
        Some(nth) => format!("{base}|nth={nth}").into(),
        None => base.into(),
    }
}

pub fn target_refs(
    action: &browser::Action,
) -> Option<(Option<&LosslessString>, Option<&LosslessString>)> {
    match action {
        browser::Action::Click(action) => Some((action.r#ref.as_ref(), action.locator.as_ref())),
        browser::Action::Type(action) => Some((action.r#ref.as_ref(), action.locator.as_ref())),
        browser::Action::Fill(action) => Some((action.r#ref.as_ref(), action.locator.as_ref())),
        browser::Action::Select(action) => Some((action.r#ref.as_ref(), action.locator.as_ref())),
        browser::Action::Check(action) => Some((action.r#ref.as_ref(), action.locator.as_ref())),
        browser::Action::Hover(action) => Some((action.r#ref.as_ref(), action.locator.as_ref())),
        browser::Action::Upload(action) => Some((action.r#ref.as_ref(), action.locator.as_ref())),
        browser::Action::Wait(action) => Some((action.r#ref.as_ref(), action.locator.as_ref())),
        _ => None,
    }
}

pub fn resolve_element<'a>(
    elements: impl Iterator<Item = &'a browser::Element>,
    reference: Option<&LosslessString>,
    locator: Option<&LosslessString>,
) -> Option<&'a browser::Element> {
    let elements: Vec<_> = elements.collect();
    if let Some(reference) = reference
        && let Some(element) = elements.iter().find(|element| &element.r#ref == reference)
    {
        return Some(element);
    }
    let locator = locator.or(reference)?;
    elements
        .into_iter()
        .find(|element| element.locator.as_ref() == Some(locator))
}

pub fn with_reference(action: &browser::Action, reference: LosslessString) -> browser::Action {
    match action {
        browser::Action::Click(_) => browser::Action::Click(browser::Click {
            r#ref: Some(reference),
            locator: None,
        }),
        browser::Action::Type(action) => browser::Action::Type(browser::Type {
            r#ref: Some(reference),
            locator: None,
            text: action.text.clone(),
        }),
        browser::Action::Fill(action) => browser::Action::Fill(browser::Fill {
            r#ref: Some(reference),
            locator: None,
            text: action.text.clone(),
        }),
        browser::Action::Select(action) => browser::Action::Select(browser::Select {
            r#ref: Some(reference),
            locator: None,
            values: action.values.clone(),
            labels: action.labels.clone(),
            indexes: action.indexes.clone(),
        }),
        browser::Action::Check(action) => browser::Action::Check(browser::Check {
            r#ref: Some(reference),
            locator: None,
            checked: action.checked,
        }),
        browser::Action::Hover(_) => browser::Action::Hover(browser::Hover {
            r#ref: Some(reference),
            locator: None,
        }),
        browser::Action::Upload(action) => browser::Action::Upload(browser::Upload {
            r#ref: Some(reference),
            locator: None,
            paths: action.paths.clone(),
        }),
        other => other.clone(),
    }
}

pub fn resolve_target(
    action: &browser::Action,
    elements: &[browser::Element],
) -> Result<browser::Action, String> {
    if !matches!(action, browser::Action::Wait(_)) && !is_element_action(action) {
        return Ok(action.clone());
    }
    let Some((reference, locator)) = target_refs(action) else {
        return Ok(action.clone());
    };
    if let Some(locator) = locator
        && parse_locator(
            &locator
                .to_utf8()
                .map_err(|_| "Locator is malformed".to_string())?,
        )
        .is_none()
    {
        return Err("Locator is malformed".into());
    }
    if let browser::Action::Wait(wait) = action {
        if wait.r#ref.is_none() {
            return Ok(action.clone());
        }
        return Ok(browser::Action::Wait(browser::Wait {
            locator: None,
            ..wait.clone()
        }));
    }
    let element = resolve_element(elements.iter(), reference, locator)
        .ok_or_else(|| "Semantic element reference is stale".to_string())?;
    if element.disabled == Some(true) {
        return Err("Semantic element is disabled".into());
    }
    Ok(with_reference(action, element.r#ref.clone()))
}

fn target_payload(action: &browser::Action) -> Option<JsonValue> {
    match action {
        browser::Action::Click(_) | browser::Action::Hover(_) => {
            Some(ObjectEncoder::new().field("type", kind(action)).finish())
        }
        browser::Action::Type(action) => Some(
            ObjectEncoder::new()
                .field("type", "type")
                .field("text", &action.text)
                .finish(),
        ),
        browser::Action::Fill(action) => Some(
            ObjectEncoder::new()
                .field("type", "fill")
                .field("text", &action.text)
                .finish(),
        ),
        browser::Action::Select(action) => Some(
            ObjectEncoder::new()
                .field("type", "select")
                .optional("values", &action.values)
                .optional("labels", &action.labels)
                .optional("indexes", &action.indexes)
                .finish(),
        ),
        browser::Action::Check(action) => Some(
            ObjectEncoder::new()
                .field("type", "check")
                .field("checked", &action.checked)
                .finish(),
        ),
        _ => None,
    }
}

pub fn identity(
    tab: &browser::Tab,
    page_identity: &str,
    action: &browser::Action,
    elements: &[(browser::Element, String)],
) -> Result<Identity, String> {
    let (action_value, reusable) = if let Some(payload) = target_payload(action) {
        let (reference, locator) = target_refs(action).unwrap_or((None, None));
        let Some(element) = resolve_element(
            elements.iter().map(|(element, _)| element),
            reference,
            locator,
        )
        .filter(|element| element.disabled != Some(true)) else {
            return Err("Semantic element reference is stale or disabled".into());
        };
        let target = elements
            .iter()
            .find(|(candidate, _)| candidate.r#ref == element.r#ref)
            .map(|(_, identity)| identity.clone())
            .unwrap_or_default();
        let mut object = match payload {
            JsonValue::Object(object) => object,
            _ => Default::default(),
        };
        object.insert("target".into(), JsonValue::String(target.clone().into()));
        (
            JsonValue::Object(object),
            elements
                .iter()
                .filter(|(_, identity)| *identity == target)
                .count()
                == 1,
        )
    } else {
        (action.encode(), true)
    };
    Ok(Identity {
        reusable,
        digest: digest(
            &ObjectEncoder::new()
                .field("tabID", &tab.id)
                .field(
                    "mode",
                    if tab.mode == Some(browser::Mode::Owned) {
                        "owned"
                    } else if tab.mode == Some(browser::Mode::Profile) {
                        "profile"
                    } else {
                        "isolated"
                    },
                )
                .field("page", page_identity)
                .field("action", &action_value)
                .finish(),
        ),
    })
}

pub fn reference(action: &browser::Action) -> Option<&LosslessString> {
    target_refs(action).and_then(|(reference, _)| reference)
}

pub fn mutation(action: &browser::Action) -> bool {
    classify(action).mutation
}

pub fn kind(action: &browser::Action) -> &'static str {
    match action {
        browser::Action::Navigate(_) => "navigate",
        browser::Action::Click(_) => "click",
        browser::Action::Type(_) => "type",
        browser::Action::Fill(_) => "fill",
        browser::Action::Select(_) => "select",
        browser::Action::Check(_) => "check",
        browser::Action::Hover(_) => "hover",
        browser::Action::Scroll(_) => "scroll",
        browser::Action::Capture(_) => "capture",
        browser::Action::Group(_) => "group",
        browser::Action::Ungroup(_) => "ungroup",
        browser::Action::GroupControl(_) => "group_control",
        browser::Action::Back(_) => "back",
        browser::Action::Forward(_) => "forward",
        browser::Action::Reload(_) => "reload",
        browser::Action::Key(_) => "key",
        browser::Action::Wait(_) => "wait",
        browser::Action::ClipboardRead(_) => "clipboard_read",
        browser::Action::ClipboardWrite(_) => "clipboard_write",
        browser::Action::Upload(_) => "upload",
        browser::Action::Download(_) => "download",
        browser::Action::Logs(_) => "logs",
        browser::Action::Export(_) => "export",
        browser::Action::WebMcpList(_) => "webmcp_list",
        browser::Action::WebMcpInvoke(_) => "webmcp_invoke",
        browser::Action::Dialog(_) => "dialog",
    }
}
