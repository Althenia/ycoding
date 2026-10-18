use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet},
    ops::Bound,
    path::PathBuf,
};
use ycoding_schema::{DomainDecode, DomainEncode, parse_json, stringify_json};
use ycoding_store::{
    Metadata, Options, Store, TableSpec,
    import::{DatabaseKind, catalog},
    resources::{UsageAnalyticsRequest, UsageAnalyticsRequestTable},
    session::Document,
};

const DAY: i64 = 86_400_000;
const BATCH: usize = 2_000;
const PROVIDERS: [&str; 4] = ["openai", "anthropic", "google", "xai"];

struct Recipe {
    store: PathBuf,
    locations_root: String,
    now: i64,
    rows: i64,
    locations: i64,
    unpriced_locations: i64,
}

#[derive(Default)]
struct Population {
    model: Value,
    requests: u64,
    recorded: u64,
    recorded_cost: f64,
    decision_unpriced: u64,
    catalog_priced: u64,
    input: f64,
    output: f64,
    reasoning: f64,
    cache_read: f64,
    cache_write: f64,
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let recipe = recipe()?;
    let store = Store::initialize(
        &recipe.store,
        Options::core(),
        catalog(DatabaseKind::Core),
        Metadata::new([0x5a; 16], 1),
    )?;
    let client = store.client();
    let mut start = 0;
    while start < recipe.rows {
        let end = (start + BATCH as i64).min(recipe.rows);
        let records = (start..end)
            .map(|index| fact(&recipe, index))
            .collect::<Result<Vec<_>, _>>()?;
        client
            .submit(move |tx| {
                for record in &records {
                    UsageAnalyticsRequestTable::insert(tx, record)?;
                }
                Ok(())
            })?
            .wait()?;
        start = end;
    }
    drop(client);
    store.shutdown()?;
    let reopened = Store::open(&recipe.store, Options::core(), catalog(DatabaseKind::Core))?;
    let shape = inspect(&reopened)?;
    reopened.shutdown()?;
    println!("{shape}");
    Ok(())
}

fn recipe() -> Result<Recipe, Box<dyn std::error::Error>> {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    let [
        store,
        locations_root,
        now,
        rows,
        locations,
        unpriced_locations,
    ] = args.as_slice()
    else {
        return Err(
            "usage: usage_performance_seed <new-store> <locations-root> <now-ms> <rows> <locations> <unpriced-locations>"
                .into(),
        );
    };
    let recipe = Recipe {
        store: PathBuf::from(store),
        locations_root: locations_root.clone(),
        now: now.parse()?,
        rows: rows.parse()?,
        locations: locations.parse()?,
        unpriced_locations: unpriced_locations.parse()?,
    };
    if recipe.rows <= 0
        || recipe.locations <= 0
        || recipe.unpriced_locations < 0
        || recipe.unpriced_locations > recipe.locations
        || recipe.now <= 30 * DAY
    {
        return Err("invalid seed recipe".into());
    }
    Ok(recipe)
}

fn fact(recipe: &Recipe, index: i64) -> Result<UsageAnalyticsRequest, ycoding_store::Error> {
    let location = index % recipe.locations;
    let family = (index / 7) % 12;
    let unpriced = location < recipe.unpriced_locations;
    let model = if unpriced {
        json!({"providerID": "local", "id": format!("local-{}", index % 3)})
    } else {
        let mut model = json!({
            "providerID": PROVIDERS[(family % 4) as usize],
            "id": format!("model-{family:02}"),
        });
        if family % 3 == 0 {
            model["variant"] = json!("high");
        }
        if family % 5 == 0 {
            model["profile"] = json!("work");
        }
        model
    };
    Ok(UsageAnalyticsRequest {
        id: format!("prq_perf_{index:07}").into(),
        session_id: format!("ses_perf_{:05}", index % 20_000).into(),
        project_id: format!("prj_perf_{:02}", location % 50).into(),
        directory: format!("{}/location-{location:04}", recipe.locations_root).into(),
        workspace_id: None,
        session_updated: recipe.now - index % 20_000,
        agent: "build".into(),
        source: if index % 41 == 0 {
            "title"
        } else if index % 97 == 0 {
            "decision"
        } else {
            "step"
        }
        .into(),
        model: canonical(model)?,
        usage_anchor: None,
        task_path: canonical(json!([]))?,
        request: index / 20_000 + 1,
        attempts: 1 + i64::from(index % 50 == 0),
        continuation: if index % 53 == 0 {
            "continued"
        } else if index % 89 == 0 {
            "fallback"
        } else {
            "full"
        }
        .into(),
        invalidation: if index % 20_000 == 0 {
            "first-request"
        } else {
            "stable-hit"
        }
        .into(),
        prompt_cache_key: "perfkey0".into(),
        cache_read_reported: Some(1),
        tokens: canonical(json!({
            "input": 1_000 + index % 9_000,
            "output": 100 + index % 900,
            "reasoning": index % 300,
            "cache": {"read": index % 5_000, "write": index % 700},
        }))?,
        cost: (!unpriced).then_some((index % 17) as f64 * 0.0001),
        timing: Some(canonical(json!({
            "firstOutputMs": 200 + index % 3_000,
            "totalMs": 1_000 + index % 60_000,
            "generatedTokens": 100 + index % 900,
            "generationDurationNs": 1_000_000_000 + (index % 9) * 100_000_000,
        }))?),
        time_created: recipe.now
            - ((index as f64 * (30 * DAY - 1) as f64) / recipe.rows as f64) as i64,
    })
}

fn canonical<T: DomainDecode + DomainEncode>(
    value: Value,
) -> Result<Document<T>, ycoding_store::Error> {
    Document::from_domain(
        &Document::<T>::new(parse_json(&value.to_string()).expect("serde_json emits valid JSON"))?
            .domain()?,
    )
}

fn inspect(store: &Store) -> Result<Value, Box<dyn std::error::Error>> {
    let snapshot = store.client().snapshot()?;
    let mut populations = BTreeMap::<String, Population>::new();
    let mut directories = BTreeSet::new();
    let mut unpriced = BTreeSet::new();
    let mut rows = 0u64;
    let mut oldest = i64::MAX;
    let mut newest = i64::MIN;
    let mut after = None::<Vec<u8>>;
    loop {
        let page = snapshot.scan::<UsageAnalyticsRequestTable>(
            after.as_deref().map_or(Bound::Unbounded, Bound::Excluded),
            Bound::Unbounded,
            BATCH,
        )?;
        let Some(last) = page.last() else {
            break;
        };
        after = Some(UsageAnalyticsRequestTable::primary_key(last));
        for record in page {
            rows += 1;
            oldest = oldest.min(record.time_created);
            newest = newest.max(record.time_created);
            let directory = record.directory.to_utf8()?;
            directories.insert(directory.clone());
            let model = stringify_json(record.model.value());
            let population = populations.entry(model.clone()).or_default();
            population.model = serde_json::from_str(&model)?;
            population.requests += 1;
            let Some(cost) = record.cost else {
                unpriced.insert(directory);
                if record.source.as_str() == Some("decision") {
                    population.decision_unpriced += 1;
                    continue;
                }
                let tokens = record.tokens.domain()?;
                population.catalog_priced += 1;
                population.input += tokens.input.get();
                population.output += tokens.output.get();
                population.reasoning += tokens.reasoning.get();
                population.cache_read += tokens.cache.read.get();
                population.cache_write += tokens.cache.write.get();
                continue;
            };
            population.recorded += 1;
            population.recorded_cost += cost;
        }
    }
    Ok(json!({
        "rows": rows,
        "locations": directories.len(),
        "unpricedDirectories": unpriced,
        "oldest": oldest,
        "newest": newest,
        "populations": populations.into_values().map(|population| json!({
            "model": population.model,
            "requests": population.requests,
            "recorded": population.recorded,
            "recordedCost": population.recorded_cost,
            "decisionUnpriced": population.decision_unpriced,
            "catalogPriced": population.catalog_priced,
            "catalogTokens": {
                "input": population.input,
                "output": population.output,
                "reasoning": population.reasoning,
                "cacheRead": population.cache_read,
                "cacheWrite": population.cache_write,
            },
        })).collect::<Vec<_>>(),
    }))
}
