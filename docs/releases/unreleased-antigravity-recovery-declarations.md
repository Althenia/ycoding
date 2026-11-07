# Antigravity tool-disabled requests

## Fixed

- Antigravity Gemini requests sent during terminal-response recovery and at the agent's Step limit omit tool declarations and keep function calling set to `NONE`. With declarations present, the model could emit a function call anyway; the call was rejected and the Session failed with "Tools are disabled for terminal response recovery". A call emitted without declarations is still rejected without execution, and recovery is still limited to one Step. The changed request prefix makes that single request a prefix-cache miss, which happens only after a silent Step or at the Step limit. Other routes are unchanged.
