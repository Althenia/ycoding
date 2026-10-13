use super::{
    errors, framing, protobuf, replay, usage,
    wire::{self, ServerMessage, Update},
};
use crate::{
    Error,
    llm::{BlockEvent, DeltaEvent, Event, Finish, FinishReason},
};
use std::collections::BTreeMap;

#[derive(Debug, Default, PartialEq)]
pub struct Batch {
    pub events: Vec<Event>,
    pub controls: Vec<ServerMessage>,
    pub replies: Vec<Vec<u8>>,
    pub failures: Vec<Error>,
    pub progress: bool,
}
#[derive(Default)]
pub struct State {
    framing: framing::Decoder,
    safety: replay::Safety,
    terminal: bool,
    text_open: bool,
    reasoning_open: bool,
    checkpoint: Option<Vec<u8>>,
    blobs: BTreeMap<Vec<u8>, Vec<u8>>,
}
impl State {
    pub fn new() -> Self {
        Self::default()
    }
    pub fn checkpoint(&self) -> Option<&[u8]> {
        self.checkpoint.as_deref()
    }
    pub fn replay_safe(&self, provider_safe: bool) -> bool {
        self.safety.safe(provider_safe)
    }
    pub fn blobs(&self) -> &BTreeMap<Vec<u8>, Vec<u8>> {
        &self.blobs
    }
    pub fn restore_blobs(&mut self, blobs: BTreeMap<Vec<u8>, Vec<u8>>) {
        self.blobs = blobs;
    }
    pub fn restore_checkpoint(&mut self, checkpoint: Option<Vec<u8>>) {
        self.checkpoint = checkpoint.filter(|bytes| !bytes.is_empty());
    }
    pub fn close_spans(&mut self) -> Vec<Event> {
        let mut events = Vec::new();
        if self.reasoning_open {
            events.push(Event::ReasoningEnd(block("reasoning")));
            self.reasoning_open = false;
        }
        if self.text_open {
            events.push(Event::TextEnd(block("text")));
            self.text_open = false;
        }
        events
    }
    pub fn push(&mut self, bytes: &[u8]) -> Result<Batch, Error> {
        let mut batch = Batch::default();
        for frame in self.framing.push(bytes) {
            if frame.flags & framing::END_STREAM != 0 {
                if self.terminal {
                    continue;
                }
                let payload = frame
                    .decode()
                    .inspect_err(|_| self.safety.mark(replay::Barrier::Malformed))?;
                return Err(errors::connect(&payload));
            }
            if self.terminal {
                return Err(Error::output("Cursor emitted data after turn_ended"));
            }
            let payload = match frame.decode() {
                Ok(payload) => payload,
                Err(error) => {
                    self.safety.mark(replay::Barrier::Malformed);
                    batch.failures.push(error);
                    continue;
                }
            };
            let decoded = match wire::decode(&payload) {
                Ok(decoded) => decoded,
                Err(error) => {
                    self.safety.mark(replay::Barrier::Malformed);
                    if requires_reply(&payload) {
                        return Err(error);
                    }
                    batch.failures.push(error);
                    continue;
                }
            };
            let analysis = replay::analyze(&payload, Some(&decoded));
            batch.progress |= analysis.progress;
            if let Some(barrier) = analysis.barrier {
                self.safety.mark(barrier);
            }
            if protobuf::fields(&payload)?.len() != 1 {
                return Err(Error::output("Cursor server message has multiple channels"));
            }
            match decoded {
                ServerMessage::Interaction(Update::Text(text)) => {
                    if text.is_empty() {
                        continue;
                    }
                    self.safety.mark(replay::Barrier::VisibleText);
                    if self.reasoning_open && !self.text_open {
                        batch.events.push(Event::ReasoningEnd(block("reasoning")));
                        self.reasoning_open = false;
                    }
                    if !self.text_open {
                        batch.events.push(Event::TextStart(block("text")));
                        self.text_open = true;
                    }
                    batch.events.push(Event::TextDelta(DeltaEvent {
                        id: "text".into(),
                        text: text.into(),
                        provider_metadata: None,
                    }));
                }
                ServerMessage::Interaction(Update::Thinking(text)) => {
                    if text.is_empty() {
                        continue;
                    }
                    self.safety.mark(replay::Barrier::VisibleReasoning);
                    if !self.reasoning_open {
                        batch.events.push(Event::ReasoningStart(block("reasoning")));
                        self.reasoning_open = true;
                    }
                    batch.events.push(Event::ReasoningDelta(DeltaEvent {
                        id: "reasoning".into(),
                        text: text.into(),
                        provider_metadata: None,
                    }));
                }
                ServerMessage::Interaction(Update::TurnEnded(counters)) => {
                    if self.text_open {
                        batch.events.push(Event::TextEnd(block("text")));
                        self.text_open = false;
                    }
                    if self.reasoning_open {
                        batch.events.push(Event::ReasoningEnd(block("reasoning")));
                        self.reasoning_open = false;
                    }
                    let usage = usage::normalize(&counters);
                    let reported = usage != Default::default();
                    batch.events.push(Event::Finish(Finish {
                        reason: FinishReason::Stop,
                        usage: reported.then_some(usage),
                        provider_metadata: None,
                    }));
                    self.terminal = true;
                }
                ServerMessage::Interaction(Update::Heartbeat) => {}
                ServerMessage::Checkpoint(bytes) => {
                    if !bytes.is_empty() {
                        self.checkpoint = Some(bytes);
                    }
                }
                ServerMessage::Kv(bytes) => batch.replies.push(self.kv(&bytes)?),
                ServerMessage::Unknown(_, _)
                | ServerMessage::Interaction(Update::Unknown(_, _)) => {
                    return Err(Error::output("Cursor returned an unknown server channel"));
                }
                control => batch.controls.push(control),
            }
        }
        Ok(batch)
    }
    fn kv(&mut self, bytes: &[u8]) -> Result<Vec<u8>, Error> {
        let fields = protobuf::fields(bytes)?;
        let id = fields
            .iter()
            .rev()
            .find(|field| field.number == 1)
            .map(|field| field.uint32())
            .transpose()?
            .unwrap_or(0);
        let variant = fields
            .iter()
            .rev()
            .find(|field| [2, 3].contains(&field.number))
            .ok_or_else(|| Error::output("Cursor KV request has no get/set variant"))?;
        let args = protobuf::fields(variant.bytes()?)?;
        let blob_id = args
            .iter()
            .rev()
            .find(|field| field.number == 1)
            .ok_or_else(|| Error::output("Cursor KV request has no blob ID"))?
            .bytes()?;
        let mut result = Vec::new();
        if variant.number == 3 {
            let data = args
                .iter()
                .rev()
                .find(|field| field.number == 2)
                .map(|field| field.bytes())
                .transpose()?
                .unwrap_or(&[]);
            self.blobs.insert(blob_id.to_vec(), data.to_vec());
        } else {
            let is_hash = blob_id.len() == 32
                && blob_id
                    .iter()
                    .any(|byte| *byte < 9 || (*byte > 13 && *byte < 32) || *byte > 126);
            let data = self
                .blobs
                .get(blob_id)
                .map(Vec::as_slice)
                .unwrap_or(if is_hash { &[] } else { blob_id });
            protobuf::write_bytes(&mut result, 1, data)?;
        }
        let mut kv = Vec::new();
        protobuf::write_varint(&mut kv, 1, u64::from(id))?;
        protobuf::write_bytes(&mut kv, variant.number, &result)?;
        let mut client = Vec::new();
        protobuf::write_bytes(&mut client, 3, &kv)?;
        Ok(client)
    }
    pub fn finish(&self) -> Result<(), Error> {
        self.framing.finish()?;
        if self.terminal {
            return Ok(());
        }
        Err(Error::missing_terminal())
    }
}
fn block(id: &str) -> BlockEvent {
    BlockEvent {
        id: id.into(),
        provider_metadata: None,
    }
}

fn requires_reply(payload: &[u8]) -> bool {
    protobuf::fields(payload)
        .map(|fields| fields.iter().any(|field| [2, 4, 7].contains(&field.number)))
        .unwrap_or_else(|_| {
            payload
                .first()
                .is_some_and(|tag| [2, 4, 7].contains(&(tag >> 3)))
        })
}
pub fn grpc_error(code: &str) -> Error {
    errors::grpc(code)
}
