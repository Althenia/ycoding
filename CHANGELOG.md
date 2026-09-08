# Changelog

## [Unreleased]

---

## [0.1.2] - 2026-09-08

### Fixed
+ Truncated Thai session titles, labels, and tool output no longer drop vowels or tone marks; truncation now keeps whole graphemes so combining marks stay with their base character.

---

## [0.1.1] - 2026-09-08

### Added
+ Reversible session archiving with an `Archived` label; archiving never deletes history or changes last-activity time.

### Changed
+ SQLite space reclamation runs automatically at startup without deleting records.
+ Retry status display distinguishes scheduled backoff, in-flight retry, and terminal states.
+ Binary installation is more prominent.

---

## [0.1.0] - 2026-09-08

### Added
+ Terminal distribution with native release archives and SHA-256 checksums.

---
