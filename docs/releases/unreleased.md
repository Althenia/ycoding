# Unreleased

## Changed

- Web Usage leads with estimated spend, followed by account-reported provider quotas, charts and Backend consumption. Transparent provider marks retain their source colors or theme-safe treatment; unknown providers keep their labels without a substitute mark.
- The Team shell picker groups compact rows under Running, Queued and Archived, newest first within each section. Rows identify their owner, preserve selection through status changes and keep observed archived output accessible during the current connection. The output view retains the full command, working directory and PID.
- The shell queue permits one fitting command from another Session on the same backend to pass a memory-blocked head. Existing CPU, memory and concurrency limits remain in force, and the blocked Session keeps its FIFO order.
- Automatic question answers retain their automatic attribution in goal continuation. Human replies keep their user attribution, and goal steering respects the Session's auto-answer setting without granting permissions or human approval.
