---
name: mediahub
description: Use the user's running MediaHub workbench to discover installed tools, work with shared projects and assets, and invoke available local capabilities. Use when explicitly selected for a MediaHub task.
---

Use the platform's current tool and capability records rather than assuming a tool is installed. The platform and its tools share one project space; preserve original tool accounts and databases.

Find `connection.json` at the path supplied by the user's connection message. If no path was supplied, use `%LOCALAPPDATA%\MediaHub\connection.json`. Call [scripts/mediahub.ps1](scripts/mediahub.ps1) with `-ConnectionFile`, `-Method`, and optional `-ParamsJson`.

On first connection, query `tools.list`, `workspace.get`, and `capabilities.list`. This inspection is read-only. Follow the user's task and existing authorization when choosing capabilities, installing tools, or modifying project files. Do not configure Agent globals or install this skill globally as a side effect of connecting.

Read [references/platform.md](references/platform.md) for project, asset, task, or installation operations. Read [references/hyperframes.md](references/hyperframes.md) only for video work. A request returns either data or a task/operation ID; query `tasks.get` until its real terminal state. A cancellation request is pending until the platform reports `cancelled`. Do not infer completion from elapsed time, window closure, or a successful request submission.

Read available tool-specific instructions through the tool's capability description when needed. Use shared assets by ID and keep generated results in the corresponding project. Do not overwrite original assets. If a task is interrupted, inspect its recorded result and actual files; do not replay it automatically.
