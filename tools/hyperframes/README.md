# MediaHub HyperFrames tool

Independent, optional Windows x64 component. The MediaHub platform installer contains no copy of this payload.

The pinned tool package supplies Node, Chrome headless shell, FFmpeg/FFprobe, Noto Sans SC, GSAP, HyperFrames Producer, Studio and Studio server. The shipped package starts with `runtime/node/node.exe service-entry.mjs` and never installs global Agent skills or uses a system Node/browser/FFmpeg. No cloud rendering, transcription, TTS, remote templates, telemetry or upstream updater is enabled.

## RPC

Input and output are UTF-8 NDJSON on stdin/stdout. Requests are `{ "id": "request-id", "method": "...", "params": {} }`. Replies are `{ "id": "request-id", "result": ... }` or `{ "id": "request-id", "error": { "code": "...", "message": "..." } }`. Diagnostics use stderr.

| Method | Parameters | Result |
|---|---|---|
| create | absolute projectDir; title; orientation landscape/portrait; duration 1–600; optional assets | projectId, projectDir, entry, width, height, fps |
| import | projectDir; assets [{assetId, sourcePath}] | Original asset IDs, hashed local copies and mappings |
| preview | projectDir | studioUrl, previewUrl, ownPid, tokenScope, projectId |
| lint | projectDir | ok, findings, totalErrors, per-file upstream lint results |
| check | projectDir | ok, lint, real browser diagnostics and screenshot |
| render | projectDir; unique taskId; quality draft/standard/high | accepted, taskId, status, proposed outputPath |
| status | optional taskId/projectDir | runtime health or durable task state |
| cancel | taskId | stopped=true only after render worker exits |
| shutdown | — | stopped=true after tasks and servers stop |

Events: `{event:'progress',taskId,progress,stage}`, `{event:'task',taskId,status,...}` and `{event:'project-changed',projectId}`. Task state includes `source:'agent'|'studio'`, projectId, projectDir, start/end times. Only a successful worker exit followed by bundled ffprobe validation returns `artifact:{path,name,mediaValidated:true,media}`. The platform must persist these events and index only validated artifacts. Interrupted task records are never replayed automatically.

One render runs at a time. First release exports H.264 MP4, SDR, authored 1920×1080 or 1080×1920, 30fps. Templates use local assets. Tool removal never removes projects.

## Studio and isolation

The initial MediaHub Studio is a dedicated local editor and preview surface: landscape/portrait canvas, playback, seek, source save, file refresh, lint, real browser check, export and real cancellation. It uses the upstream Studio API render adapter and the exact same Producer pipeline as Agent RPC. It is **not the entire upstream visual editor**; visual timeline editing, object manipulation, registry blocks, cloud and audio generation are excluded from this release.

Studio binds to localhost and requires an instance token in an HttpOnly host-only SameSite=Strict cookie. The connect URL is ephemeral and must not be logged or shown in Agent documentation. Preview is served on a separate 127.0.0.1 origin, with no cookie or management API. Parent controls use postMessage with explicit origin/source; generated HTML has restrictive CSP. The platform must embed Studio in a separate sandboxed Electron session without its preload bridge and allow only its local preview frames. Projects never receive the platform management credential.

## Reproducible packaging

Run `npm ci --ignore-scripts` in this directory; run `node ../../scripts/package-hyperframes.mjs --prepare-only` to prepare the private runtime, then omit the flag to build the independent release archive. Optional build inputs: MEDIAHUB_NODE_CACHE, MEDIAHUB_FFMPEG_CACHE (pinned extracted Gyan binary directory), MEDIAHUB_7ZIP. Runtime hashes are validated and recorded in runtime-lock.json. Immutable ZIP, per-file manifest, sources inventory and SHA256 are emitted to release/.

FFmpeg Gyan full build is GPLv3 with static external libraries. The source inventory preserves the build README, exact version, build configuration, binary hashes, FFmpeg source revision, dependency notices and original source URLs. This inventory must not be misrepresented as a complete archive of all corresponding third-party source code.
