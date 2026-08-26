# Security

Edge Stats runs entirely on your machine: the store, the dashboard, the
API, and the MCP server all bind to localhost by default, hold no
accounts, and send no telemetry. The most sensitive things in a
deployment are your own data-vendor keys, which live in environment
variables and are never logged or stored by design.

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub's security
advisories for this repository:

**https://github.com/LuxAlgo/edge-stats/security/advisories/new**

Do not open public issues for security reports. You will get an
acknowledgement in the advisory thread, and a fix and disclosure will be
coordinated there.

## Scope notes

- The `serve` and MCP HTTP entries bind to 127.0.0.1 by default. Exposing
  them beyond localhost is an explicit user action and puts your own
  trading database on a network; the docs warn against it.
- Adapters make outbound requests only to their documented vendors, only
  during `sync`, and never transmit your keys anywhere except the vendor
  the key belongs to.
