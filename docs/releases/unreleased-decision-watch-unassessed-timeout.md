# Decision watch timeout state

## Fixed

- `ycoding decision watch` no longer reports a timed-out Session as `idle` when the work assessment could not be read before the deadline. The progress state is now `unconfirmed`, and the text says the Session state could not be assessed, so whether it is executing is unknown. `idle` is reported only after a completed assessment.
