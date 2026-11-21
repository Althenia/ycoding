use super::bridge::{Error, safe_page};
use ycoding_schema::{
    DomainDecode, JsonPath, JsonValue, LosslessString, ObjectDecoder, ObjectEncoder, browser,
    schema::NonNegativeInt,
};

pub fn bounded(value: LosslessString, limit: usize) -> LosslessString {
    if value.len() <= limit {
        value
    } else {
        LosslessString::from_utf16(value.code_units().take(limit).collect())
    }
}

pub fn bytes(value: LosslessString, limit: usize) -> LosslessString {
    let mut count = 0;
    let mut output = Vec::new();
    let mut units = value.code_units().peekable();
    while let Some(unit) = units.next() {
        let pair = (0xd800..=0xdbff).contains(&unit)
            && units
                .peek()
                .is_some_and(|next| (0xdc00..=0xdfff).contains(next));
        let length = if pair {
            4
        } else if unit <= 0x7f {
            1
        } else if unit <= 0x7ff {
            2
        } else {
            3
        };
        if count + length > limit {
            break;
        }
        count += length;
        output.push(unit);
        if pair {
            output.push(units.next().unwrap());
        }
    }
    LosslessString::from_utf16(output)
}

pub fn page(object: &ObjectDecoder<'_>, name: &str) -> Result<Option<browser::Page>, Error> {
    Ok(object
        .optional::<LosslessString>(name)?
        .and_then(|url| safe_page(&url).ok()))
}

pub fn texts(raw: Option<Vec<JsonValue>>) -> Result<Option<Vec<browser::Text>>, Error> {
    raw.map(|items| {
        items
            .iter()
            .take(browser::MAX_OBSERVATION_TEXTS)
            .map(|item| {
                let path = JsonPath::default();
                let object = ObjectDecoder::new(item, &path)?;
                Ok(browser::Text {
                    role: bounded(object.field("role")?, 64),
                    name: bounded(object.field("name")?, browser::MAX_NAME_LENGTH),
                    frame: page(&object, "frame")?,
                })
            })
            .collect()
    })
    .transpose()
}

pub fn frames(raw: Option<Vec<JsonValue>>) -> Result<Option<Vec<browser::Frame>>, Error> {
    raw.map(|items| {
        items
            .iter()
            .take(browser::MAX_OBSERVATION_FRAMES)
            .map(|item| {
                let path = JsonPath::default();
                let object = ObjectDecoder::new(item, &path)?;
                page(&object, "url")?
                    .map(|page| {
                        Ok::<_, Error>(browser::Frame {
                            page,
                            observed: object.field("observed")?,
                        })
                    })
                    .transpose()
            })
            .collect::<Result<Vec<_>, Error>>()
            .map(|items| items.into_iter().flatten().collect())
    })
    .transpose()
}

pub fn dialog(object: &ObjectDecoder<'_>) -> Result<Option<browser::DialogInfo>, Error> {
    let Some(raw) = object.optional::<JsonValue>("dialog")? else {
        return Ok(None);
    };
    let path = JsonPath::default();
    let dialog = ObjectDecoder::new(&raw, &path)?;
    let kind: LosslessString = dialog.field("kind")?;
    let kind = match kind.as_str() {
        Some("alert") => browser::DialogKind::Alert,
        Some("confirm") => browser::DialogKind::Confirm,
        Some("prompt") => browser::DialogKind::Prompt,
        Some("beforeunload") => browser::DialogKind::BeforeUnload,
        _ => return Ok(None),
    };
    Ok(Some(browser::DialogInfo {
        kind,
        message: bounded(dialog.field("message")?, browser::MAX_NAME_LENGTH),
        default_prompt: dialog
            .optional::<LosslessString>("defaultPrompt")?
            .filter(|value| !value.is_empty())
            .map(|value| bounded(value, browser::MAX_NAME_LENGTH)),
    }))
}

pub fn control(object: &ObjectDecoder<'_>) -> Result<Option<browser::ControlState>, Error> {
    let Some(raw) = object.optional::<JsonValue>("control")? else {
        return Ok(None);
    };
    let path = JsonPath::default();
    let control = ObjectDecoder::new(&raw, &path)?;
    if control.optional::<bool>("sensitive")? == Some(true) {
        return Ok(Some(browser::ControlState {
            checked: None,
            value: None,
            selected: None,
            sensitive: Some(true),
        }));
    }
    let selected = control
        .optional::<Vec<JsonValue>>("selected")?
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    let option = ObjectDecoder::new(item, &path).ok()?;
                    let index = option.optional::<f64>("index").ok()??;
                    if !index.is_finite() || index.fract() != 0.0 || index < 0.0 {
                        return None;
                    }
                    Some(browser::SelectedOption {
                        value: option
                            .optional::<LosslessString>("value")
                            .ok()?
                            .map(|value| bounded(value, browser::MAX_NAME_LENGTH)),
                        label: bounded(option.field("label").ok()?, browser::MAX_NAME_LENGTH),
                        index: NonNegativeInt::new(index as i64).ok()?,
                    })
                })
                .take(browser::MAX_SELECT_OPTIONS)
                .collect::<Vec<_>>()
        });
    Ok(Some(super::operation::sanitize_control(
        browser::ControlState {
            checked: control.optional("checked")?,
            value: control.optional("value")?,
            selected,
            sensitive: None,
        },
    )))
}

pub fn peripherals(
    object: &ObjectDecoder<'_>,
    result: &mut browser::ActionResult,
) -> Result<(), Error> {
    result.dialog = dialog(object)?;
    result.control = control(object)?;
    result.frame = page(object, "frame")?;
    result.text = object
        .optional::<LosslessString>("text")?
        .map(|text| bytes(text, browser::MAX_CLIPBOARD_BYTES));
    result.logs = object
        .optional::<Vec<JsonValue>>("logs")?
        .map(|items| {
            items
                .iter()
                .take(browser::MAX_LOG_ENTRIES)
                .map(|item| {
                    let path = JsonPath::default();
                    let o = ObjectDecoder::new(item, &path)?;
                    Ok(browser::LogEntry {
                        level: bounded(o.field("level")?, 16),
                        text: bounded(o.field("text")?, browser::MAX_NAME_LENGTH),
                        frame: page(&o, "frame")?,
                    })
                })
                .collect::<Result<Vec<_>, Error>>()
        })
        .transpose()?;
    result.webmcp_tools = object
        .optional::<Vec<JsonValue>>("webmcpTools")?
        .map(|items| {
            items
                .iter()
                .take(100)
                .map(|item| {
                    let path = JsonPath::default();
                    let o = ObjectDecoder::new(item, &path)?;
                    Ok(browser::WebMcpTool {
                        name: bounded(o.field("name")?, 128),
                        description: o
                            .optional::<LosslessString>("description")?
                            .map(|text| bounded(text, browser::MAX_NAME_LENGTH)),
                    })
                })
                .collect::<Result<Vec<_>, Error>>()
        })
        .transpose()?;
    result.download = object
        .optional::<JsonValue>("download")?
        .map(|item| {
            let path = JsonPath::default();
            let o = ObjectDecoder::new(&item, &path)?;
            let number = |name| -> Result<Option<NonNegativeInt>, Error> {
                Ok(o.optional::<f64>(name)?
                    .filter(|n| n.is_finite() && *n >= 0.0 && *n <= 9_007_199_254_740_991.0)
                    .and_then(|n| NonNegativeInt::new(n.floor() as i64).ok()))
            };
            Ok::<_, Error>(browser::DownloadInfo {
                filename: bounded(o.field("filename")?, 1024),
                state: bounded(o.field("state")?, 32),
                bytes_received: number("bytesReceived")?,
                total_bytes: number("totalBytes")?,
                mime: o
                    .optional::<LosslessString>("mime")?
                    .map(|text| bounded(text, 128)),
            })
        })
        .transpose()?;
    Ok(())
}

pub fn history(raw: Vec<JsonValue>, limit: usize) -> Result<Vec<browser::HistoryEntry>, Error> {
    let path = JsonPath::default();
    let mut entries = Vec::new();
    for item in raw {
        let o = ObjectDecoder::new(&item, &path)?;
        let url: LosslessString = o.field("url")?;
        if safe_page(&url).is_err() || url.len() > 8192 {
            continue;
        }
        let mut object = ObjectEncoder::new().field("url", &url).field(
            "title",
            &bounded(o.field("title")?, browser::MAX_TITLE_LENGTH),
        );
        for name in ["lastVisitTime", "visitCount"] {
            if let Some(number) = o
                .optional::<f64>(name)?
                .filter(|n| n.is_finite() && *n >= 0.0 && *n <= 9_007_199_254_740_991.0)
            {
                object = object.field(name, &NonNegativeInt::new(number.floor() as i64)?);
            }
        }
        entries.push(browser::HistoryEntry::decode(&object.finish())?);
        if entries.len() >= limit.min(browser::MAX_HISTORY_RESULTS) {
            break;
        }
    }
    Ok(entries)
}
