use super::*;
use std::cell::Cell;

mod digests;

#[test]
fn bundled_roots_match_exact_ordered_node_26_4_der() {
    let actual: Vec<String> = bundled::NODE_26_4_ROOTS
        .iter()
        .map(|pem| {
            let (label, der) = decode_pem_detect(pem.as_bytes()).unwrap();
            assert_eq!(label, "CERTIFICATE");
            ring::digest::digest(&ring::digest::SHA256, &der)
                .as_ref()
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect()
        })
        .collect();
    assert_eq!(actual, digests::EXPECTED_NODE_26_4_DIGESTS);
    assert_eq!(
        actual
            .iter()
            .collect::<std::collections::BTreeSet<_>>()
            .len(),
        120
    );
}

#[test]
fn union_orders_system_bundle_startup_and_excludes_generated_ca() {
    let provider = RequiredRootProvider::new();
    let snapshot = StartupCaSnapshot::capture(&std::collections::BTreeMap::from([
        ("CODEX_CA_CERTIFICATE".into(), "first".into()),
        ("NODE_EXTRA_CA_CERTS".into(), "second".into()),
    ]));
    let roots = provider
        .load(
            || Ok(vec![bundled::NODE_26_4_ROOTS[4].replace('\n', "\r\n")]),
            &snapshot,
            |path| {
                Some(StartupCaFile {
                    is_file: true,
                    byte_length: 32,
                    text: if path == "first" {
                        bundled::NODE_26_4_ROOTS[4]
                    } else {
                        bundled::NODE_26_4_ROOTS[8]
                    }
                    .into(),
                })
            },
            |_| false,
            bundled::NODE_26_4_ROOTS[8],
        )
        .unwrap();
    assert_eq!(
        roots.ordered_pem()[0],
        normalize_pem(bundled::NODE_26_4_ROOTS[4])
    );
    assert_eq!(
        roots.ordered_pem()[1],
        normalize_pem(bundled::NODE_26_4_ROOTS[0])
    );
    assert_eq!(roots.ordered_pem().len(), 119);
    assert_eq!(roots.root_store().len(), 119);
    assert!(
        !roots
            .ordered_pem()
            .contains(&normalize_pem(bundled::NODE_26_4_ROOTS[8]))
    );
}

#[test]
fn canonical_dedupe_is_normalized_pem_not_der_identity() {
    let first = " \r\n-----BEGIN CERTIFICATE-----\r\nAA==\r\n-----END CERTIFICATE----- \r\n";
    let normalized = normalize_pem(first);
    assert_eq!(
        normalized,
        "-----BEGIN CERTIFICATE-----\nAA==\n-----END CERTIFICATE-----\n"
    );
    let different_wrapping = "-----BEGIN CERTIFICATE-----\nA\nA==\n-----END CERTIFICATE-----\n";
    let roots = ordered_union(
        &[first.into(), normalized],
        &[different_wrapping.into()],
        "excluded",
    );
    assert_eq!(roots.len(), 122);
    assert_eq!(roots[121], different_wrapping);
}

#[test]
fn startup_additions_follow_the_complete_bundle_in_key_and_file_order() {
    let additions = vec!["FIRST".into(), "SECOND".into(), "FIRST".into()];
    let roots = ordered_union(&["SYSTEM".into()], &additions, "CHILD");
    assert_eq!(roots[0], "SYSTEM\n");
    assert_eq!(&roots[1..121], bundled::NODE_26_4_ROOTS.map(normalize_pem));
    assert_eq!(&roots[121..], ["FIRST\n", "SECOND\n"]);
    assert!(!roots.contains(&"CHILD\n".into()));
}

#[test]
fn pem_extraction_preserves_blocks_and_requires_a_nonempty_body() {
    let text = "noise-----BEGIN CERTIFICATE----------END CERTIFICATE-----";
    assert_eq!(pem_certificates(text).count(), 0);
    let text = "noise-----BEGIN CERTIFICATE-----é-----END CERTIFICATE-----tail";
    assert_eq!(
        pem_certificates(text).collect::<Vec<_>>(),
        ["-----BEGIN CERTIFICATE-----é-----END CERTIFICATE-----"]
    );
    assert_eq!(normalize_pem("\u{feff}\u{000b}A\u{000b}\u{feff}"), "A\n");
    assert_eq!(normalize_pem("\u{0085}A\u{0085}"), "\u{0085}A\u{0085}\n");
}

#[test]
fn startup_uses_eleven_keys_in_order_skips_managed_repeated_large_and_failed_files() {
    assert_eq!(
        CCA_CUSTOM_CA_ENV_KEYS,
        [
            "CODEX_CA_CERTIFICATE",
            "SSL_CERT_FILE",
            "REQUESTS_CA_BUNDLE",
            "CURL_CA_BUNDLE",
            "NODE_EXTRA_CA_CERTS",
            "GIT_SSL_CAINFO",
            "CARGO_HTTP_CAINFO",
            "PIP_CERT",
            "BUNDLE_SSL_CA_CERT",
            "npm_config_cafile",
            "NPM_CONFIG_CAFILE"
        ]
    );
    let snapshot = StartupCaSnapshot::capture(&std::collections::BTreeMap::from([
        ("CODEX_CA_CERTIFICATE".into(), "first".into()),
        ("SSL_CERT_FILE".into(), "first".into()),
        ("REQUESTS_CA_BUNDLE".into(), "managed".into()),
        ("CURL_CA_BUNDLE".into(), "large".into()),
        ("NODE_EXTRA_CA_CERTS".into(), "not-file".into()),
        ("GIT_SSL_CAINFO".into(), "missing".into()),
        ("NPM_CONFIG_CAFILE".into(), "last".into()),
        ("OTHER_CA".into(), "unused".into()),
    ]));
    let calls = std::cell::RefCell::new(Vec::new());
    let roots = snapshot.certificates(|path| {
        calls.borrow_mut().push(path.to_owned());
        (path != "missing").then(|| StartupCaFile {
            is_file: path != "not-file",
            byte_length: if path == "large" { 1024 * 1024 + 1 } else { 1024 * 1024 },
            text: format!("ignored\n-----BEGIN CERTIFICATE-----\n{path}\n-----END CERTIFICATE-----\nignored"),
        })
    }, |path| path == "managed");
    assert_eq!(
        *calls.borrow(),
        ["first", "large", "not-file", "missing", "last"]
    );
    assert_eq!(roots.len(), 2);
    assert!(roots[0].contains("first"));
    assert!(roots[1].contains("last"));
    assert_eq!(
        snapshot.certificates(|_| panic!("startup files re-read"), |_| false),
        roots
    );
}

#[test]
fn system_cache_requires_a_source_and_preserves_first_collection() {
    let provider = RequiredRootProvider::new();
    let calls = Cell::new(0);
    let first = provider
        .system_certificates(|| {
            calls.set(calls.get() + 1);
            Ok(vec!["first".into()])
        })
        .unwrap();
    assert_eq!(first, ["first"]);
    assert_eq!(
        provider
            .system_certificates(|| panic!("system re-collected"))
            .unwrap(),
        first
    );
    assert_eq!(calls.get(), 1);
    let missing = RequiredRootProvider::new();
    assert!(
        missing
            .system_certificates(|| Err(RootError::RequiredSystemSource("binding".into())))
            .is_err()
    );
}

#[test]
fn invalid_union_root_is_an_error_not_silently_dropped() {
    let provider = RequiredRootProvider::new();
    let snapshot = StartupCaSnapshot::capture(&std::collections::BTreeMap::new());
    assert!(matches!(
        provider.load(
            || Ok(vec!["not a certificate".into()]),
            &snapshot,
            |_| None,
            |_| false,
            "generated"
        ),
        Err(RootError::Pem { index: 0, .. })
    ));
}

#[test]
fn unix_overrides_default_independently_and_native_platforms_ignore_them() {
    use platform::*;
    let defaults = CompiledOpenSslDefaults {
        file_env: "SSL_CERT_FILE".into(),
        directory_env: "SSL_CERT_DIR".into(),
        file: "compiled-file".into(),
        directory: "compiled-dir".into(),
    };
    for (env, file, directory) in [
        (vec![], "compiled-file", "compiled-dir"),
        (
            vec![("SSL_CERT_FILE", "override-file")],
            "override-file",
            "compiled-dir",
        ),
        (
            vec![("SSL_CERT_DIR", "override-dir")],
            "compiled-file",
            "override-dir",
        ),
        (vec![("SSL_CERT_FILE", ""), ("SSL_CERT_DIR", "")], "", ""),
    ] {
        let captured = env.into_iter().map(|(k, v)| (k.into(), v.into())).collect();
        assert_eq!(
            system_plan(Platform::Unix, Some(&defaults), &captured).unwrap(),
            SystemPlan::OpenSsl {
                file: file.into(),
                directory: directory.into()
            }
        );
        assert_eq!(
            system_plan(Platform::MacOs, None, &captured).unwrap(),
            SystemPlan::MacOs
        );
        assert_eq!(
            system_plan(Platform::Windows, None, &captured).unwrap(),
            SystemPlan::Windows
        );
    }
    assert!(system_plan(Platform::Unix, None, &std::collections::BTreeMap::new()).is_err());
}

#[test]
fn unix_collection_loads_file_then_each_regular_directory_file_without_path_list_splitting() {
    use platform::*;
    struct Source(Vec<std::path::PathBuf>);
    impl OpenSslSystemSource for Source {
        fn load_file(&mut self, path: &std::path::Path) -> Result<Vec<String>, RootError> {
            self.0.push(path.into());
            Ok(vec![path.to_string_lossy().into_owned()])
        }
        fn scan_regular_files(&mut self, directory: &std::path::Path) -> Vec<std::path::PathBuf> {
            assert_eq!(directory, std::path::Path::new("one:two"));
            vec!["one:two/a".into(), "one:two/z".into()]
        }
    }
    let mut source = Source(Vec::new());
    assert_eq!(
        collect_openssl(
            std::path::Path::new("file"),
            std::path::Path::new("one:two"),
            &mut source
        )
        .unwrap(),
        ["file", "one:two/a", "one:two/z"]
    );
    assert_eq!(
        source.0,
        [
            std::path::PathBuf::from("file"),
            "one:two/a".into(),
            "one:two/z".into()
        ]
    );
    assert!(
        collect_openssl(
            std::path::Path::new(""),
            std::path::Path::new(""),
            &mut source
        )
        .unwrap()
        .is_empty()
    );
    let defaults = CompiledOpenSslDefaults::node_26_4_bundled_linux_build();
    assert_eq!(defaults.file, std::path::Path::new("/etc/ssl/cert.pem"));
    assert_eq!(defaults.directory, std::path::Path::new("/etc/ssl/certs"));
}

#[test]
fn unix_pem_reader_preserves_prefix_before_malformed_block_and_accepts_historical_label() {
    let valid = bundled::NODE_26_4_ROOTS[0];
    let historical = valid.replace("CERTIFICATE", "X509 CERTIFICATE");
    let input = format!(
        "preamble\n{valid}\n{historical}\n-----BEGIN CERTIFICATE-----\n!\n-----END CERTIFICATE-----\n{}",
        bundled::NODE_26_4_ROOTS[1]
    );
    let roots = platform::read_openssl_pem(&input).unwrap();
    assert_eq!(roots.len(), 2);
    assert_eq!(roots[0], roots[1]);
    let (_, actual) = decode_pem_detect(roots[0].as_bytes()).unwrap();
    let (_, expected) = decode_pem_detect(valid.as_bytes()).unwrap();
    assert_eq!(actual, expected);
    let invalid_der = format!(
        "{valid}\n-----BEGIN CERTIFICATE-----\nMAA=\n-----END CERTIFICATE-----\n{}",
        bundled::NODE_26_4_ROOTS[1]
    );
    assert_eq!(platform::read_openssl_pem(&invalid_der).unwrap().len(), 1);
}

#[test]
fn windows_selection_and_usage_filter_match_node() {
    use StoreLocation::*;
    use windows::*;
    assert_eq!(
        STORE_SELECTIONS,
        [
            (LocalMachine, "ROOT"),
            (LocalMachineGroupPolicy, "ROOT"),
            (LocalMachineEnterprise, "ROOT"),
            (CurrentUser, "ROOT"),
            (CurrentUserGroupPolicy, "ROOT"),
            (LocalMachine, "CA"),
            (LocalMachineGroupPolicy, "CA"),
            (LocalMachineEnterprise, "CA"),
            (CurrentUser, "CA"),
            (CurrentUserGroupPolicy, "CA"),
            (LocalMachine, "TrustedPeople"),
            (LocalMachineGroupPolicy, "TrustedPeople"),
            (LocalMachineEnterprise, "TrustedPeople"),
        ]
    );
    assert!(server_auth_allowed(&EnhancedKeyUsage::AllPurposes));
    for usage in [
        EnhancedKeyUsage::PropertyError,
        EnhancedKeyUsage::NoPurposes,
        EnhancedKeyUsage::Oids(vec!["1.3.6.1.5.5.7.3.2".into()]),
    ] {
        assert!(!server_auth_allowed(&usage));
    }
    for oid in ["1.3.6.1.5.5.7.3.1", "2.5.29.37.0"] {
        assert!(server_auth_allowed(&EnhancedKeyUsage::Oids(vec![
            oid.into()
        ])));
    }
}

#[test]
fn mac_scope_policy_default_and_self_issued_rules_match_node() {
    use macos::*;
    let setting = TrustSetting::default();
    assert_eq!(setting.trust(true), Trust::Trusted);
    assert_eq!(setting.trust(false), Trust::Unspecified);
    for scoped in [
        TrustSetting {
            application_scoped: true,
            ..setting.clone()
        },
        TrustSetting {
            policy_string_scoped: true,
            ..setting.clone()
        },
        TrustSetting {
            policy: Policy::OtherOrInvalid,
            ..setting.clone()
        },
        TrustSetting {
            result: SettingResult::Invalid,
            ..setting.clone()
        },
    ] {
        assert_eq!(scoped.trust(true), Trust::Unspecified);
    }
    let ssl = TrustSetting {
        policy: Policy::AppleSsl,
        result: SettingResult::TrustAsRoot,
        ..setting.clone()
    };
    assert_eq!(ssl.trust(false), Trust::Trusted);
    let deny = TrustSetting {
        result: SettingResult::Deny,
        ..setting
    };
    assert_eq!(deny.trust(true), Trust::Distrusted);
    assert_eq!(settings_trust(&[], true), Trust::Trusted);
    assert_eq!(settings_trust(&[], false), Trust::Unspecified);
    assert_eq!(
        settings_trust(&[deny.clone(), ssl.clone()], true),
        Trust::Distrusted
    );
    assert_eq!(settings_trust(&[ssl, deny], true), Trust::Trusted);
}

#[test]
fn mac_user_admin_precedence_and_evaluation_are_ordered_not_aggregate() {
    use macos::*;
    let allow = DomainSettings::Present(vec![TrustSetting::default()]);
    let deny = DomainSettings::Present(vec![TrustSetting {
        result: SettingResult::Deny,
        ..TrustSetting::default()
    }]);
    assert!(certificate_trusted(
        true,
        |domain| if domain == Domain::User {
            allow.clone()
        } else {
            deny.clone()
        },
        || false
    ));
    assert!(!certificate_trusted(
        true,
        |domain| if domain == Domain::User {
            deny.clone()
        } else {
            allow.clone()
        },
        || true
    ));
    let evaluations = Cell::new(0);
    assert!(!certificate_trusted(
        true,
        |_| DomainSettings::Missing,
        || {
            evaluations.set(evaluations.get() + 1);
            false
        }
    ));
    assert_eq!(evaluations.get(), 1);
    assert!(certificate_trusted(
        false,
        |domain| if domain == Domain::User {
            DomainSettings::Missing
        } else {
            deny.clone()
        },
        || true
    ));
    assert!(!certificate_trusted(
        true,
        |_| DomainSettings::ReadError,
        || panic!("errors do not evaluate")
    ));
}
