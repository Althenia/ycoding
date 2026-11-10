# Received-output speed

## Changed

- Session and subagent speed are provider-counted when every pooled sample is provider-timed, otherwise estimated received-output throughput. The first output chunk is excluded, and an estimated rate appears only after at least one second of observed output. Live rates use a trailing five-second window and restart for each provider attempt; the live final shows during tool and terminal phases.
- Usage reports retain provider-counted output; generation windows below one second and means with fewer than three samples are excluded.
