use crate::{
    convert,
    dispatch::{Failure, Invocation},
};
use ycoding_core::ycoding_schema::keep_awake::{LidState, State, Status};
use ycoding_protocol::v5;

pub async fn get(
    invocation: Invocation,
    _: v5::KeepAwakeGetRequest,
) -> Result<v5::KeepAwakeGetResult, Failure> {
    Ok(v5::KeepAwakeGetResult {
        data: wire(invocation.core()?.keep_awake.get()),
    })
}
pub async fn set(
    invocation: Invocation,
    request: v5::KeepAwakeSetRequest,
) -> Result<v5::KeepAwakeSetResult, Failure> {
    Ok(v5::KeepAwakeSetResult {
        data: wire(
            invocation
                .core()?
                .keep_awake
                .set(request.payload.enabled)
                .await,
        ),
    })
}
fn wire(status: Status) -> v5::KeepAwakeStatus {
    v5::KeepAwakeStatus {
        state: match status.state {
            State::Off => 1,
            State::On => 2,
            State::Unsupported => 3,
            State::Error => 4,
        },
        message: status.message.as_ref().map(convert::wire),
        manual: status.manual,
        lid: status.lid.map(|state| match state {
            LidState::Off => v5::KeepAwakeStatusLid::KeepawakeStatusLidOff as i32,
            LidState::On => v5::KeepAwakeStatusLid::KeepawakeStatusLidOn as i32,
            LidState::Held => v5::KeepAwakeStatusLid::KeepawakeStatusLidHeld as i32,
            LidState::Unsupported => v5::KeepAwakeStatusLid::KeepawakeStatusLidUnsupported as i32,
            LidState::Error => v5::KeepAwakeStatusLid::KeepawakeStatusLidError as i32,
        }),
        sleep_hold: status.sleep_hold,
    }
}
