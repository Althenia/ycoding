use crate::{
    Error,
    llm::{DeltaEvent, Event, FinishReason, ToolCall},
};
use ycoding_schema::parse_json;

const CALLS_BEGIN: &str = "<｜ tool▁calls▁begin｜ >";
const CALLS_END: &str = "<｜ tool▁calls▁end｜ >";
const CALL_BEGIN: &str = "<｜ tool▁call▁begin｜ >";
const CALL_END: &str = "<｜ tool▁call▁end｜ >";
const SEPARATOR: &str = "<｜ tool▁sep｜ >";

#[derive(Default)]
pub(super) struct TextualTools {
    buffer: String,
    call: Option<String>,
    unfinished: bool,
    next_id: u32,
}

impl TextualTools {
    pub(super) fn event(&mut self, event: Event) -> Result<Vec<Event>, Error> {
        if let Event::TextDelta(delta) = event {
            let Some(text) = delta.text.as_str() else {
                return Ok(vec![Event::TextDelta(delta)]);
            };
            self.buffer.push_str(text);
            let mut events = Vec::new();
            loop {
                if let Some(call) = &mut self.call {
                    let scan =
                        call.ceil_char_boundary(call.len().saturating_sub(CALLS_END.len() - 1));
                    call.push_str(&self.buffer);
                    self.buffer.clear();
                    let Some(offset) = call[scan..].find(CALLS_END) else {
                        break;
                    };
                    let end = scan + offset;
                    self.buffer = call.split_off(end + CALLS_END.len());
                    call.truncate(end);
                    let raw = std::mem::take(call);
                    self.call = None;
                    events.extend(self.parse_calls(&raw)?);
                    continue;
                }
                if let Some(start) = self.buffer.find(CALLS_BEGIN) {
                    if start > 0 {
                        events.push(Event::TextDelta(DeltaEvent {
                            text: self.buffer[..start].into(),
                            ..delta.clone()
                        }));
                    }
                    self.buffer = self.buffer[start + CALLS_BEGIN.len()..].into();
                    self.call = Some(String::new());
                    continue;
                }
                let prefix = (1..CALLS_BEGIN.len())
                    .rev()
                    .find(|size| {
                        self.buffer.len() >= *size
                            && self.buffer.is_char_boundary(self.buffer.len() - size)
                            && CALLS_BEGIN.starts_with(&self.buffer[self.buffer.len() - size..])
                    })
                    .unwrap_or(0);
                let visible = self.buffer.len() - prefix;
                if visible > 0 {
                    events.push(Event::TextDelta(DeltaEvent {
                        text: self.buffer[..visible].into(),
                        ..delta.clone()
                    }));
                }
                self.buffer = self.buffer[visible..].into();
                break;
            }
            return Ok(events);
        }
        if let Event::TextEnd(block) = &event {
            self.unfinished |= self.call.take().is_some();
            if !self.buffer.is_empty() {
                let text = std::mem::take(&mut self.buffer);
                return Ok(vec![
                    Event::TextDelta(DeltaEvent {
                        id: block.id.clone(),
                        text: text.into(),
                        provider_metadata: block.provider_metadata.clone(),
                    }),
                    event,
                ]);
            }
        }
        if let Event::Finish(finish) = &event {
            let unfinished = std::mem::take(&mut self.unfinished) | self.call.take().is_some();
            if unfinished && finish.reason != FinishReason::Length {
                return Err(Error::missing_terminal());
            }
        }
        Ok(vec![event])
    }

    fn parse_calls(&mut self, raw: &str) -> Result<Vec<Event>, Error> {
        let invalid = || Error::output("Provider emitted a malformed textual tool call");
        let mut remaining = raw;
        let mut events = Vec::new();
        while !remaining.trim().is_empty() {
            remaining = remaining.trim_start();
            let raw = remaining.strip_prefix(CALL_BEGIN).ok_or_else(invalid)?;
            let end = raw.find(CALL_END).ok_or_else(invalid)?;
            let call = &raw[..end];
            let (kind, body) = call.split_once(SEPARATOR).ok_or_else(invalid)?;
            if kind.trim() != "function" {
                return Err(invalid());
            }
            let (name, input) = body.trim().split_once('\n').ok_or_else(invalid)?;
            let name = name.trim();
            if name.is_empty() {
                return Err(invalid());
            }
            let input = input.trim();
            let input = input
                .strip_suffix("```json")
                .or_else(|| input.strip_suffix("```"))
                .unwrap_or(input)
                .trim();
            let input = parse_json(if input.is_empty() { "{}" } else { input }).map_err(|_| {
                Error::output(format!(
                    "Provider emitted invalid JSON for textual tool call {name}"
                ))
            })?;
            events.push(Event::ToolCall(ToolCall {
                id: format!("textual-tool-{}", self.next_id).into(),
                name: name.into(),
                input,
                provider_executed: None,
                provider_metadata: None,
            }));
            self.next_id += 1;
            remaining = &raw[end + CALL_END.len()..];
        }
        if events.is_empty() {
            return Err(invalid());
        }
        Ok(events)
    }
}

#[cfg(test)]
mod tests {
    use super::TextualTools;
    use crate::{
        Error,
        llm::{BlockEvent, DeltaEvent, Event, Finish, FinishReason, ToolCall},
        provider_error::Reason,
    };
    use ycoding_schema::parse_json;

    const OPEN_WRAPPER: &str = "<｜ tool▁calls▁begin｜ ><｜ tool▁call▁begin｜ >function<｜ tool▁sep｜ >lookup\n{\"query\":\"weather\"}<｜ tool▁call▁end｜ >";

    fn delta(text: &str) -> Event {
        Event::TextDelta(DeltaEvent {
            id: "text-0".into(),
            text: text.into(),
            provider_metadata: None,
        })
    }

    fn text_end() -> Event {
        Event::TextEnd(BlockEvent {
            id: "text-0".into(),
            provider_metadata: None,
        })
    }

    fn finish(reason: FinishReason) -> Event {
        Event::Finish(Finish {
            reason,
            usage: None,
            provider_metadata: None,
        })
    }

    #[test]
    fn unclosed_textual_call_wrapper_has_no_dispatch_event() {
        for reason in [FinishReason::Stop, FinishReason::Length] {
            let mut tools = TextualTools::default();
            let input = format!("Checking {OPEN_WRAPPER}");
            assert_eq!(tools.event(delta(&input)).unwrap(), [delta("Checking ")]);
            assert_eq!(tools.event(text_end()).unwrap(), [text_end()]);
            let terminal = finish(reason);
            let result = tools.event(terminal.clone());
            if reason == FinishReason::Length {
                assert_eq!(result.unwrap(), [terminal]);
            } else {
                assert_eq!(result.unwrap_err(), Error::missing_terminal());
            }
        }
    }

    #[test]
    fn complete_textual_call_survives_split_closing_marker() {
        let mut tools = TextualTools::default();
        assert!(tools.event(delta(OPEN_WRAPPER)).unwrap().is_empty());
        assert!(tools.event(delta("<｜ tool▁calls")).unwrap().is_empty());
        assert_eq!(
            tools.event(delta("▁end｜ >Done.")).unwrap(),
            [
                Event::ToolCall(ToolCall {
                    id: "textual-tool-0".into(),
                    name: "lookup".into(),
                    input: parse_json(r#"{"query":"weather"}"#).unwrap(),
                    provider_executed: None,
                    provider_metadata: None,
                }),
                delta("Done."),
            ],
        );
        assert_eq!(tools.event(text_end()).unwrap(), [text_end()]);
        let terminal = finish(FinishReason::Stop);
        assert_eq!(tools.event(terminal.clone()).unwrap(), [terminal]);
    }

    #[test]
    fn complete_malformed_textual_call_remains_invalid() {
        let wire = "<｜ tool▁calls▁begin｜ ><｜ tool▁call▁begin｜ >function<｜ tool▁sep｜ >lookup\n{bad}<｜ tool▁call▁end｜ ><｜ tool▁calls▁end｜ >";
        let error = TextualTools::default().event(delta(wire)).unwrap_err();
        assert_eq!(error.reason, Reason::InvalidProviderOutput);
    }
}
