use super::oauth::Error;
use crate::resources::auth::page;
use serde_json::Value;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::watch,
    task::{JoinHandle, JoinSet},
};
use url::Url;

pub(crate) struct Callback {
    code: watch::Receiver<Option<Result<String, Error>>>,
    stop: watch::Sender<bool>,
    task: Option<JoinHandle<Result<(), Error>>>,
}
impl Callback {
    pub(crate) fn new(
        listener: TcpListener,
        redirect: Url,
        state: String,
        provider: String,
        metadata: Option<Value>,
    ) -> Self {
        let (code, receiver) = watch::channel(None);
        let (stop, mut stopping) = watch::channel(false);
        let task = tokio::spawn(async move {
            let mut requests = JoinSet::new();
            loop {
                tokio::select! {
                    _=stopping.changed()=>break,
                    accepted=listener.accept()=> {
                        let (stream,_)=accepted.map_err(|_|Error::Callback)?;
                        let redirect=redirect.clone();let state=state.clone();let provider=provider.clone();let code=code.clone();let metadata=metadata.clone();
                        requests.spawn(async move {serve(stream,redirect,state,provider,code,metadata).await});
                    },
                    completed=requests.join_next(),if !requests.is_empty()=> {
                        match completed {Some(Ok(Ok(())))=>(),_=>{settle(&code,Err(Error::Callback));break;} }
                    },
                }
            }
            requests.abort_all();
            while let Some(result) = requests.join_next().await {
                if result.is_err_and(|error| !error.is_cancelled()) {
                    return Err(Error::Callback);
                }
            }
            Ok(())
        });
        Self {
            code: receiver,
            stop,
            task: Some(task),
        }
    }
    pub(crate) async fn wait(&mut self) -> Result<String, Error> {
        loop {
            if let Some(result) = self.code.borrow_and_update().clone() {
                return result;
            }
            self.code.changed().await.map_err(|_| Error::Callback)?;
        }
    }
    pub(crate) async fn close(&mut self) -> Result<(), Error> {
        self.stop.send_replace(true);
        if let Some(task) = self.task.take() {
            task.await.map_err(|_| Error::Callback)??;
        }
        Ok(())
    }
}
impl Drop for Callback {
    fn drop(&mut self) {
        self.stop.send_replace(true);
        if let Some(task) = &self.task {
            task.abort();
        }
    }
}
fn settle(sender: &watch::Sender<Option<Result<String, Error>>>, result: Result<String, Error>) {
    sender.send_if_modified(|current| {
        if current.is_some() {
            return false;
        }
        *current = Some(result);
        true
    });
}
async fn serve(
    mut stream: TcpStream,
    redirect: Url,
    state: String,
    provider: String,
    code: watch::Sender<Option<Result<String, Error>>>,
    metadata: Option<Value>,
) -> Result<(), Error> {
    let mut request = Vec::new();
    let mut buffer = [0; 1024];
    while !request.windows(4).any(|part| part == b"\r\n\r\n") {
        let len = stream
            .read(&mut buffer)
            .await
            .map_err(|_| Error::Callback)?;
        if len == 0 || request.len() + len > 16384 {
            return Err(Error::Callback);
        }
        request.extend_from_slice(&buffer[..len]);
    }
    let target = std::str::from_utf8(&request)
        .ok()
        .and_then(|request| request.lines().next())
        .and_then(|line| line.split_whitespace().nth(1))
        .ok_or(Error::Callback)?;
    let callback = redirect.join(target).map_err(|_| Error::Callback)?;
    if callback.path() != redirect.path() {
        return stream.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 9\r\nConnection: close\r\n\r\nNot found").await.map_err(|_|Error::Callback);
    }
    let params = callback
        .query_pairs()
        .collect::<std::collections::BTreeMap<_, _>>();
    let error = params
        .get("error_description")
        .or_else(|| params.get("error"))
        .filter(|error| !error.is_empty());
    let issuer = params.get("iss").map(|value| value.as_ref());
    let verified = metadata.as_ref().is_none_or(|metadata| match issuer {
        Some(issuer) => Some(issuer) == metadata["issuer"].as_str(),
        None => metadata["authorization_response_iss_parameter_supported"] != true,
    });
    let (result, detail) =
        if params.get("state").map(|value| value.as_ref()) != Some(state.as_str()) {
            (
                Err(Error::StateMismatch),
                Some("OAuth state mismatch".into()),
            )
        } else if !verified || (error.is_some() && metadata.is_none()) {
            (
                Err(Error::IssuerMismatch),
                Some("OAuth issuer mismatch".into()),
            )
        } else if let Some(error) = error {
            (Err(Error::Rejected), Some(error.to_string()))
        } else {
            match params.get("code").filter(|value| !value.is_empty()) {
                Some(code) => (Ok(code.to_string()), None),
                None => (
                    Err(Error::CodeRequired),
                    Some("Missing authorization code".into()),
                ),
            }
        };
    let (status, body) = match detail {
        Some(detail) => (400, page::error(&detail, Some(&provider))),
        None => (200, page::success(Some(&provider), true)),
    };
    stream.write_all(format!("HTTP/1.1 {status} OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).as_bytes()).await.map_err(|_|Error::Callback)?;
    settle(&code, result);
    Ok(())
}
