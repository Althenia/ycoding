use super::{Error, route};
use std::{collections::BTreeMap, future::Future, pin::Pin, sync::Arc};
use ycoding_ai::{
    llm,
    route::{Executor, Prepared, Protocol, StreamParser},
};
use ycoding_schema::{JsonValue, credential, model};

pub(crate) type Guard = Arc<dyn Fn() -> Result<(), ycoding_ai::Error> + Send + Sync>;

pub(crate) fn resolve(
    info: &model::Info,
    secret: &credential::Value,
    integration: &str,
    guard: Guard,
) -> Result<llm::Model, Error> {
    if !matches!(
        info.package.as_ref().and_then(|value| value.as_str()),
        Some("@ycoding-ai/ai/providers/openai" | "@ycoding-ai/ai/providers/openai/responses")
    ) {
        return Err(Error::UnsupportedPackage);
    }
    let usable = match secret {
        credential::Value::Key(value) => {
            value.key.as_str().is_some_and(|key| !key.trim().is_empty())
        }
        credential::Value::OAuth(value) => {
            integration == "openai"
                && matches!(
                    value.method_id.as_lossless().as_str(),
                    Some("chatgpt-browser" | "chatgpt-headless")
                )
                && value
                    .access
                    .as_str()
                    .is_some_and(|access| !access.trim().is_empty())
        }
    };
    if !usable {
        return Err(Error::ProfileUnavailable);
    }
    let mut model = route::from_catalog_model_environment(
        info,
        Some(secret),
        &BTreeMap::new(),
        env!("CARGO_PKG_VERSION"),
    )?;
    let mut route = (*model.route).clone();
    route.protocol = Arc::new(Fenced {
        protocol: route.protocol.clone(),
        guard,
    });
    model.route = Arc::new(route);
    Ok(model)
}

struct Fenced {
    protocol: Arc<dyn Protocol>,
    guard: Guard,
}

impl Protocol for Fenced {
    fn id(&self) -> &'static str {
        self.protocol.id()
    }
    fn response_formats(&self) -> &'static [&'static str] {
        self.protocol.response_formats()
    }
    fn lower(&self, request: &llm::Request) -> Result<JsonValue, ycoding_ai::Error> {
        (self.guard)()?;
        self.protocol.lower(request)
    }
    fn parser(&self, request: &llm::Request) -> Box<dyn StreamParser> {
        self.protocol.parser(request)
    }
    fn terminal(&self, event: &JsonValue) -> bool {
        self.protocol.terminal(event)
    }
    fn request_headers(
        &self,
        request: &llm::Request,
        headers: reqwest::header::HeaderMap,
    ) -> Result<reqwest::header::HeaderMap, ycoding_ai::Error> {
        (self.guard)()?;
        self.protocol.request_headers(request, headers)
    }
    fn response_headers(&self, request: &llm::Request, headers: &reqwest::header::HeaderMap) {
        self.protocol.response_headers(request, headers)
    }
    fn wire_body(
        &self,
        request: &llm::Request,
        body: JsonValue,
    ) -> Result<JsonValue, ycoding_ai::Error> {
        (self.guard)()?;
        self.protocol.wire_body(request, body)
    }
    fn dispatch<'a>(
        &'a self,
        executor: &'a Executor,
        prepared: &'a mut Prepared,
    ) -> Pin<Box<dyn Future<Output = Result<reqwest::Response, ycoding_ai::Error>> + Send + 'a>>
    {
        Box::pin(async move {
            (self.guard)()?;
            self.protocol.dispatch(executor, prepared).await
        })
    }
}
