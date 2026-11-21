use super::{
    core_adapter::{from_core_signal, to_core_signal},
    error::{CallError, RpcError},
    handler::{CallOptions, Caller},
    types::Text,
    wire_process::{
        AuditDecision, DecisionSource, NETWORK_POLICY_DECISION_METHOD, NetworkDecision,
        NetworkPolicyAuditEvent, NetworkPolicyDecider, NetworkPolicyRequest, NetworkProtocol,
        encode_network_policy_decision,
    },
};
use std::sync::Arc;
use ycoding_core::cca::{
    error::{BoxFuture, ExecutorError},
    executor::{self as cx, NetworkPolicyFactory},
    network_proxy as core_proxy,
    value::Value,
};

fn protocol(value: core_proxy::NetworkProtocol) -> NetworkProtocol {
    match value {
        core_proxy::NetworkProtocol::Http => NetworkProtocol::Http,
        core_proxy::NetworkProtocol::HttpsConnect => NetworkProtocol::HttpsConnect,
        core_proxy::NetworkProtocol::Socks5Tcp => NetworkProtocol::Socks5Tcp,
        core_proxy::NetworkProtocol::Socks5Udp => NetworkProtocol::Socks5Udp,
    }
}

fn source(value: core_proxy::DecisionSource) -> DecisionSource {
    match value {
        core_proxy::DecisionSource::BaselinePolicy => DecisionSource::BaselinePolicy,
        core_proxy::DecisionSource::ModeGuard => DecisionSource::ModeGuard,
        core_proxy::DecisionSource::ProxyState => DecisionSource::ProxyState,
        core_proxy::DecisionSource::Decider => DecisionSource::Decider,
    }
}

fn audit_decision(value: &str) -> AuditDecision {
    match value {
        "allow" => AuditDecision::Allow,
        "ask" => AuditDecision::Ask,
        _ => AuditDecision::Deny,
    }
}

pub fn audit_event(event: core_proxy::NetworkPolicyAuditEvent) -> NetworkPolicyAuditEvent {
    NetworkPolicyAuditEvent {
        timestamp: event.timestamp,
        decision: audit_decision(event.decision),
        source: source(event.source),
        reason: event.reason,
        protocol: protocol(event.protocol),
        host: event.host,
        port: event.port,
        method: event.method,
        client: event.client,
        policy_override: event.policy_override,
    }
}

fn call_failure(error: ExecutorError) -> CallError {
    CallError::Remote(RpcError::new(i64::from(error.code), error.message))
}

pub fn caller(call: cx::SessionCall) -> Caller {
    Caller::new(Arc::new(move |method, params, options: CallOptions| {
        let call = call.clone();
        let future: BoxFuture<'static, Result<Value, CallError>> = Box::pin(async move {
            let (signal, _bridge) = match &options.signal {
                Some(signal) => {
                    let (signal, bridge) = to_core_signal(signal);
                    (Some(signal), Some(bridge))
                }
                None => (None, None),
            };
            call(
                method,
                params,
                cx::CallOptions {
                    timeout_ms: options.timeout.map(|timeout| timeout.as_millis() as u64),
                    signal,
                },
            )
            .await
            .map_err(call_failure)
        });
        future
    }))
}

fn decision(value: NetworkDecision) -> core_proxy::NetworkDecision {
    match value {
        NetworkDecision::Allow => core_proxy::NetworkDecision::Allow,
        NetworkDecision::Deny { reason } => core_proxy::NetworkDecision::Deny(reason),
        NetworkDecision::Ask { reason } => core_proxy::NetworkDecision::Ask(reason),
    }
}

#[derive(Clone, Copy, Default)]
pub struct RuntimeNetworkPolicy;

impl NetworkPolicyFactory for RuntimeNetworkPolicy {
    fn hooks(&self, input: cx::NetworkPolicyInput) -> cx::NetworkPolicyHooks {
        let process_id: Text = input.process_id.clone();
        let decider = input
            .launch
            .policy_decision_timeout_ms
            .map(|controller_timeout_ms| {
                let (signal, bridge) = from_core_signal(&input.signal);
                let decider = Arc::new(NetworkPolicyDecider::new(
                    process_id.clone(),
                    controller_timeout_ms,
                    caller(input.call.clone()),
                    Some(signal),
                    None,
                ));
                let bridge = Arc::new(bridge);
                let decide: core_proxy::NetworkPolicyDecider =
                    Arc::new(move |request: core_proxy::NetworkPolicyRequest| {
                        let (decider, bridge) = (decider.clone(), bridge.clone());
                        let future: BoxFuture<'static, Result<core_proxy::NetworkDecision, ()>> =
                            Box::pin(async move {
                                let _held = bridge;
                                Ok(decision(
                                    decider
                                        .decide(&NetworkPolicyRequest {
                                            protocol: protocol(request.protocol),
                                            host: request.host,
                                            port: request.port,
                                        })
                                        .await,
                                ))
                            });
                        future
                    });
                decide
            });
        let notify = input.notify.clone();
        let listener: core_proxy::PolicyDecisionListener = Arc::new(move |event| {
            notify(
                NETWORK_POLICY_DECISION_METHOD.to_string(),
                encode_network_policy_decision(&process_id, &audit_event(event)),
            );
        });
        cx::NetworkPolicyHooks {
            decider,
            on_policy_decision: Some(listener),
        }
    }
}
