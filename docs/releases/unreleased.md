# Unreleased

## Changed

- Web Usage leads with estimated spend, followed by account-reported provider quotas, charts and Backend consumption. Transparent provider marks retain their source colors or theme-safe treatment; unknown providers keep their labels without a substitute mark.
- The Team shell picker groups compact rows under Running and Archived, newest first within each section. Rows identify their owner, preserve selection through status changes and keep observed archived output accessible during the current connection. The output view retains the full command, working directory and PID.
- Automatic question answers retain their automatic attribution in goal continuation. Human replies keep their user attribution, and goal steering respects the Session's auto-answer setting without granting permissions or human approval.

## Removed

- Per-message prompt-cost summaries and expandable cost breakdowns in the web conversation, matching the TUI. Usage reports, Session totals, and backend accounting remain available.

- The shell queue channel and machine-wide scheduler. Shell commands run immediately after permission and family-cap checks, with foreground and background execution, timeouts, and memory limits.
