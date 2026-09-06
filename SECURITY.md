# Security Policy

Human Space Atlas consumes multiple public data sources and exposes server-side proxy/cache endpoints. Security work therefore focuses on protecting credentials, bounding upstream use and preventing public query surfaces from becoming arbitrary network access.

## Reporting

Do not publish real API tokens, Redis/KV credentials, private infrastructure details or exploit payloads containing sensitive data in a public issue.

For private disclosure, contact the repository owner through the contact information on the GitHub profile and include the affected endpoint/component, reproduction steps, impact and a sanitized proof of concept.

## Current controls

The repository currently includes:

- bounded API rate limiting;
- optional distributed Redis/KV-backed rate-limit state;
- explicit query bounds for expensive upstream surfaces such as JPL Horizons;
- server-side cache/fallback behavior for external providers;
- environment-based handling of optional credentials;
- browser-facing guidance that private-scope secrets must not be exposed through Vite variables.

## Deployment considerations

Before exposing an HSA deployment publicly:

- configure trusted proxy behavior deliberately;
- use distributed rate limiting for multi-instance/serverless deployments;
- keep Redis/KV credentials server-side;
- rotate external provider credentials if exposure is suspected;
- restrict CORS/proxy behavior to the intended application surface;
- monitor upstream failure rates and cache behavior;
- review any new URL-fetching endpoint for SSRF and resource-exhaustion risks.

## Scientific integrity as a security boundary

Data-quality claims are treated separately from transport security. A provider response should not gain stronger semantic status merely because it was fetched successfully. Contributions must preserve the repository's distinction between observed data, propagated/calculated positions and visual reconstruction.
