pub fn collation() -> std::sync::Arc<ycoding_core::tools::code_mode::Collation> {
    std::sync::Arc::new(|left, right| {
        let normalizer = icu_normalizer::DecomposingNormalizer::new_nfd();
        normalizer
            .normalize(&String::from_utf16_lossy(left))
            .cmp(&normalizer.normalize(&String::from_utf16_lossy(right)))
    })
}
