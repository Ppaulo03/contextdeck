# Changelog

## 1.0.0 — final preparation

- Stable Windows x64 NSIS installer metadata.
- Preserves the legacy ContextDeck profile, Chromium partition, Herdr session, bindings, preferences, and Git selections.
- Projects remains enabled by default, with `CONTEXTDECK_PROJECTS=0` as the opt-out.
- No automatic updates or telemetry.

The installer is unsigned. Herdr remains an external dependency. Authenticated
installer validation remains a manual release gate.
