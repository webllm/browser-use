# Architecture Decisions

- [ADR-0001 — Defer Rust core and require an optional process boundary](0001-rust-core-process-boundary.md) - Defines the boundary and evidence required before a Rust browser core can supplement the TypeScript runtime.
- [ADR-0002 — Send no product telemetry](0002-no-product-telemetry.md) - Removes anonymous usage telemetry from the TypeScript port and keeps it out when porting upstream changes.
- [ADR-0003 — Launch local browsers on a persistent profile](0003-persistent-browser-profiles.md) - Local browsers run in a Playwright persistent context so user_data_dir persists and default extensions run, matching the Python library's behavior.
