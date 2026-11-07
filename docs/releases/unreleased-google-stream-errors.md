# Google stream errors

## Fixed

- Gemini and Antigravity AI SDK streams that end with an in-stream provider error now fail with that error's classification and message. Previously they were reported as "Provider ended the response without an answer and without a finish reason", or settled as a completed answer when text had already arrived. Overloaded and internal errors stay retryable; invalid-argument errors are no longer retried.
