use ycoding_core::resources::auth::page;

#[test]
fn canonical_offline_pages_escape_html_and_script_values_in_all_states() {
    for html in [
        page::success(Some("Test integration"), false),
        page::error("Test error", Some("Test integration")),
        page::bootstrap("/callback", Some("Test integration")),
    ] {
        assert!(html.contains("<span>YCoding</span>"));
        assert!(html.contains("M40 40h32v64H40zm144 0h32v64h-32zM40 112h64v64H72v-32H40zm112 0h64v32h-32v32h-32zm-40 72h32v32h-32z"));
        assert!(html.contains("aria-live=\"polite\""));
        assert!(html.contains("prefers-reduced-motion"));
        assert!(!html.contains("https://"));
    }
    let html = page::bootstrap(
        "/token</script><script>alert(\"path\")</script>",
        Some("xAI</script><script>alert(\"provider\")</script>"),
    );
    assert_eq!(html.matches("</script>").count(), 1);
    assert!(
        html.contains("xAI\\u003c/script>\\u003cscript>alert(\\\"provider\\\")\\u003c/script>")
    );
    assert!(
        page::error("<private> & 'quoted'", Some("<Provider>"))
            .contains("&lt;private&gt; &amp; &#39;quoted&#39;")
    );
    assert!(!page::success(None, false).contains("window.close"));
    assert!(page::success(None, true).contains("window.close"));
}

#[test]
fn callback_documents_are_byte_identical_to_committed_ts_oracle() {
    for (html, expected) in [
        (
            page::success(Some("Test integration"), false),
            "a55fbb34b632dfad60e341322f3d86422781382bf89c9c586aa1961fc591e4ae",
        ),
        (
            page::error("Test error", Some("Test integration")),
            "1b412e3ea902ae0d187cc3ee49701006d4d1f6c2c19aa2f01e018906a53e81b2",
        ),
        (
            page::bootstrap("/callback", Some("Test integration")),
            "78a0217c7c1ec5321830dcbdec560cdac76b9da35a2d8492a3060f0abcffd55f",
        ),
    ] {
        let digest = ring::digest::digest(&ring::digest::SHA256, html.as_bytes());
        assert_eq!(
            digest
                .as_ref()
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect::<String>(),
            expected
        );
    }
}
