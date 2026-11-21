use crate::regexp::{Budget, RegExp};

#[derive(Clone)]
pub(crate) struct Pattern(RegExp);

impl Pattern {
    pub(crate) fn new(source: &str, flags: &str) -> Self {
        let source = source.encode_utf16().collect::<Vec<_>>();
        Self(RegExp::new(&source, flags).expect("static pattern is valid"))
    }

    pub(crate) fn is_match(&self, text: &str) -> bool {
        self.captures(text).is_some()
    }

    pub(crate) fn captures(&self, text: &str) -> Option<Vec<Option<String>>> {
        let input = text.encode_utf16().collect::<Vec<_>>();
        self.0
            .clone()
            .exec(&input, &mut Budget::unlimited())
            .expect("unbounded matching completes")
            .map(|matched| matched.captures.into_iter().map(decode).collect())
    }

    pub(crate) fn find_all(&self, text: &str) -> Vec<String> {
        let input = text.encode_utf16().collect::<Vec<_>>();
        self.0
            .match_all(&input, &mut Budget::unlimited())
            .expect("global pattern matches without limits")
            .into_iter()
            .filter_map(|matched| matched.captures.into_iter().next().flatten())
            .map(|matched| String::from_utf16_lossy(&matched))
            .collect()
    }

    pub(crate) fn split(&self, text: &str) -> Vec<String> {
        let input = text.encode_utf16().collect::<Vec<_>>();
        self.0
            .split(&input, u32::MAX, &mut Budget::unlimited())
            .expect("unbounded split completes")
            .into_iter()
            .flatten()
            .map(|part| String::from_utf16_lossy(&part))
            .collect()
    }

    pub(crate) fn replace_all(&self, text: &str, replacement: &str) -> String {
        let input = text.encode_utf16().collect::<Vec<_>>();
        let replacement = replacement.encode_utf16().collect::<Vec<_>>();
        let output = self
            .0
            .clone()
            .replace(&input, &replacement, &mut Budget::unlimited())
            .expect("unbounded replace completes");
        String::from_utf16_lossy(&output)
    }
}

fn decode(capture: Option<Vec<u16>>) -> Option<String> {
    capture.map(|capture| String::from_utf16_lossy(&capture))
}
