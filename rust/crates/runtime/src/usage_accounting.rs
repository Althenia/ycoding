use crate::{
    Core, convert,
    dispatch::{Failure, Invocation},
    ids,
};
use std::collections::BTreeSet;
use ycoding_core::session::{
    store,
    usage_accounting::{Context, Error},
};
use ycoding_core::ycoding_schema::{
    DomainDecode, JsonValue, LosslessString, ObjectEncoder, token_usage,
    usage_accounting::{
        Breakdown, Cost, Helper, PromptCost, PromptCosts, PromptInput, TaskCost, TaskCosts,
        TaskInput,
    },
    usage_anchor,
};
use ycoding_protocol::v5;

const SOURCES: [&str; 7] = [
    "step",
    "title",
    "goal",
    "compaction",
    "decision",
    "prediction",
    "prompt",
];
const PROVENANCES: [&str; 2] = ["recorded", "current_catalog"];
const STATUSES: [&str; 2] = ["settled", "so-far"];
const ATTRIBUTIONS: [&str; 3] = ["complete", "partial", "unattributed"];
const HISTORIES: [&str; 2] = ["retained", "partial"];

pub async fn prompt_costs(
    invocation: Invocation,
    request: v5::SessionPromptCostsRequest,
) -> Result<v5::SessionPromptCostsResult, Failure> {
    let core = invocation.core()?;
    let id = invocation.session(&request.params.session_id)?;
    let input = PromptInput::decode(&identifiers("inputIDs", &request.query.input_i_ds.items)?)
        .map_err(|_| Failure::InvalidField {
            message: "Accounting lookup requires 1 to 100 distinct message IDs".into(),
            field: "inputIDs",
        })?;
    let costs = read(core, move |sessions, context| {
        sessions.prompt_costs(&id, &input, context)
    })
    .await?;
    Ok(v5::SessionPromptCostsResult {
        data: prompt_wire(&costs)?,
    })
}

pub async fn task_costs(
    invocation: Invocation,
    request: v5::SessionTaskCostsRequest,
) -> Result<v5::SessionTaskCostsResult, Failure> {
    let core = invocation.core()?;
    let id = invocation.session(&request.params.session_id)?;
    let input = TaskInput::decode(&identifiers(
        "sessionIDs",
        &request.query.session_i_ds.items,
    )?)
    .map_err(|_| Failure::InvalidField {
        message: "Accounting lookup requires 1 to 100 distinct Session IDs".into(),
        field: "sessionIDs",
    })?;
    let costs = read(core, move |sessions, context| {
        sessions.task_costs(&id, &input, context)
    })
    .await?;
    Ok(v5::SessionTaskCostsResult {
        data: task_wire(&costs)?,
    })
}

fn identifiers(field: &str, items: &[v5::LosslessString]) -> Result<JsonValue, Failure> {
    let items = items
        .iter()
        .map(|item| convert::domain(item).map(JsonValue::String))
        .collect::<Result<Vec<_>, _>>()?;
    Ok(ObjectEncoder::new()
        .field(field, &JsonValue::Array(items))
        .finish())
}

async fn read<T: Send + 'static>(
    core: &Core,
    read: impl FnOnce(&store::Service, &Context<'_>) -> Result<T, Error> + Send + 'static,
) -> Result<T, Failure> {
    let sessions = core.sessions.clone();
    let pricer = core.usage_pricer.clone();
    let retention = core.retention.clone();
    let active = core.execution.active().into_iter().collect::<BTreeSet<_>>();
    tokio::task::spawn_blocking(move || {
        read(
            &sessions,
            &Context {
                now: ids::now_millis(),
                records_days: retention().records_days,
                active: &active,
                pricer: pricer.as_deref().map(|pricer| pricer as &_),
            },
        )
    })
    .await
    .map_err(|_| Failure::Unavailable("Usage read worker unavailable".into()))?
    .map_err(|error| match error {
        Error::SessionNotFound(id) => Failure::SessionNotFound(convert::readable(id.as_lossless())),
        Error::Store(_) => Failure::Unavailable("Session store unavailable".into()),
    })
}

fn prompt_wire(costs: &PromptCosts) -> Result<v5::UsageAccountingPromptCosts, Failure> {
    Ok(v5::UsageAccountingPromptCosts {
        units: v5::UsageAccountingPromptCostsUnits {
            items: costs
                .units
                .iter()
                .map(prompt_unit)
                .collect::<Result<_, _>>()?,
        },
        unattributed: breakdown(&costs.unattributed)?,
        history: tag(&HISTORIES, &costs.history.0)?,
    })
}

fn prompt_unit(unit: &PromptCost) -> Result<v5::UsageAccountingPromptCost, Failure> {
    Ok(v5::UsageAccountingPromptCost {
        anchor: anchor(&unit.anchor),
        status: tag(&STATUSES, &unit.status.0)?,
        attribution: tag(&ATTRIBUTIONS, &unit.attribution.0)?,
        history: tag(&HISTORIES, &unit.history.0)?,
        total: breakdown(&unit.total)?,
        main: breakdown(&unit.main)?,
        children: breakdown(&unit.children)?,
        helpers: v5::UsageAccountingPromptCostHelpers {
            items: helpers(&unit.helpers)?,
        },
    })
}

fn task_wire(costs: &TaskCosts) -> Result<v5::UsageAccountingTaskCosts, Failure> {
    Ok(v5::UsageAccountingTaskCosts {
        tasks: v5::UsageAccountingTaskCostsTasks {
            items: costs
                .tasks
                .iter()
                .map(task_unit)
                .collect::<Result<_, _>>()?,
        },
        total: breakdown(&costs.total)?,
        history: tag(&HISTORIES, &costs.history.0)?,
    })
}

fn task_unit(task: &TaskCost) -> Result<v5::UsageAccountingTaskCost, Failure> {
    Ok(v5::UsageAccountingTaskCost {
        session_id: convert::wire(task.session_id.as_lossless()),
        usage_anchor: task.usage_anchor.as_ref().map(anchor),
        status: tag(&STATUSES, &task.status.0)?,
        attribution: tag(&ATTRIBUTIONS, &task.attribution.0)?,
        history: tag(&HISTORIES, &task.history.0)?,
        total: breakdown(&task.total)?,
        main: breakdown(&task.main)?,
        children: breakdown(&task.children)?,
        helpers: v5::UsageAccountingTaskCostHelpers {
            items: helpers(&task.helpers)?,
        },
    })
}

fn anchor(value: &usage_anchor::Ref) -> v5::UsageAnchorRef {
    v5::UsageAnchorRef {
        session_id: convert::wire(value.session_id.as_lossless()),
        input_id: convert::wire(value.input_id.as_lossless()),
    }
}

fn breakdown(value: &Breakdown) -> Result<v5::UsageAccountingBreakdown, Failure> {
    Ok(v5::UsageAccountingBreakdown {
        requests: value.requests.get() as u64,
        tokens: tokens(&value.tokens),
        cost: v5::UsageAccountingBreakdownCost {
            total: value.cost.total.map(|usd| usd.get()),
            known: value.cost.known.map(|usd| usd.get()),
            priced_requests: value.cost.priced_requests.get() as u64,
            unpriced_requests: value.cost.unpriced_requests.get() as u64,
            provenance: provenance(&value.cost)?,
        },
    })
}

fn helpers(values: &[Helper]) -> Result<Vec<v5::UsageAccountingHelper>, Failure> {
    values
        .iter()
        .map(|helper| {
            Ok(v5::UsageAccountingHelper {
                source: tag(&SOURCES, &helper.source.0)?,
                requests: helper.requests.get() as u64,
                tokens: tokens(&helper.tokens),
                cost: v5::UsageAccountingHelperCost {
                    total: helper.cost.total.map(|usd| usd.get()),
                    known: helper.cost.known.map(|usd| usd.get()),
                    priced_requests: helper.cost.priced_requests.get() as u64,
                    unpriced_requests: helper.cost.unpriced_requests.get() as u64,
                    provenance: provenance(&helper.cost)?,
                },
            })
        })
        .collect()
}

fn provenance(cost: &Cost) -> Result<Option<i32>, Failure> {
    cost.provenance
        .as_ref()
        .map(|provenance| tag(&PROVENANCES, &provenance.0))
        .transpose()
}

fn tokens(info: &token_usage::Info) -> v5::TokenUsageInfo {
    v5::TokenUsageInfo {
        input: info.input.get(),
        output: info.output.get(),
        reasoning: info.reasoning.get(),
        cache: v5::TokenUsageInfoCache {
            read: info.cache.read.get(),
            write: info.cache.write.get(),
        },
    }
}

fn tag(names: &[&str], value: &LosslessString) -> Result<i32, Failure> {
    names
        .iter()
        .position(|name| value.as_str() == Some(*name))
        .map(|index| index as i32 + 1)
        .ok_or_else(|| {
            Failure::Unavailable("stored usage accounting is not representable on the wire".into())
        })
}
