use super::{Authority, Error, text};
use crate::platform::computer::boundary::{Context, Held, Permission, Policy, Review};
use serde_json::{Value, json};
use std::sync::{Arc, LazyLock};
use url::Url;

pub fn decode_input(input: &Value) -> Result<(), Error> {
    static INPUT: LazyLock<jsonschema::Validator> = LazyLock::new(|| {
        let contract: Value =
            serde_json::from_str(include_str!("../../tools/builtin/interaction.tool.json"))
                .expect("tool contract");
        super::validation::compile(&contract["inputSchema"])
    });
    if INPUT.is_valid(input) {
        Ok(())
    } else {
        Err(Error("invalid"))
    }
}
pub async fn execute(
    authority: &Arc<Authority>,
    policy: &dyn Policy,
    context: &Context,
    input: Value,
) -> Result<Value, String> {
    decode_input(&input).map_err(|e| e.to_string())?;
    let session = &context.owner.session_id;
    if !authority.usable(session) {
        authority.revoke(session);
        return Err("Interaction is unavailable for this Session".into());
    }
    let operation = text(&input, "operation");
    if operation == "status" {
        return Ok(json!({"type":"status","status":authority.status(session)}));
    }
    if operation == "request" {
        let selection = &input["selection"];
        let url = selection["url"]
            .as_str()
            .map(Url::parse)
            .transpose()
            .map_err(|_| "Interaction requires a valid HTTP(S) URL")?;
        let resource = url
            .as_ref()
            .map(|u| format!("{}{}", u.origin().ascii_serialization(), u.path()))
            .unwrap_or_else(|| text(selection, "platform").to_owned());
        let metadata = json!({"operation":"request","operationDigest":digest(selection)});
        permission(
            policy,
            context,
            "interaction",
            vec![resource.clone()],
            metadata.clone(),
        )
        .await?;
        let _held = if url.is_some() {
            Some(Held(
                policy
                    .review(
                        context,
                        Review {
                            action: "browser_owned_open".into(),
                            resources: vec![resource],
                            metadata,
                            skip_review: false,
                        },
                    )
                    .await?,
            ))
        } else {
            None
        };
        return Ok(
            json!({"type":"status","status":authority.request(session,selection.clone()).map_err(|e|e.to_string())?}),
        );
    }
    let generation = text(&input, "generation");
    let current = authority.status(session);
    if current["state"] == "paused" && current["generation"] == generation {
        return Ok(if operation == "run" {
            json!({"type":"script","result":{"outcome":"paused","reason":current["reason"]}})
        } else {
            json!({"type":"status","status":current})
        });
    }
    let target = authority
        .target(session, generation)
        .ok_or("No active Interaction matches this generation")?;
    let macos = target["kind"] == "macos-window";
    if operation == "run" && macos {
        return Ok(json!({"type":"script","result":{"outcome":"refused","reason":"unsupported"}}));
    }
    let resource = if macos {
        text(&target, "bundleID").to_owned()
    } else {
        format!("{}{}", text(&target, "origin"), text(&target, "pathname"))
    };
    let action = input.get("action");
    let script = input.get("script");
    let mut resources = vec![resource];
    if let Some(action) = action
        && action["type"] == "navigate"
    {
        let destination = Url::parse(text(action, "url"))
            .map_err(|_| "Interaction requires a valid HTTP(S) navigation URL")?;
        if macos || destination.origin().ascii_serialization() != text(&target, "origin") {
            return Err("Navigation is outside the granted origin".into());
        }
        resources.push(format!(
            "{}{}",
            destination.origin().ascii_serialization(),
            destination.path()
        ));
    }
    let mut identity = json!({"generation":generation});
    if let Some(action) = action {
        identity["action"] = action.clone();
    }
    if let Some(script) = script {
        identity["script"] = script.clone();
    }
    let operation = action.map(|a| text(a, "type")).unwrap_or(operation);
    let metadata = json!({"operation":operation,"operationDigest":digest(&identity)});
    permission(
        policy,
        context,
        "interaction",
        resources.clone(),
        metadata.clone(),
    )
    .await?;
    if macos {
        permission(
            policy,
            context,
            "computer",
            resources.clone(),
            metadata.clone(),
        )
        .await?;
    } else {
        permission(
            policy,
            context,
            "browser_read",
            resources.clone(),
            metadata.clone(),
        )
        .await?;
        if let Some(action) = action {
            permission(
                policy,
                context,
                if action["type"] == "navigate" {
                    "browser_navigate"
                } else {
                    "browser_interact"
                },
                resources.clone(),
                metadata.clone(),
            )
            .await?;
        }
        if let Some(script) = script {
            let mut metadata = metadata.clone();
            let source = text(script, "source");
            metadata["mode"] = script["mode"].clone();
            metadata["sourceDigest"] =
                json!(crate::resources::memory::format::sha256(source.as_bytes()));
            metadata["sourcePreview"] = json!(
                source
                    .split_whitespace()
                    .collect::<Vec<_>>()
                    .join(" ")
                    .chars()
                    .filter(|c| !c.is_control())
                    .take(200)
                    .collect::<String>()
            );
            permission(
                policy,
                context,
                "browser_script",
                resources.clone(),
                metadata,
            )
            .await?;
        }
    }
    match text(&input, "operation") {
        "observe" => {
            let observed = authority
                .observe(session, generation)
                .await
                .map_err(|_| "Interaction observation was withheld or became stale")?;
            return Ok(
                json!({"type":"observation","observation":{"revision":observed["revision"],"elements":observed["elements"]}}),
            );
        }
        "confirm" => {
            return authority
                .confirmation(
                    session,
                    generation,
                    input["revision"].as_u64().ok_or("Invalid revision")?,
                    input["action"].clone(),
                )
                .map(|refused| {
                    refused.map_or_else(
                        || json!({"type":"confirmation_pending"}),
                        |result| json!({"type":"result","result":result}),
                    )
                })
                .map_err(|_| {
                    "Interaction confirmation is unavailable for this action and revision".into()
                });
        }
        _ => {}
    }
    let _held = Held(
        policy
            .review(
                context,
                Review {
                    action: if macos {
                        "computer"
                    } else if target["kind"] == "chrome-tab" {
                        "browser_profile_mutation"
                    } else {
                        "browser_mutation"
                    }
                    .into(),
                    resources,
                    metadata,
                    skip_review: false,
                },
            )
            .await?,
    );
    let revision = input["revision"].as_u64().ok_or("Invalid revision")?;
    if text(&input, "operation") == "run" {
        return Ok(
            json!({"type":"script","result":authority.run(session,generation,revision,input["script"].clone()).await.map_err(|_|"The script outcome is uncertain and control was revoked; do not repeat it")?}),
        );
    }
    let hash = digest(&json!([context.message_id, context.owner.call_id]));
    let call_id = format!(
        "{}-{}-4{}-8{}-{}",
        &hash[..8],
        &hash[8..12],
        &hash[13..16],
        &hash[17..20],
        &hash[20..32]
    );
    Ok(
        json!({"type":"result","result":authority.perform(session,generation,revision,&call_id,input["action"].clone()).await}),
    )
}
async fn permission(
    policy: &dyn Policy,
    context: &Context,
    action: &str,
    resources: Vec<String>,
    metadata: Value,
) -> Result<(), String> {
    policy
        .permission(
            context,
            Permission {
                action: action.into(),
                resources,
                save: vec![],
                metadata,
                consume_review: true,
            },
        )
        .await
        .map_err(Into::into)
}
fn digest(value: &Value) -> String {
    crate::resources::memory::format::sha256(value.to_string().as_bytes())
}
