# Managed task spawn errors

## Changed

- On macOS, when the operating system refuses to start a process with a synchronous system error that carries a string `code` and `syscall`, such as `E2BIG` or `ENAMETOOLONG`, the spawn now fails as an ordinary process error instead of escaping as an unexpected error.
