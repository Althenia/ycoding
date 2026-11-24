# Managed service shutdown

## Fixed

- `ycoding service restart` waits for the previous process to release its store before starting the replacement, even when the listener closes early. `ycoding service stop` reports a timeout if the process is still running after two minutes of graceful shutdown.
