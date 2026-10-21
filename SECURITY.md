# Security policy

## Supported versions

| Version | Security fixes |
| --- | --- |
| 0.1.x previews | Best-effort maintenance |
| Earlier versions | Not supported |

## Reporting a vulnerability

Do **not** post exploit details, private data, tokens, or other sensitive information in public Issues.

Prefer GitHub's **private vulnerability reporting** facility if it is available for this repository. If that feature is not available, open a public issue **without technical exploit details** requesting a private contact channel. The maintainer will arrange a secure reporting path.

Please include the affected release, a minimal reproduction, impact, and any suggested mitigation through the private channel.

This project runs commands requested by its caller. It is **not a sandbox**, authentication service, or multi-tenant isolation boundary. Only pass trusted commands and use separate OS accounts and filesystem permissions for untrusted input. API-supplied verification evidence is not independently certified by the library.

## Response and remediation

The primary maintainer will triage credible reports and coordinate a fix, regression tests, advisory, and release where warranted. Response times are best effort while the project has a single volunteer maintainer.
