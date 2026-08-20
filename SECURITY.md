# Security

## Operational defaults

Apollo binds to `127.0.0.1` by default. Keep the server on a loopback address unless remote access is intentional and API authentication has been enabled.

The HTTP API applies these request limits:

- JSON request bodies: 1 MiB
- playlist artwork uploads: 10 MiB

API JSON responses use `Cache-Control: no-store`. Responses also include `X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer`.

Do not expose Apollo directly to the public internet without TLS, authentication, network filtering, and an actively maintained reverse proxy. Treat Spotify credentials, API shared secrets, session tokens, logs, configuration files, and downloaded media paths as sensitive data.

## Reporting a vulnerability

Do not publish exploitable details, credentials, or private media paths in a public issue. Use GitHub's private vulnerability reporting flow from the repository Security tab when it is available. Otherwise contact the repository owner privately and include:

- the affected version or commit
- reproduction steps
- expected and observed behavior
- impact and reachable attack surface
- a minimal proof of concept that does not contain third-party secrets or copyrighted media
