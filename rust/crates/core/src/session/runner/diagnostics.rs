use super::{Local, Work, error, publisher};
use crate::session::{
    cache_diagnostics, context_pressure, diagnostics, projector, run_coordinator::Outcome, usage,
};
use ycoding_ai::llm;
use ycoding_schema::{
    DomainDecode, JsonValue,
    money::Usd,
    provider_request::Timing,
    schema::NonNegativeInt,
    session_cache_diagnostics::{ContextBreakdown, ProviderCache},
    token_usage,
};

impl Local {
    pub(super) fn publish_diagnostics(
        &self,
        request: &llm::Request,
        publisher: &publisher::Publisher,
        work: &Work,
    ) -> Outcome {
        let services = &self.0.services;
        let settlement = publisher
            .settlement
            .as_ref()
            .ok_or_else(|| error("stream", "Step finish did not settle"))?;
        let recording = work
            .recording
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let recording = recording
            .as_ref()
            .ok_or_else(|| error("stream", "Step has no request recording"))?;
        let tokens = usage::tokens(settlement.usage.as_ref());
        let timing = self
            .timing(work, settlement.usage.as_ref())?
            .map(|value| Timing::decode(&value))
            .transpose()
            .map_err(projector::record_error)?;
        let breakdown = context_pressure::breakdown(context_pressure::Usage {
            system: &request.system,
            tools: &request.tools,
            messages: &request.messages,
        });
        let count = |value| NonNegativeInt::new(value).map_err(projector::record_error);
        let mut diagnostics = diagnostics::calculate(diagnostics::Calculation {
            model: recording.tracked.begin.model.clone(),
            tokens: token_usage::Info::decode(&tokens).map_err(projector::record_error)?,
            estimated_cost: Usd::new(usage::cost(
                &recording.costs,
                &tokens,
                usage::one_hour_cache_writes(settlement.usage.as_ref()),
            ))
            .map_err(projector::record_error)?,
            context_limit: request
                .model
                .defaults
                .context_limit
                .map(|limit| NonNegativeInt::decode(&JsonValue::Number(limit)))
                .transpose()
                .map_err(projector::record_error)?,
            context_breakdown: Some(ContextBreakdown {
                system: count(breakdown.system)?,
                tools: count(breakdown.tools)?,
                user: count(breakdown.user)?,
                assistant: count(breakdown.assistant)?,
                reasoning: count(breakdown.reasoning)?,
                tool_calls: count(breakdown.tool_calls)?,
                other: count(breakdown.other)?,
            }),
            provider_cache: Some(
                ProviderCache::decode(&cache_diagnostics::provider_cache(
                    &request.model.route.id,
                    request.model.provider.0.as_str().unwrap_or_default(),
                    settlement.usage.as_ref(),
                ))
                .map_err(projector::record_error)?,
            ),
        })?;
        diagnostics.generation_speed = services.store.generation_speed(
            &publisher.session,
            (recording.tracked.begin.model.clone(), timing),
        )?;
        services
            .events
            .emit(
                crate::event_feed::Data::SessionDiagnosticsUpdated(Box::new(
                    crate::event_feed::ephemeral::Diagnostics {
                        session_id: publisher.session.clone(),
                        diagnostics,
                    },
                )),
                Some(services.location.clone()),
            )
            .map_err(|message| error("stream", &message))
    }
}
