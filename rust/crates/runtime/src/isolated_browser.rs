use crate::{
    browser_convert, convert,
    dispatch::{Failure, Invocation},
};
use std::sync::Arc;
use ycoding_core::platform::browser::{bridge::Error, isolated::Service};
use ycoding_core::ycoding_schema::{isolated_browser, session};
use ycoding_protocol::v5;

fn service(invocation: &Invocation, id: &session::Id) -> Result<Arc<Service>, Failure> {
    let core = invocation.core()?;
    let info = core
        .sessions
        .get(id)
        .map_err(|_| Failure::Unavailable("Session store unavailable".into()))?
        .ok_or_else(|| Failure::SessionNotFound(convert::readable(id.as_lossless())))?;
    core.isolated_browser.as_ref().ok_or_else(|| {
        unavailable("Location-scoped isolated browser resolver is not composed".into())
    })?(&info.location)
    .map_err(unavailable)
}

fn unavailable(message: String) -> Failure {
    Failure::ServiceUnavailable {
        service: "isolated-browser",
        message,
    }
}

fn failure(error: Error) -> Failure {
    match error {
        Error::Ownership(message) => Failure::Forbidden(message),
        Error::Fence(message) | Error::Busy(message) => Failure::Conflict(message),
        Error::Unavailable(message) => unavailable(message),
        Error::InvalidFrame(_) => Failure::Invalid("Isolated browser operation failed".into()),
    }
}

pub async fn status(
    invocation: Invocation,
    request: v5::IsolatedBrowserStatusRequest,
) -> Result<v5::IsolatedBrowserStatusResult, Failure> {
    let id = invocation.session(&request.params.session_id)?;
    Ok(v5::IsolatedBrowserStatusResult {
        data: browser_convert::isolated_status(
            &service(&invocation, &id)?
                .status(&id)
                .await
                .map_err(failure)?,
        )?,
    })
}

pub async fn tabs(
    invocation: Invocation,
    request: v5::IsolatedBrowserTabsRequest,
) -> Result<v5::IsolatedBrowserTabsResult, Failure> {
    let id = invocation.session(&request.params.session_id)?;
    Ok(v5::IsolatedBrowserTabsResult {
        data: v5::IsolatedBrowserTabsResultData {
            items: service(&invocation, &id)?
                .list(&id)
                .map_err(failure)?
                .iter()
                .map(browser_convert::tab)
                .collect::<Result<_, _>>()?,
        },
    })
}

pub async fn start(
    invocation: Invocation,
    request: v5::IsolatedBrowserStartRequest,
) -> Result<v5::IsolatedBrowserStartResult, Failure> {
    let id = invocation.session(&request.params.session_id)?;
    let input = browser_convert::start_input(request.payload)?;
    Ok(v5::IsolatedBrowserStartResult {
        data: browser_convert::isolated_status(
            &service(&invocation, &id)?
                .start(&id, input)
                .await
                .map_err(failure)?,
        )?,
    })
}

pub async fn observe(
    invocation: Invocation,
    request: v5::IsolatedBrowserObserveRequest,
) -> Result<v5::IsolatedBrowserObserveResult, Failure> {
    let input = isolated_browser::ObserveInput {
        session_id: invocation.session(&request.params.session_id)?,
        tab_id: convert::identifier(&request.payload.tab_id)?,
        generation: browser_convert::number(request.payload.generation)?,
        call_id: convert::identifier(&request.payload.call_id)?,
        instance_id: convert::identifier(&request.payload.instance_id)?,
    };
    Ok(v5::IsolatedBrowserObserveResult {
        data: browser_convert::isolated_observation(
            &service(&invocation, &input.session_id)?
                .observe(input)
                .await
                .map_err(failure)?,
        )?,
    })
}

pub async fn action(
    invocation: Invocation,
    request: v5::IsolatedBrowserActionRequest,
) -> Result<v5::IsolatedBrowserActionReply, Failure> {
    let input = isolated_browser::ActionInput {
        session_id: invocation.session(&request.params.session_id)?,
        tab_id: convert::identifier(&request.payload.tab_id)?,
        generation: browser_convert::number(request.payload.generation)?,
        document_generation: browser_convert::number(request.payload.document_generation)?,
        observation_revision: browser_convert::number(request.payload.observation_revision)?,
        call_id: convert::identifier(&request.payload.call_id)?,
        action: browser_convert::isolated_action(request.payload.action)?,
        instance_id: convert::identifier(&request.payload.instance_id)?,
    };
    Ok(v5::IsolatedBrowserActionReply {
        data: browser_convert::isolated_action_result(
            &service(&invocation, &input.session_id)?
                .action(input)
                .await
                .map_err(failure)?,
        )?,
    })
}

pub async fn control(
    invocation: Invocation,
    request: v5::IsolatedBrowserControlRequest,
) -> Result<v5::IsolatedBrowserControlResult, Failure> {
    let id = invocation.session(&request.params.session_id)?;
    Ok(v5::IsolatedBrowserControlResult {
        data: browser_convert::isolated_status(
            &service(&invocation, &id)?
                .control(&id, browser_convert::resume(request.payload.action)?)
                .await
                .map_err(failure)?,
        )?,
    })
}

pub async fn stop(
    invocation: Invocation,
    request: v5::IsolatedBrowserStopRequest,
) -> Result<v5::IsolatedBrowserStopResult, Failure> {
    let id = invocation.session(&request.params.session_id)?;
    service(&invocation, &id)?
        .stop(&id)
        .await
        .map_err(failure)?;
    Ok(v5::IsolatedBrowserStopResult { data: v5::Empty {} })
}
