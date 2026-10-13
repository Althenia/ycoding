use ycoding_protocol::{WireConnection, WireError, v5};

#[test]
fn digest_bearing_negatives_keep_specific_rejection_reasons() {
    let manifest = std::fs::read_to_string(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../protocol/ycoding/v5/testdata/manifest.tsv"),
    )
    .unwrap();
    for (name, reason) in [
        ("both-frame-bodies", "duplicate oneof"),
        ("concatenated-frame", "duplicate singular"),
        ("duplicate-command", "duplicate singular"),
        ("hello-epoch", "Hello epoch"),
        ("hello-ledger", "handshake ledger"),
        ("unknown-command", "unknown field"),
    ] {
        let hex = manifest
            .lines()
            .map(|line| line.split('\t').collect::<Vec<_>>())
            .find(|row| row[0] == name)
            .unwrap()[4];
        assert_eq!(hex.len() % 2, 0);
        let bytes: Vec<_> = (0..hex.len())
            .step_by(2)
            .map(|index| u8::from_str_radix(&hex[index..index + 2], 16).unwrap())
            .collect();
        let result = WireConnection::new(v5::PeerRole::LocalClient, v5::PeerRole::Server)
            .unwrap()
            .observe(&bytes, v5::PeerRole::LocalClient, 0);
        assert_eq!(result.unwrap_err(), WireError(reason), "{name}");
    }
}
