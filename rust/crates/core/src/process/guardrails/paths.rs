use super::Paths;
use ycoding_schema::LosslessString;

pub(super) fn units(value: &LosslessString) -> Vec<u16> {
    value.code_units().collect()
}
pub(super) fn text(value: &str) -> Vec<u16> {
    value.encode_utf16().collect()
}
pub(super) fn whitespace(unit: u16) -> bool {
    matches!(unit, 0x0009..=0x000d | 0x0020 | 0x00a0 | 0x1680 | 0x2000..=0x200a | 0x2028 | 0x2029 | 0x202f | 0x205f | 0x3000 | 0xfeff)
}

pub fn resolve(target: &LosslessString, workdir: &LosslessString, paths: &Paths) -> LosslessString {
    let target = units(target);
    let prefixes = [
        (
            "$TMPDIR",
            paths.tmpdir.as_ref().filter(|value| !value.is_empty()),
        ),
        (
            "${TMPDIR}",
            paths.tmpdir.as_ref().filter(|value| !value.is_empty()),
        ),
        ("~", Some(&paths.home)),
        ("$HOME", Some(&paths.home)),
        ("${HOME}", Some(&paths.home)),
        ("$PWD", Some(workdir)),
        ("${PWD}", Some(workdir)),
    ];
    let expanded = prefixes
        .iter()
        .find_map(|(prefix, base)| {
            let prefix = text(prefix);
            if target == prefix
                || (target.starts_with(&prefix) && target.get(prefix.len()) == Some(&47))
            {
                return base.map(|base| {
                    base.code_units()
                        .chain(target[prefix.len()..].iter().copied())
                        .collect::<Vec<_>>()
                });
            }
            None
        })
        .unwrap_or(target);
    let combined = if expanded.first() == Some(&47) {
        expanded
    } else {
        workdir.code_units().chain([47]).chain(expanded).collect()
    };
    let mut components: Vec<Vec<u16>> = vec![];
    for component in combined.split(|unit| *unit == 47) {
        if component.is_empty() || component == [46] {
            continue;
        }
        if component == [46, 46] {
            components.pop();
            continue;
        }
        components.push(component.to_vec());
    }
    let mut result = vec![47];
    for (index, component) in components.iter().enumerate() {
        if index != 0 {
            result.push(47);
        }
        result.extend(component);
    }
    LosslessString::from_utf16(result)
}

pub fn dirname(target: &LosslessString) -> LosslessString {
    let target = units(target);
    let boundary = target.iter().rposition(|unit| *unit == 47).unwrap_or(0);
    LosslessString::from_utf16(target[..boundary.max(1)].to_vec())
}

pub(super) fn basename(target: &LosslessString) -> LosslessString {
    let target = units(target);
    let boundary = target
        .iter()
        .rposition(|unit| *unit == 47)
        .map_or(0, |index| index + 1);
    LosslessString::from_utf16(target[boundary..].to_vec())
}

pub fn within(target: &LosslessString, root: &LosslessString) -> bool {
    if target == root {
        return true;
    }
    let mut prefix = units(root);
    if prefix.last() != Some(&47) {
        prefix.push(47);
    }
    units(target).starts_with(&prefix)
}

pub(super) fn whole(target: &LosslessString) -> LosslessString {
    let target = units(target);
    let result = if target.ends_with(&[47, 42]) {
        &target[..target.len() - 2]
    } else if target.ends_with(&[47, 46, 42]) {
        &target[..target.len() - 3]
    } else {
        &target
    };
    if result.is_empty() {
        return "/".into();
    }
    LosslessString::from_utf16(result.to_vec())
}

pub(super) fn temporary(target: &LosslessString, workdir: &LosslessString, paths: &Paths) -> bool {
    let target = resolve(&whole(target), workdir, paths);
    [
        "/tmp",
        "/private/tmp",
        "/var/tmp",
        "/private/var/tmp",
        "/var/folders",
    ]
    .iter()
    .any(|root| within(&target, &(*root).into()))
        || paths
            .tmpdir
            .as_ref()
            .filter(|value| !value.is_empty())
            .is_some_and(|root| within(&target, &resolve(root, &paths.workdir, paths)))
}
