use crate::{
    convert,
    dispatch::{Failure, Invocation},
};
use ycoding_core::ycoding_schema::keep_awake::{State, Status};
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
    }
}
