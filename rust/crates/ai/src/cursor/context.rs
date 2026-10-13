use super::{
    protobuf::{self, Field},
    request::Descriptor,
    wire::Exec,
};
use crate::Error;
use ycoding_schema::{JsonValue, LosslessString, stringify_json};

pub(crate) fn materialize(base: &[u8], tools: &[Descriptor]) -> Result<Vec<u8>, Error> {
    let mut fields = protobuf::fields(base)?;
    fields.sort_by_key(|field| field.number);
    let mut context = Vec::new();
    let mut inserted = false;
    for field in fields {
        if field.number >= 7 && !inserted {
            for tool in tools {
                protobuf::write_bytes(&mut context, 7, &tool.encode()?)?;
            }
            inserted = true;
        }
        if field.number == 7 {
            continue;
        }
        if [23, 34].contains(&field.number) {
            let descriptor_field = if field.number == 23 { 3 } else { 2 };
            let mut options = Vec::new();
            for option in protobuf::fields(field.bytes()?)? {
                if option.number != descriptor_field {
                    option.write(&mut options)?;
                }
            }
            for server in filesystem_catalog(tools)? {
                protobuf::write_bytes(&mut options, descriptor_field, &server)?;
            }
            protobuf::write_bytes(&mut context, field.number, &options)?;
            continue;
        }
        field.write(&mut context)?;
    }
    if !inserted {
        for tool in tools {
            protobuf::write_bytes(&mut context, 7, &tool.encode()?)?;
        }
    }
    Ok(context)
}

pub(crate) fn workspace_root(context: &[u8]) -> Option<String> {
    let fields = protobuf::fields(context).ok()?;
    let env = fields.iter().rev().find(|field| field.number == 4)?;
    let env = protobuf::fields(env.bytes().ok()?).ok()?;
    let first = env.iter().find(|field| field.number == 2)?.text().ok()?;
    let root = first.trim();
    (!root.is_empty()).then(|| {
        let trimmed = root.trim_end_matches('/');
        if trimmed.is_empty() { "/" } else { trimmed }.to_owned()
    })
}

pub(crate) fn ground(reason: &str, root: Option<&str>) -> String {
    let Some(root) = root.filter(|root| !root.trim().is_empty()) else {
        return reason.to_owned();
    };
    if reason.contains("Workspace root:") {
        return reason.to_owned();
    }
    let note = format!(
        "Workspace root: {}. Resolve workspace paths against exactly this root; never invent an absolute prefix, and verify uncertain paths with an available tool before using them.",
        stringify_json(&JsonValue::String(root.into()))
    );
    if reason.is_empty() {
        note
    } else {
        format!("{reason}\n{note}")
    }
}

pub(crate) fn mcp_state(exec: &Exec, context: &[u8]) -> Result<Vec<u8>, Error> {
    let requested = protobuf::fields(&exec.args)?
        .into_iter()
        .filter(|field| field.number == 1)
        .map(|field| field.text())
        .collect::<Result<Vec<_>, _>>()?
        .into_iter()
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>();
    let fields = protobuf::fields(context)?;
    let flat = fields
        .iter()
        .filter(|field| field.number == 7)
        .map(|field| field.bytes())
        .collect::<Result<Vec<_>, _>>()?;
    let advertised_fields = flat
        .iter()
        .map(|bytes| Ok((*bytes, protobuf::fields(bytes)?)))
        .collect::<Result<Vec<_>, Error>>()?;
    let filesystem = fields
        .iter()
        .rev()
        .find(|field| field.number == 23)
        .map(|field| field.bytes())
        .transpose()?
        .map(protobuf::fields)
        .transpose()?
        .unwrap_or_default();
    let nested = filesystem
        .iter()
        .filter(|field| field.number == 3)
        .map(|field| field.bytes())
        .collect::<Result<Vec<_>, _>>()?;
    let catalogs = if nested.is_empty() {
        let mut groups: Vec<(String, Vec<&[u8]>)> = Vec::new();
        for definition in &flat {
            let provider =
                text(&protobuf::fields(definition)?, 4)?.unwrap_or_else(|| "opencode".into());
            if let Some(group) = groups.iter_mut().find(|group| group.0 == provider) {
                group.1.push(definition);
                continue;
            }
            groups.push((provider, vec![definition]));
        }
        groups
            .into_iter()
            .map(|(provider, definitions)| {
                let mut server = Vec::new();
                protobuf::write_string(&mut server, 1, &provider.clone().into())?;
                protobuf::write_string(&mut server, 2, &provider.into())?;
                for definition in definitions {
                    protobuf::write_bytes(&mut server, 5, definition)?;
                }
                Ok(server)
            })
            .collect::<Result<Vec<_>, Error>>()?
    } else {
        nested
            .into_iter()
            .map(|catalog| {
                let fields = protobuf::fields(catalog)?;
                let provider = text(&fields, 2)?.or(text(&fields, 1)?).unwrap_or_default();
                let mut server = Vec::new();
                protobuf::write_string(
                    &mut server,
                    1,
                    &text(&fields, 1)?.unwrap_or_else(|| provider.clone()).into(),
                )?;
                protobuf::write_string(&mut server, 2, &provider.clone().into())?;
                for descriptor in fields.iter().filter(|field| field.number == 5) {
                    let descriptor = protobuf::fields(descriptor.bytes()?)?;
                    let tool = text(&descriptor, 1)?.unwrap_or_default();
                    let mut advertised = None;
                    for (bytes, fields) in &advertised_fields {
                        if text(fields, 4)?.as_deref() == Some(&provider)
                            && text(fields, 5)?.as_deref() == Some(&tool)
                        {
                            advertised = Some(*bytes);
                            break;
                        }
                    }
                    if let Some(advertised) = advertised {
                        protobuf::write_bytes(&mut server, 5, advertised)?;
                        continue;
                    }
                    let mut definition = Vec::new();
                    protobuf::write_string(
                        &mut definition,
                        1,
                        &format!("{provider}-{tool}").into(),
                    )?;
                    protobuf::write_string(
                        &mut definition,
                        2,
                        &text(&descriptor, 3)?.unwrap_or_default().into(),
                    )?;
                    if let Some(schema) = descriptor.iter().rev().find(|field| field.number == 4) {
                        protobuf::write_bytes(&mut definition, 3, schema.bytes()?)?;
                    }
                    protobuf::write_string(&mut definition, 4, &provider.clone().into())?;
                    protobuf::write_string(&mut definition, 5, &tool.into())?;
                    protobuf::write_bytes(&mut server, 5, &definition)?;
                }
                Ok(server)
            })
            .collect::<Result<Vec<_>, Error>>()?
    };
    let mut success = Vec::new();
    for server in catalogs {
        let fields = protobuf::fields(&server)?;
        if requested.is_empty()
            || text(&fields, 2)?.is_some_and(|provider| requested.contains(&provider))
        {
            protobuf::write_bytes(&mut success, 1, &server)?;
        }
    }
    let mut result = Vec::new();
    protobuf::write_bytes(&mut result, 1, &success)?;
    exec.result(36, &result, None)
}

fn filesystem_catalog(tools: &[Descriptor]) -> Result<Vec<Vec<u8>>, Error> {
    let mut groups: Vec<(&LosslessString, Vec<&Descriptor>)> = Vec::new();
    for tool in tools {
        if let Some(group) = groups.iter_mut().find(|group| group.0 == &tool.provider) {
            group.1.push(tool);
            continue;
        }
        groups.push((&tool.provider, vec![tool]));
    }
    groups
        .into_iter()
        .map(|(provider, tools)| {
            let mut server = Vec::new();
            protobuf::write_string(&mut server, 1, provider)?;
            protobuf::write_string(&mut server, 2, provider)?;
            for tool in tools {
                let mut descriptor = Vec::new();
                protobuf::write_string(&mut descriptor, 1, &tool.tool_name)?;
                protobuf::write_string(&mut descriptor, 3, &tool.description)?;
                protobuf::write_bytes(
                    &mut descriptor,
                    4,
                    &protobuf::encode_value(&tool.input_schema)?,
                )?;
                protobuf::write_bytes(&mut server, 5, &descriptor)?;
            }
            Ok(server)
        })
        .collect()
}
fn text(fields: &[Field<'_>], number: u32) -> Result<Option<String>, Error> {
    fields
        .iter()
        .rev()
        .find(|field| field.number == number)
        .map(|field| field.text())
        .transpose()
}

#[cfg(test)]
mod tests {
    use super::{ground, protobuf, workspace_root};

    fn env(paths: &[&str]) -> Vec<u8> {
        let mut environment = Vec::new();
        for path in paths {
            protobuf::write_string(&mut environment, 2, &(*path).into()).unwrap();
        }
        let mut context = Vec::new();
        protobuf::write_bytes(&mut context, 4, &environment).unwrap();
        context
    }

    #[test]
    fn cursor_workspace_root_uses_only_a_nonblank_first_workspace_path() {
        assert_eq!(
            workspace_root(&env(&["/work/space/"])),
            Some("/work/space".into())
        );
        assert_eq!(workspace_root(&env(&["/"])), Some("/".into()));
        assert_eq!(workspace_root(&env(&["  ", "/second"])), None);
        assert_eq!(workspace_root(&env(&[])), None);
        assert_eq!(workspace_root(&[34, 0]), None);
    }

    #[test]
    fn cursor_grounding_appends_the_root_once_and_skips_blank_roots() {
        let grounded = ground("denied", Some("/work/\"space"));
        assert_eq!(
            grounded,
            "denied\nWorkspace root: \"/work/\\\"space\". Resolve workspace paths against exactly this root; never invent an absolute prefix, and verify uncertain paths with an available tool before using them."
        );
        assert_eq!(ground(&grounded, Some("/other")), grounded);
        assert!(ground("", Some("/r")).starts_with("Workspace root: \"/r\"."));
        assert_eq!(ground("denied", Some(" ")), "denied");
        assert_eq!(ground("denied", None), "denied");
    }
}
