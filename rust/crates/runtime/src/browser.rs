use crate::{
    browser_convert, convert,
    dispatch::{Failure, Invocation},
};
use std::sync::Arc;
use ycoding_core::platform::browser::{bridge::Error, service::Service};
use ycoding_core::ycoding_schema::browser;
use ycoding_protocol::v5;

fn service(invocation: &Invocation) -> Result<&Arc<Service>, Failure> {
    invocation
        .core()?
        .browser
        .as_ref()
        .ok_or_else(|| unavailable("Paired Chrome coordinator is not composed".into()))
}

fn unavailable(message: String) -> Failure {
    Failure::ServiceUnavailable {
        service: "browser-extension",
        message,
    }
}

pub(crate) fn failure(error: Error) -> Failure {
    match error {
        Error::Ownership(message) => Failure::Forbidden(message),
        Error::Fence(message) | Error::Busy(message) => Failure::Conflict(message),
        Error::Unavailable(message) => unavailable(message),
        Error::InvalidFrame(message) => Failure::Invalid(message),
    }
}

pub async fn status(
    invocation: Invocation,
    request: v5::BrowserStatusRequest,
) -> Result<v5::BrowserStatusResult, Failure> {
    let id = invocation.session(&request.params.session_id)?;
    Ok(v5::BrowserStatusResult {
        data: browser_convert::status(&service(&invocation)?.status(&id).map_err(failure)?)?,
    })
}

pub async fn tabs(
    invocation: Invocation,
    request: v5::BrowserTabsRequest,
) -> Result<v5::BrowserTabsResult, Failure> {
    let id = invocation.session(&request.params.session_id)?;
    Ok(v5::BrowserTabsResult {
        data: v5::BrowserTabsResultData {
            items: service(&invocation)?
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
    request: v5::BrowserStartRequest,
) -> Result<v5::BrowserStartResult, Failure> {
    let id = invocation.session(&request.params.session_id)?;
    let pairing = service(&invocation)?.start(&id).await.map_err(failure)?;
    Ok(v5::BrowserStartResult {
        data: v5::BrowserPairing {
            secret: convert::wire(&pairing.secret),
            expires_at: pairing.expires_at.get() as u64,
        },
    })
}

pub async fn observe(
    invocation: Invocation,
    request: v5::BrowserObserveRequest,
) -> Result<v5::BrowserObserveResult, Failure> {
    let input = browser::ObserveInput {
        session_id: invocation.session(&request.params.session_id)?,
        tab_id: convert::identifier(&request.payload.tab_id)?,
        generation: browser_convert::number(request.payload.generation)?,
        call_id: convert::identifier(&request.payload.call_id)?,
    };
    Ok(v5::BrowserObserveResult {
        data: browser_convert::observation(
            &service(&invocation)?
                .observe(input)
                .await
                .map_err(failure)?,
        )?,
    })
}

pub async fn action(
    invocation: Invocation,
    request: v5::BrowserActionRequest,
) -> Result<v5::BrowserActionReply, Failure> {
    let input = browser::ActionInput {
        session_id: invocation.session(&request.params.session_id)?,
        tab_id: convert::identifier(&request.payload.tab_id)?,
        generation: browser_convert::number(request.payload.generation)?,
        document_generation: browser_convert::number(request.payload.document_generation)?,
        observation_revision: browser_convert::number(request.payload.observation_revision)?,
        call_id: convert::identifier(&request.payload.call_id)?,
        action: browser_convert::action(request.payload.action)?,
    };
    Ok(v5::BrowserActionReply {
        data: browser_convert::action_result(
            &service(&invocation)?.action(input).await.map_err(failure)?,
        )?,
    })
}

pub async fn control(
    invocation: Invocation,
    request: v5::BrowserControlRequest,
) -> Result<v5::BrowserControlResult, Failure> {
    let id = invocation.session(&request.params.session_id)?;
    Ok(v5::BrowserControlResult {
        data: browser_convert::status(
            &service(&invocation)?
                .control(&id, browser_convert::resume(request.payload.action)?)
                .map_err(failure)?,
        )?,
    })
}

pub async fn open(
    invocation: Invocation,
    request: v5::BrowserOpenRequest,
) -> Result<v5::BrowserOpenResult, Failure> {
    let input = browser_convert::open_input(
        invocation.session(&request.params.session_id)?,
        request.payload,
    )?;
    Ok(v5::BrowserOpenResult {
        data: browser_convert::tab(&service(&invocation)?.open(input).await.map_err(failure)?)?,
    })
}

pub async fn close(
    invocation: Invocation,
    request: v5::BrowserCloseRequest,
) -> Result<v5::BrowserCloseResult, Failure> {
    let input = browser::CloseInput {
        session_id: invocation.session(&request.params.session_id)?,
        tab_id: convert::identifier(&request.payload.tab_id)?,
        generation: browser_convert::number(request.payload.generation)?,
        call_id: convert::identifier(&request.payload.call_id)?,
    };
    service(&invocation)?.close(input).await.map_err(failure)?;
    Ok(v5::BrowserCloseResult { data: v5::Empty {} })
}

pub async fn release(
    invocation: Invocation,
    request: v5::BrowserReleaseRequest,
) -> Result<v5::BrowserReleaseResult, Failure> {
    let input = browser::ReleaseInput {
        session_id: invocation.session(&request.params.session_id)?,
        tab_id: convert::identifier(&request.payload.tab_id)?,
        generation: browser_convert::number(request.payload.generation)?,
        call_id: convert::identifier(&request.payload.call_id)?,
    };
    service(&invocation)?
        .release(input)
        .await
        .map_err(failure)?;
    Ok(v5::BrowserReleaseResult { data: v5::Empty {} })
}

pub async fn stop(
    invocation: Invocation,
    request: v5::BrowserStopRequest,
) -> Result<v5::BrowserStopResult, Failure> {
    let id = invocation.session(&request.params.session_id)?;
    service(&invocation)?.stop(&id).map_err(failure)?;
    Ok(v5::BrowserStopResult { data: v5::Empty {} })
}

pub async fn forget(
    invocation: Invocation,
    request: v5::BrowserForgetRequest,
) -> Result<v5::BrowserForgetResult, Failure> {
    let id = invocation.session(&request.params.session_id)?;
    service(&invocation)?.forget(&id).await.map_err(failure)?;
    Ok(v5::BrowserForgetResult { data: v5::Empty {} })
}
