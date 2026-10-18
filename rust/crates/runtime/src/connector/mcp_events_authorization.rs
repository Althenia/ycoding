use super::{Control, Credentials, Peer, mcp::Lease};
use std::{sync::Arc, time::Duration};
use ycoding_core::{
    mcp_events::{
        Authorization, Cancellation, Grant, Permit, ResultFuture,
        authorization::{self, Http},
    },
    ycoding_schema::{
        DomainEncode, JsonValue, LosslessString, ObjectEncoder,
        mcp_events::{Failure, FailureCategory, FailureReason, Principal, RequestContext},
        parse_json, stringify_json,
    },
};

pub type LeaseAuthority = Arc<dyn Fn(Option<&str>) -> Option<Lease> + Send + Sync>;

pub struct Dependencies {
    pub credentials: Arc<dyn Credentials>,
    pub lease: LeaseAuthority,
    pub http: Arc<dyn Http>,
    pub clock: Arc<dyn Fn() -> i64 + Send + Sync>,
}
pub struct Authorizer {
    deps: Dependencies,
}
enum Reply {
    Supported,
    Unsupported,
    Grant(Grant),
}
impl Authorizer {
    pub fn new(deps: Dependencies) -> Self {
        Self { deps }
    }
    pub fn production(control: Control) -> Result<Self, Failure> {
        Ok(Self::new(Dependencies {
            credentials: Arc::new(control.device().clone()),
            lease: control.mcp().events_authority(),
            http: Arc::new(authorization::RelayHttp::new()?),
            clock: Arc::new(crate::ids::now_millis),
        }))
    }

    async fn request(
        &self,
        action: &str,
        context: Option<&RequestContext>,
        principal: Option<&Principal>,
        cancellation: Cancellation,
    ) -> Result<Reply, Failure> {
        if cancellation.is_cancelled() {
            return Err(unavailable());
        }
        let epoch = context
            .map(|value| &value.epoch)
            .or_else(|| principal.map(|value| &value.epoch));
        let epoch = epoch
            .map(|epoch| epoch.as_str().ok_or_else(unauthorized))
            .transpose()?;
        if epoch.is_some_and(|epoch| !super::mcp_state::stable_id(epoch)) {
            return Err(unauthorized());
        }
        let lease = (self.deps.lease)(epoch).ok_or_else(|| {
            if (self.deps.lease)(None).is_some() {
                unauthorized()
            } else {
                unavailable()
            }
        })?;
        let (bound, authority) = lease.authority(epoch).ok_or_else(unavailable)?;
        let work = async {
            let enrolled = self
                .deps
                .credentials
                .enrolled()
                .await
                .map_err(|_| unavailable())?;
            let credential = self
                .deps
                .credentials
                .access()
                .await
                .map_err(|_| unauthorized())?;
            let peer = Peer::authenticate(&enrolled, &credential, (self.deps.clock)())
                .map_err(|_| unauthorized())?;
            if !peer.authorized()
                || peer.device() != bound.device()
                || peer.mcp_resource() != bound.mcp_resource()
                || !super::mcp_state::stable_id(peer.device())
            {
                return Err(unauthorized());
            }
            let supplied = context
                .map(|context| context.principal.clone())
                .or_else(|| principal.map(Principal::context));
            if let Some(supplied) = &supplied
                && (supplied.device_id.as_str() != Some(peer.device())
                    || !valid_id(&supplied.owner_id)
                    || !valid_id(&supplied.device_id)
                    || supplied.client_id.is_empty()
                    || supplied.client_id.len() > 2048
                    || supplied
                        .client_id
                        .code_units()
                        .any(|unit| matches!(unit, 0 | 10 | 13)))
            {
                return Err(unauthorized());
            }
            let mut body = ObjectEncoder::new().field("action", action);
            if let Some(context) = context {
                if !valid_id(&context.request_id) {
                    return Err(unauthorized());
                }
                body = body
                    .field("requestID", &context.request_id)
                    .field("principal", &context.principal)
                    .field("epoch", &context.epoch);
            }
            if let Some(principal) = principal {
                if !valid_id(&principal.grant_id) {
                    return Err(unauthorized());
                }
                body = body
                    .field("grantID", &principal.grant_id)
                    .field("principal", &principal.context())
                    .field("epoch", &principal.epoch);
            }
            let mut url = url::Url::parse(&peer.mcp_resource()).map_err(|_| unavailable())?;
            url.set_path(&format!(
                "/api/devices/{}/mcp/events/authorize",
                peer.device()
            ));
            let combined = Cancellation::default();
            let response = tokio::select! {biased;
                _=cancellation.cancelled()=>{combined.cancel();return Err(unavailable());},
                _=authority.cancelled()=>{combined.cancel();return Err(unauthorized());},
                response=tokio::time::timeout(Duration::from_secs(10),self.deps.http.post(authorization::Request{url:url.to_string(),bearer:credential.token.clone(),body:stringify_json(&body.finish())},combined.clone()))=>{combined.cancel();response.map_err(|_|unavailable())??},
            };
            if cancellation.is_cancelled()
                || authority.is_cancelled()
                || lease.authority(epoch).is_none()
            {
                return Err(unauthorized());
            }
            let current = self
                .deps
                .credentials
                .enrolled()
                .await
                .map_err(|_| unavailable())?;
            if cancellation.is_cancelled()
                || authority.is_cancelled()
                || lease.authority(epoch).is_none()
                || (self.deps.lease)(epoch).is_none()
            {
                return Err(unauthorized());
            }
            if Peer::authenticate(&current, &credential, (self.deps.clock)()).is_err() {
                return Err(unavailable());
            }
            if action == "capabilities" && response.status == 404 {
                return Ok(Reply::Unsupported);
            }
            if matches!(response.status, 401 | 403) {
                return Err(unauthorized());
            }
            if response.status != 200 || response.body.len() > 8192 {
                return Err(unavailable());
            }
            let JsonValue::Object(value) = parse_json(&response.body).map_err(|_| unavailable())?
            else {
                return Err(unavailable());
            };
            let get = |key: &str| value.get(&key.into());
            if get("action") != Some(&action.encode()) {
                return Err(unavailable());
            }
            if action == "capabilities" {
                if value.len() != 2 || get("supported") != Some(&JsonValue::Bool(true)) {
                    return Err(unavailable());
                }
                return Ok(Reply::Supported);
            }
            if get("authorized") == Some(&JsonValue::Bool(false)) {
                if value.len() != 3 {
                    return Err(unavailable());
                }
                return Err(match get("reason") {
                    Some(JsonValue::String(reason))
                        if matches!(
                            reason.as_str(),
                            Some("unauthorized" | "forbidden" | "not_found")
                        ) =>
                    {
                        unauthorized()
                    }
                    Some(JsonValue::String(reason)) if reason.as_str() == Some("unavailable") => {
                        unavailable()
                    }
                    _ => unavailable(),
                });
            }
            if get("authorized") != Some(&JsonValue::Bool(true)) || value.len() != 4 {
                return Err(unavailable());
            }
            let Some(JsonValue::String(grant)) = get("grantID") else {
                return Err(unavailable());
            };
            if !valid_id(grant) {
                return Err(unavailable());
            }
            let Some(JsonValue::Number(expires)) = get("expiresAt") else {
                return Err(unavailable());
            };
            if !expires.is_finite()
                || expires.fract() != 0.0
                || *expires <= 0.0
                || *expires > 9_007_199_254_740_991.0
                || (*expires as i64) <= (self.deps.clock)()
            {
                return Err(unavailable());
            }
            if principal.is_some_and(|principal| principal.grant_id != *grant) {
                return Err(unauthorized());
            }
            Ok(Reply::Grant(Grant {
                grant_id: grant.clone(),
                expires_at: *expires as i64,
            }))
        };
        tokio::select! {biased;_=cancellation.cancelled()=>Err(unavailable()),_=authority.cancelled()=>Err(unauthorized()),result=tokio::time::timeout(Duration::from_secs(10),work)=>result.map_err(|_|unavailable())?}
    }
}

impl Authorization for Authorizer {
    fn capabilities(&self, cancellation: Cancellation) -> ResultFuture<'_, bool> {
        Box::pin(async move {
            if (self.deps.lease)(None).is_none() {
                return Ok(false);
            }
            self.request("capabilities", None, None, cancellation)
                .await
                .map(|reply| matches!(reply, Reply::Supported))
        })
    }
    fn resolve(
        &self,
        context: RequestContext,
        cancellation: Cancellation,
    ) -> ResultFuture<'_, Grant> {
        Box::pin(async move {
            let Reply::Grant(grant) = self
                .request("resolve", Some(&context), None, cancellation)
                .await?
            else {
                return Err(unavailable());
            };
            Ok(grant)
        })
    }
    fn check(&self, principal: Principal, cancellation: Cancellation) -> ResultFuture<'_, Permit> {
        Box::pin(async move {
            let Reply::Grant(grant) = self
                .request("check", None, Some(&principal), cancellation)
                .await?
            else {
                return Err(unavailable());
            };
            let epoch = principal.epoch.as_str().ok_or_else(unauthorized)?;
            let lease = (self.deps.lease)(Some(epoch)).ok_or_else(unavailable)?;
            let (_, cancellation) = lease.authority(Some(epoch)).ok_or_else(unavailable)?;
            Ok(Permit {
                expires_at: grant.expires_at,
                cancellation,
            })
        })
    }
}

fn valid_id(value: &LosslessString) -> bool {
    value.as_str().is_some_and(super::mcp_state::stable_id)
}
fn unavailable() -> Failure {
    Failure {
        category: FailureCategory::Unavailable,
        reason: FailureReason::AuthorizationUnavailable,
    }
}
fn unauthorized() -> Failure {
    Failure {
        category: FailureCategory::Unauthorized,
        reason: FailureReason::GrantRevoked,
    }
}
