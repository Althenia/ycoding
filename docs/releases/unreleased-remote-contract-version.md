# Remote contract versions

## Fixed

- Remote clients and the relay can connect across builds that use the same contract revision. A different schema digest is logged without blocking the connection. An unsupported operation fails on its own, so other requests can continue on the same socket.
