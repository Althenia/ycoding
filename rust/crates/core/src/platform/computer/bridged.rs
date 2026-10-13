use super::{
    Future,
    electron::{self, Bridge, BridgeResult, Rect, Window},
    macos::NativeClient,
    service::Invoke,
    types::*,
};
use serde_json::Value;
use std::{
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::sync::watch;

pub struct Client {
    pub native: Arc<NativeClient>,
    pub electron: Arc<Bridge>,
    pub platform: String,
}
impl Invoke for Client {
    fn invoke<'a>(
        &'a self,
        request: Request,
        signal: watch::Receiver<bool>,
    ) -> Future<'a, Result<Success, NativeError>> {
        Box::pin(self.execute(request, signal))
    }
}

impl Client {
    async fn execute(
        &self,
        request: Request,
        signal: watch::Receiver<bool>,
    ) -> Result<Success, NativeError> {
        if self.platform != "darwin"
            || !request.operation.as_str().starts_with("desktop.")
            || matches!(
                request.operation,
                Operation::DesktopList | Operation::DesktopInspect | Operation::DesktopQuit
            )
        {
            return self.native.invoke(request).await;
        }
        if request.operation == Operation::DesktopLaunch {
            if request.fields().get("remoteDebugging") != Some(&Value::Bool(true)) {
                return self.native.invoke(request).await;
            }
            let listed = self
                .native
                .invoke(Request::list(request.owner.clone()))
                .await?;
            let bundle = request
                .fields()
                .get("bundleID")
                .and_then(Value::as_str)
                .ok_or_else(invalid)?;
            let existing = listed
                .detail
                .get("apps")
                .and_then(Value::as_array)
                .and_then(|apps| {
                    apps.iter()
                        .find(|app| app.get("bundle_id").and_then(Value::as_str) == Some(bundle))
                })
                .and_then(|app| app.get("pid"))
                .and_then(Value::as_u64)
                .and_then(|pid| u32::try_from(pid).ok());
            if let Some(pid) = existing
                && self
                    .electron
                    .owned_endpoint(pid)
                    .await?
                    .is_some_and(|endpoint| {
                        endpoint.targets.iter().any(|target| target.kind == "page")
                    })
            {
                return self
                    .native
                    .invoke(Request::launch(request.owner.clone(), bundle.into(), false))
                    .await;
            }
            let launched = self.native.invoke(request).await?;
            let pid = launched
                .detail
                .get("pid")
                .and_then(Value::as_u64)
                .and_then(|pid| u32::try_from(pid).ok())
                .ok_or_else(|| {
                    NativeError::new(
                        Code::UnknownOutcome,
                        "Electron relaunch returned no PID",
                        Outcome::Unknown,
                    )
                })?;
            let deadline = Instant::now() + Duration::from_secs(3);
            while Instant::now() < deadline {
                if self
                    .electron
                    .owned_endpoint(pid)
                    .await?
                    .is_some_and(|endpoint| {
                        endpoint.targets.iter().any(|target| target.kind == "page")
                    })
                {
                    return Ok(launched);
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            return Err(NativeError::new(
                Code::UnknownOutcome,
                "Electron relaunch did not expose a PID-owned renderer endpoint",
                Outcome::Unknown,
            ));
        }
        if !matches!(
            request.operation,
            Operation::DesktopCapture
                | Operation::DesktopClick
                | Operation::DesktopDrag
                | Operation::DesktopScroll
                | Operation::DesktopType
                | Operation::DesktopKey
        ) || request.fields().get("element").is_some()
        {
            return self.native.invoke(request).await;
        }
        let target = request.target.as_ref().ok_or_else(invalid)?;
        let Target::Desktop {
            bundle_id,
            pid,
            window_id,
        } = target
        else {
            return Err(invalid());
        };
        if !self.electron.is_electron(*pid).await? {
            return self.native.invoke(request).await;
        }
        let listed = self
            .native
            .invoke(Request::list(request.owner.clone()))
            .await?;
        let window = listed
            .detail
            .get("apps")
            .and_then(Value::as_array)
            .and_then(|apps| {
                apps.iter().find(|app| {
                    app.get("pid").and_then(Value::as_u64) == Some(u64::from(*pid))
                        && app.get("bundle_id").and_then(Value::as_str) == Some(bundle_id)
                })
            })
            .and_then(|app| app.get("windows"))
            .and_then(Value::as_array)
            .and_then(|windows| {
                windows.iter().find(|window| {
                    window.get("window_id").and_then(Value::as_u64) == Some(*window_id)
                })
            })
            .ok_or_else(|| {
                NativeError::new(
                    Code::TargetNotFound,
                    "Exact Core Graphics window is unavailable",
                    Outcome::NotStarted,
                )
            })?;
        let bounds = window.get("bounds").ok_or_else(invalid)?;
        let window = Window {
            id: *window_id,
            title: window
                .get("title")
                .and_then(Value::as_str)
                .ok_or_else(invalid)?
                .into(),
            bounds: Rect {
                x: number(bounds, "x")?,
                y: number(bounds, "y")?,
                width: number(bounds, "width")?,
                height: number(bounds, "height")?,
            },
            on_screen: window
                .get("on_screen")
                .and_then(Value::as_bool)
                .ok_or_else(invalid)?,
        };
        if window.on_screen && request.operation != Operation::DesktopCapture {
            return self.native.invoke(request).await;
        }
        let native_capture = if window.on_screen && request.operation == Operation::DesktopCapture {
            Some(self.native.invoke(request.clone()).await)
        } else {
            None
        };
        if let Some(Ok(response)) = native_capture {
            return Ok(response);
        }
        if let Some(expected) = &request.expected_revision {
            let before = self
                .native
                .invoke(Request::inspect(request.owner.clone(), target.clone())?)
                .await?;
            if before.revision != *expected {
                return Err(NativeError::new(
                    Code::StaleRevision,
                    "Target state changed; inspect again",
                    Outcome::NotStarted,
                ));
            }
        }
        let operation = if request.operation == Operation::DesktopCapture {
            electron::Operation::Capture
        } else {
            electron::Operation::Action(bridge_action(&request)?)
        };
        let performed = self
            .electron
            .perform(target.clone(), window, operation, Some(signal))
            .await?;
        if let Some(performed) = performed {
            let inspected = self
                .native
                .invoke(Request::inspect(request.owner.clone(), target.clone())?)
                .await?;
            let detail = match performed {
                BridgeResult::Capture {
                    image,
                    width,
                    height,
                    scale,
                } => serde_json::json!({"image":image,"width":width,"height":height,"scale":scale}),
                BridgeResult::Action { changed } => {
                    if request.operation == Operation::DesktopCapture {
                        return Err(NativeError::new(
                            Code::InvalidResponse,
                            "Electron bridge returned an action for capture",
                            Outcome::Unknown,
                        ));
                    }
                    serde_json::json!({"effect":if changed {"changed"}else{"unchanged"}})
                }
            };
            return Ok(Success {
                action: request.operation,
                revision: inspected.revision,
                detail,
            });
        }
        if let Some(Err(error)) = native_capture {
            return Err(error);
        }
        self.native.invoke(request).await
    }
    pub async fn shutdown(&self) -> Result<(), NativeError> {
        let native = self.native.shutdown().await;
        let electron = self.electron.shutdown().await;
        native?;
        electron
    }
}
fn invalid() -> NativeError {
    NativeError::new(
        Code::InvalidRequest,
        "Invalid Electron desktop action",
        Outcome::NotStarted,
    )
}
fn number(value: &Value, name: &str) -> Result<f64, NativeError> {
    value.get(name).and_then(Value::as_f64).ok_or_else(invalid)
}
fn coordinate(value: &Value, name: &str) -> Result<u32, NativeError> {
    value
        .get(name)
        .and_then(Value::as_u64)
        .and_then(|value| u32::try_from(value).ok())
        .ok_or_else(invalid)
}
fn bridge_action(request: &Request) -> Result<Action, NativeError> {
    let fields = request.fields();
    match request.operation {
        Operation::DesktopClick => Ok(Action::Click {
            element: None,
            x: Some(coordinate(fields, "x")?),
            y: Some(coordinate(fields, "y")?),
            button: fields
                .get("button")
                .and_then(Value::as_str)
                .map(String::from),
            count: fields
                .get("count")
                .and_then(Value::as_u64)
                .and_then(|count| u32::try_from(count).ok()),
        }),
        Operation::DesktopDrag => Ok(Action::Drag {
            from_x: coordinate(fields, "fromX")?,
            from_y: coordinate(fields, "fromY")?,
            to_x: coordinate(fields, "toX")?,
            to_y: coordinate(fields, "toY")?,
        }),
        Operation::DesktopType => Ok(Action::Type {
            element: None,
            text: fields
                .get("text")
                .and_then(Value::as_str)
                .ok_or_else(invalid)?
                .into(),
        }),
        Operation::DesktopKey => Ok(Action::Key {
            element: None,
            key: fields
                .get("key")
                .and_then(Value::as_str)
                .ok_or_else(invalid)?
                .into(),
            modifiers: fields
                .get("modifiers")
                .and_then(Value::as_array)
                .map(|values| {
                    values
                        .iter()
                        .filter_map(Value::as_str)
                        .map(String::from)
                        .collect()
                })
                .unwrap_or_default(),
        }),
        Operation::DesktopScroll => Ok(Action::ScrollPixels {
            x: coordinate(fields, "x")?,
            y: coordinate(fields, "y")?,
            delta_x: fields
                .get("deltaX")
                .and_then(Value::as_i64)
                .ok_or_else(invalid)?,
            delta_y: fields
                .get("deltaY")
                .and_then(Value::as_i64)
                .ok_or_else(invalid)?,
        }),
        _ => Err(invalid()),
    }
}
