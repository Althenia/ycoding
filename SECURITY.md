# Security

## Threat model

YCoding is a local terminal coding agent with access to shell execution, files, configured network tools, providers, and MCP servers.

### No security sandbox

The permission system is an interaction and approval boundary. It is not operating-system isolation and must not be treated as a sandbox.

Run YCoding inside a container, virtual machine, or restricted operating-system account when untrusted code or repositories require stronger isolation.

### Local server

The local server is started for the terminal application and can also be exposed explicitly. Any non-loopback deployment must configure authentication and network controls. Set `YCODING_SERVER_PASSWORD` to require HTTP Basic authentication.

Do not expose an unauthenticated server to an untrusted network.

### External systems

Data sent to configured model providers, MCP servers, hooks, plugins, and other integrations is governed by those systems and their credentials. Review each integration before enabling it.

## Out of scope

The following are expected consequences of explicitly enabled behavior rather than security boundaries:

- Commands or file changes that the user approved.
- Access through a server intentionally exposed without authentication.
- Provider-side retention or processing under the provider's policy.
- Behavior of user-installed MCP servers, hooks, skills, agents, or plugins.
- Effects of configuration controlled by the same local user account.

## Reporting a vulnerability

Use the repository's **Security** tab and choose **Report a vulnerability** to create a private security advisory. Include:

- affected version or commit,
- reproduction steps,
- security impact,
- required configuration and trust assumptions,
- a minimal proof of concept,
- suggested mitigation when known.

Do not publish exploitable details in a public issue before maintainers have reviewed the report.
