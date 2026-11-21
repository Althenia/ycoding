use icu_collator::{Collator, CollatorBorrowed, options::CollatorOptions};
use std::{cmp::Ordering, sync::OnceLock};

pub fn compare(a: &[u16], b: &[u16]) -> Ordering {
    static COLLATOR: OnceLock<CollatorBorrowed<'static>> = OnceLock::new();
    COLLATOR
        .get_or_init(|| {
            Collator::try_new(Default::default(), CollatorOptions::default())
                .expect("compiled root collation data")
        })
        .compare_utf16(a, b)
}
