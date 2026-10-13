# MediaHub development

Implement the approved first-release plan. Keep the platform installer free of tool payloads. Original tool installations and data remain independently owned; do not modify production tool data during development or acceptance.

The root Electron host owns trusted UI and installation operations. Tool catalogs are data, not dynamically loaded main-process code. Agent and UI use the same management operations. Personal skill metadata must retain `policy.allow_implicit_invocation: false`.

Use isolated acceptance profiles and keep intermediate files in ignored `work/`. Never commit tokens, signing private keys, user profiles, or logs with credentials. Release assets are immutable; increment preview versions for corrections.

Core modules: `desktop/core/`; UI: `src/`; HyperFrames component: `tools/hyperframes/`; native transport: `native/`; distributable Agent skill: `agent-skill/mediahub/`.
