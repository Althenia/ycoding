# Received-output speed

## Changed

- Session and subagent speed show estimated received-output throughput. The first output chunk is excluded, and a rate appears only after at least one second of observed output. Live rates use a trailing five-second window and restart for each provider attempt.
- Usage reports retain provider-counted output and their existing timing rules.
