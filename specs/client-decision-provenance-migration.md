# Client decision provenance migration

Migration `20261026223924_client-decision-provenance` updates stored provenance and deferred-review fingerprint versions for the authenticated client decision route. It uses one ledgered transaction and makes no DDL changes.

## Data changes

- `model_incident.decided_by` changes `human` to `client`.
- `session_message.data` and `session_pending.data` change `metadata.inputOrigin` from `human` to `direct` only on user messages.
- `event.data` changes `input.data.metadata.inputOrigin` from `human` to `direct` only for `session.input.admitted.1` events whose input type is `user`.
- `session.review.deferred.1` permission payloads without `fingerprintVersion` receive version `1`.

Every other value and field is preserved. The migration retains message and event identities, sequences, timestamps, rows, secret values, cursors, receipt targets, and stored hashes. It does not rehash requests or maintain a mapping table.

## Fingerprint behavior

The decoder accepts fingerprint versions `1` and `2`; new producers write version `2`. Version `1` uses its original preimage, and `pendingFingerprint` omits only the version marker so existing Dots fingerprints remain valid. Exact matching, explicit denies, ceilings, withdrawal boundaries, consumed grants, and one-shot outcomes remain enforced.

## Atomicity and rollback

The migration runs with the event writer quiesced as part of normal migration serialization. The data updates and migration ledger entry commit together. A rerun recognizes the ledger and does not overwrite version-2 payloads. A rollback leaves both the data changes and ledger entry unapplied; it does not rewrite prior hashes or reconstruct alternate data.

This contract describes the migration code and its transactional behavior, not whether any deployed database has applied it.
