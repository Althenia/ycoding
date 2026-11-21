use super::{Error, text, uuid, validation};
use crate::platform::browser::cdp::{Client, Event};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    sync::{Arc, LazyLock, Mutex},
    time::Duration,
};
use tokio::sync::{broadcast, watch};

pub(super) fn source(name: &str) -> &'static str {
    static SCRIPTS: LazyLock<Value> = LazyLock::new(|| {
        serde_json::from_str(include_str!("scripts.json")).expect("embedded page functions")
    });
    SCRIPTS[name].as_str().expect("embedded page function")
}
pub struct Runner {
    client: Arc<Client>,
    session: String,
    worlds: Mutex<HashMap<String, World>>,
}
#[derive(Clone)]
struct World {
    frame: String,
    loader: String,
    context: u64,
    name: String,
    script: String,
    dispose: String,
}
impl Runner {
    pub fn new(client: Arc<Client>, session: String) -> Self {
        Self {
            client,
            session,
            worlds: Mutex::new(HashMap::new()),
        }
    }
    async fn send(
        &self,
        method: &str,
        params: Value,
        cancel: watch::Receiver<bool>,
    ) -> Result<Value, Error> {
        if !matches!(
            method,
            "Runtime.enable"
                | "Runtime.disable"
                | "Runtime.evaluate"
                | "Runtime.callFunctionOn"
                | "Runtime.releaseObjectGroup"
                | "Runtime.terminateExecution"
                | "Page.getFrameTree"
                | "Page.createIsolatedWorld"
                | "Page.addScriptToEvaluateOnNewDocument"
                | "Page.removeScriptToEvaluateOnNewDocument"
        ) {
            return Err(Error("policy"));
        }
        self.client
            .send(method, params, Some(&self.session), Some(cancel), None)
            .await
            .map_err(|_| Error("uncertain"))
    }
    async fn world(
        &self,
        lease: &str,
        mode: &str,
        cancel: watch::Receiver<bool>,
    ) -> Result<World, Error> {
        let tree = self
            .send("Page.getFrameTree", json!({}), cancel.clone())
            .await?;
        let frame = &tree["frameTree"]["frame"];
        let id = text(frame, "id");
        let loader = text(frame, "loaderId");
        if id.is_empty() || loader.is_empty() {
            return Err(Error("target_lost"));
        }
        let stored = self
            .worlds
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(lease)
            .cloned();
        if mode == "code"
            && let Some(world) = stored.clone()
            && world.frame == id
            && world.loader == loader
        {
            return Ok(world);
        }
        if let Some(world) = stored {
            self.worlds
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .remove(lease);
            self.dispose(world).await?;
        }
        let name = format!("ycoding-script-{}", uuid()?);
        let harden = format!("({})()", source("harden"));
        let script = self
            .send(
                "Page.addScriptToEvaluateOnNewDocument",
                json!({"source":harden,"worldName":name}),
                cancel.clone(),
            )
            .await?;
        let script = text(&script, "identifier").to_owned();
        if script.is_empty() {
            return Err(Error("unavailable"));
        }
        let prepared=async{
            let world=self.send("Page.createIsolatedWorld",json!({"frameId":id,"worldName":name,"grantUniveralAccess":false}),cancel.clone()).await?;let context=world["executionContextId"].as_u64().ok_or(Error("unavailable"))?;
            let result=self.send("Runtime.evaluate",json!({"expression":harden,"contextId":context,"objectGroup":name,"returnByValue":false,"userGesture":false}),cancel).await?;
            if result.get("exceptionDetails").is_some() || result["result"]["type"]!="function" || text(&result["result"],"objectId").is_empty(){return Err(Error("unavailable"));}
            Ok(World {frame:id.into(),loader:loader.into(),context,name:name.clone(),script:script.clone(),dispose:text(&result["result"],"objectId").into()})
        }.await;
        let world = match prepared {
            Ok(world) => world,
            Err(error) => {
                self.send(
                    "Page.removeScriptToEvaluateOnNewDocument",
                    json!({"identifier":script}),
                    super::signal(),
                )
                .await?;
                return Err(error);
            }
        };
        if mode == "code" {
            self.worlds
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .insert(lease.into(), world.clone());
        }
        Ok(world)
    }
    async fn dispose(&self, world: World) -> Result<(), Error> {
        let signal = super::signal();
        let (disposed,removed)=tokio::join!(self.send("Runtime.callFunctionOn",json!({"objectId":world.dispose,"functionDeclaration":"function () { this() }","userGesture":false}),signal.clone()),self.send("Page.removeScriptToEvaluateOnNewDocument",json!({"identifier":world.script}),signal.clone()));
        let released = self
            .send(
                "Runtime.releaseObjectGroup",
                json!({"objectGroup":world.name}),
                signal,
            )
            .await;
        disposed?;
        removed?;
        released?;
        Ok(())
    }
    pub async fn discard(&self) -> Result<(), Error> {
        let worlds = std::mem::take(&mut *self.worlds.lock().unwrap_or_else(|e| e.into_inner()));
        for world in worlds.into_values() {
            self.dispose(world).await?;
        }
        Ok(())
    }
    pub async fn run(
        &self,
        lease: &str,
        script: &Value,
        mut cancel: watch::Receiver<bool>,
    ) -> Result<Value, Error> {
        if *cancel.borrow() {
            return Ok(json!({"outcome":"stopped","logs":[]}));
        }
        let mut events = self.client.subscribe();
        self.send("Runtime.enable", json!({}), cancel.clone())
            .await?;
        let mode = text(script, "mode");
        let world = self.world(lease, mode, cancel.clone()).await?;
        let group = format!("ycoding-run-{}", uuid()?);
        let source = text(script, "source");
        let timeout = Duration::from_millis(script["timeoutMs"].as_u64().unwrap_or(10000));
        let mut logs = vec![];
        let mut truncated = false;
        let context = world.context;
        let execution_cancel = cancel.clone();
        let deadline = tokio::time::Instant::now() + timeout;
        let work = async {
            let params = if mode == "code" {
                json!({"expression":source,"contextId":context,"replMode":true,"awaitPromise":true,"returnByValue":false,"userGesture":false,"objectGroup":group})
            } else {
                json!({"functionDeclaration":format!("async function () {{\n{source}\n}}"),"executionContextId":context,"awaitPromise":true,"returnByValue":false,"userGesture":false,"objectGroup":group})
            };
            let result = self
                .send(
                    if mode == "code" {
                        "Runtime.evaluate"
                    } else {
                        "Runtime.callFunctionOn"
                    },
                    params,
                    execution_cancel.clone(),
                )
                .await?;
            if result.get("exceptionDetails").is_some() {
                return self
                    .error(&result["exceptionDetails"], execution_cancel.clone())
                    .await;
            }
            let remote = &result["result"];
            if !text(remote, "objectId").is_empty() {
                let serialized=self.send("Runtime.callFunctionOn",json!({"objectId":remote["objectId"],"functionDeclaration":source_fn("serialize"),"arguments":[{"value":65536}],"returnByValue":true,"userGesture":false}),execution_cancel.clone()).await?;
                if serialized.get("exceptionDetails").is_some() {
                    return self
                        .error(&serialized["exceptionDetails"], execution_cancel.clone())
                        .await;
                }
                let value = &serialized["result"]["value"];
                if value == false || value.as_str().is_some_and(|s| s.len() > 65536) {
                    return Ok(json!({"outcome":"completed","valueTruncated":true}));
                }
                let Some(encoded) = value.as_str() else {
                    return Ok(
                        json!({"outcome":"error","error":{"name":"TypeError","message":"The script returned a value that cannot be serialized as JSON"}}),
                    );
                };
                let value: Value = serde_json::from_str(encoded).map_err(|_| Error("uncertain"))?;
                return Ok(deliver(value));
            }
            let value = remote.get("value").cloned().unwrap_or_else(|| {
                if text(remote, "unserializableValue").ends_with('n') {
                    json!(text(remote, "unserializableValue").trim_end_matches('n'))
                } else {
                    Value::Null
                }
            });
            Ok(deliver(value))
        };
        tokio::pin!(work);
        let result = loop {
            tokio::select! {
                result=&mut work=>break result?,
                _=tokio::time::sleep_until(deadline)=>break json!({"outcome":"timeout"}),
                _=async{let _=cancel.wait_for(|v|*v).await;}=>break json!({"outcome":"stopped"}),
                event=events.recv()=>match event {
                    Ok(event)if event.session_id.as_deref()==Some(&self.session)=>{
                        if event.method=="Page.javascriptDialogOpening"{break json!({"outcome":"paused","reason":"dialog"});}
                        if event.method=="Page.fileChooserOpened"{break json!({"outcome":"paused","reason":"file_chooser"});}
                        if let Some(entry)=log_entry(event,world.context){if logs.len()<200{logs.push(entry);}else{truncated=true;}}
                    },
                    Ok(_)=>{},Err(broadcast::error::RecvError::Lagged(_))=>return Err(Error("uncertain")),Err(_)=>break json!({"outcome":"stopped"}),
                }
            }
        };
        let mut result = result;
        if matches!(text(&result, "outcome"), "timeout" | "stopped") {
            self.send("Runtime.terminateExecution", json!({}), super::signal())
                .await?;
        }
        self.send(
            "Runtime.releaseObjectGroup",
            json!({"objectGroup":group}),
            super::signal(),
        )
        .await?;
        if mode == "script" {
            self.dispose(world).await?;
        }
        self.send("Runtime.disable", json!({}), super::signal())
            .await?;
        while let Ok(event) = events.try_recv() {
            if event.session_id.as_deref() == Some(&self.session)
                && let Some(entry) = log_entry(event, context)
            {
                if logs.len() < 200 {
                    logs.push(entry);
                } else {
                    truncated = true;
                }
            }
        }
        if result["outcome"] != "paused" {
            result["logs"] = json!(logs);
            if truncated {
                result["logsTruncated"] = json!(true);
            }
        }
        Ok(result)
    }
    async fn error(&self, details: &Value, cancel: watch::Receiver<bool>) -> Result<Value, Error> {
        let exception = &details["exception"];
        let fields = if !text(exception, "objectId").is_empty() {
            let result=self.send("Runtime.callFunctionOn",json!({"objectId":exception["objectId"],"functionDeclaration":source_fn("error"),"returnByValue":true,"userGesture":false}),cancel).await?;
            result["result"]["value"].clone()
        } else {
            Value::Null
        };
        let bounded = |s: &str, n| validation::redact(s).chars().take(n).collect::<String>();
        let mut error = json!({"name":bounded(fields["name"].as_str().unwrap_or("Error"),128),"message":bounded(fields["message"].as_str().or_else(||exception["description"].as_str()).or_else(||details["text"].as_str()).unwrap_or(""),2048)});
        if let Some(stack) = fields["stack"].as_str() {
            error["stack"] = json!(bounded(stack, 8192));
        }
        Ok(json!({"outcome":"error","error":error}))
    }
}
fn source_fn(name: &str) -> &'static str {
    source(name)
}
fn deliver(mut value: Value) -> Value {
    fn redact(v: &mut Value) {
        match v {
            Value::String(s) => *s = validation::redact(s),
            Value::Array(a) => {
                for v in a {
                    redact(v);
                }
            }
            Value::Object(o) => {
                for v in o.values_mut() {
                    redact(v);
                }
            }
            _ => {}
        }
    }
    redact(&mut value);
    if value.to_string().len() > 65536 {
        json!({"outcome":"completed","valueTruncated":true})
    } else {
        json!({"outcome":"completed","value":value})
    }
}
fn log_entry(event: Event, context: u64) -> Option<Value> {
    let params = event.params?;
    let params: Value = serde_json::from_str(&ycoding_schema::stringify_json(&params)).ok()?;
    if event.method == "Runtime.consoleAPICalled"
        && params["executionContextId"].as_u64() == Some(context)
    {
        let level = match text(&params, "type") {
            "info" => "info",
            "warning" => "warn",
            "error" | "assert" => "error",
            "debug" => "debug",
            _ => "log",
        };
        let text = params["args"]
            .as_array()?
            .iter()
            .map(|a| {
                a["value"].as_str().map(str::to_owned).unwrap_or_else(|| {
                    a.get("value")
                        .map(Value::to_string)
                        .unwrap_or_else(|| text(a, "description").to_owned())
                })
            })
            .collect::<Vec<_>>()
            .join(" ");
        return Some(
            json!({"level":level,"text":validation::redact(&text.chars().take(4096).collect::<String>()).chars().take(2048).collect::<String>()}),
        );
    }
    if event.method == "Runtime.exceptionThrown"
        && params["exceptionDetails"]["executionContextId"].as_u64() == Some(context)
    {
        return Some(
            json!({"level":"error","text":validation::redact(text(&params["exceptionDetails"]["exception"],"description")).chars().take(2048).collect::<String>()}),
        );
    }
    None
}
