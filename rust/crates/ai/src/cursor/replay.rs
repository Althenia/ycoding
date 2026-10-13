use super::{
    protobuf::{self, Field, Value},
    wire::{ServerMessage, Update},
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Barrier {
    DisplayTool,
    Malformed,
    NonControlExec,
    VisibleText,
    VisibleReasoning,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Analysis {
    pub progress: bool,
    pub barrier: Option<Barrier>,
}
#[derive(Default)]
pub struct Safety {
    barrier: Option<Barrier>,
}
impl Safety {
    pub fn mark(&mut self, barrier: Barrier) {
        self.barrier.get_or_insert(barrier);
    }
    pub fn safe(&self, provider_safe: bool) -> bool {
        provider_safe && self.barrier.is_none()
    }
    pub fn barrier(&self) -> Option<Barrier> {
        self.barrier
    }
}
fn nested<'a>(field: Option<&Field<'a>>, number: u32) -> Vec<Field<'a>> {
    field
        .filter(|field| field.number == number)
        .and_then(|field| field.bytes().ok())
        .and_then(|bytes| protobuf::fields(bytes).ok())
        .unwrap_or_default()
}
pub fn analyze(payload: &[u8], decoded: Option<&ServerMessage>) -> Analysis {
    let fields = protobuf::fields(payload).unwrap_or_default();
    let top = (fields.len() == 1).then(|| &fields[0]);
    let exec = nested(top, 2)
        .into_iter()
        .filter(|field| ![1, 15, 19].contains(&field.number))
        .collect::<Vec<_>>();
    let control_exec =
        exec.len() == 1 && [10, 36].contains(&exec[0].number) && exec[0].wire_type() == 2;
    let kv = nested(top, 4)
        .into_iter()
        .filter(|field| field.number != 1)
        .collect::<Vec<_>>();
    let variant = (kv.len() == 1).then(|| kv[0]);
    let args = variant
        .and_then(|field| field.bytes().ok())
        .and_then(|bytes| protobuf::fields(bytes).ok())
        .unwrap_or_default();
    let valid_kv = variant
        .is_some_and(|variant| [2, 3].contains(&variant.number) && variant.wire_type() == 2)
        && args
            .iter()
            .filter(|field| {
                field.number == 1 && matches!(field.value, Value::Bytes(bytes) if !bytes.is_empty())
            })
            .count()
            == 1
        && args.iter().all(|field| {
            field.wire_type() == 2
                && (field.number == 1
                    || variant.is_some_and(|variant| variant.number == 3 && field.number == 2))
        });
    let update = nested(top, 1);
    let valid_update = !matches!(decoded, Some(ServerMessage::Interaction(_)))
        || update.len() == 1
            && update[0].wire_type() == 2
            && [1, 2, 3, 4, 7, 13, 14, 16, 17].contains(&update[0].number)
            && (![1, 4].contains(&update[0].number) || {
                let delta = update[0]
                    .bytes()
                    .ok()
                    .and_then(|bytes| protobuf::fields(bytes).ok())
                    .unwrap_or_default();
                delta.len() == 1 && delta[0].number == 1 && delta[0].wire_type() == 2
            });
    let query = nested(top, 7);
    let query_variants = query
        .iter()
        .filter(|field| field.number != 1)
        .collect::<Vec<_>>();
    let query_ids = query
        .iter()
        .filter(|field| field.number == 1)
        .collect::<Vec<_>>();
    let valid_query = !matches!(decoded, Some(ServerMessage::InteractionQuery(_)))
        || query_ids.len() <= 1
            && query_ids.iter().all(|field| field.wire_type() == 0)
            && query_variants.len() == 1
            && query_variants[0].wire_type() == 2
            && [2, 3, 4, 7, 8, 9, 10, 11, 12, 13, 14].contains(&query_variants[0].number);
    let matches = match top.map(|field| field.number) {
        Some(1) => matches!(decoded, Some(ServerMessage::Interaction(_))),
        Some(2) => matches!(decoded, Some(ServerMessage::Exec(_))),
        Some(4) => matches!(decoded, Some(ServerMessage::Kv(_))),
        Some(5) => matches!(decoded, Some(ServerMessage::ExecControl(_))),
        Some(7) => matches!(decoded, Some(ServerMessage::InteractionQuery(_))),
        _ => true,
    };
    let malformed = top
        .is_none_or(|field| field.wire_type() != 2 || ![1, 2, 3, 4, 5, 7].contains(&field.number))
        || !valid_update
        || !valid_query
        || !matches
        || matches!(decoded, Some(ServerMessage::ExecControl(_)));
    let display = matches!(
        decoded,
        Some(ServerMessage::Interaction(
            Update::ToolStarted(_) | Update::ToolCompleted(_)
        ))
    );
    let barrier = if display {
        Some(Barrier::DisplayTool)
    } else if malformed || top.is_some_and(|field| field.number == 4) && !valid_kv {
        Some(Barrier::Malformed)
    } else if top.is_some_and(|field| field.number == 2) && !control_exec {
        Some(Barrier::NonControlExec)
    } else {
        None
    };
    let progress = match decoded {
        Some(ServerMessage::Interaction(Update::Text(text) | Update::Thinking(text))) => {
            !text.is_empty()
        }
        Some(ServerMessage::Interaction(
            Update::TurnEnded(_) | Update::ToolStarted(_) | Update::ToolCompleted(_),
        )) => true,
        Some(
            ServerMessage::Exec(_)
            | ServerMessage::Kv(_)
            | ServerMessage::ExecControl(_)
            | ServerMessage::InteractionQuery(_),
        ) => true,
        Some(ServerMessage::Checkpoint(bytes)) => !bytes.is_empty(),
        _ => false,
    };
    Analysis { progress, barrier }
}
