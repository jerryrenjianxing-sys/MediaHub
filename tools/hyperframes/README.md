# MediaHub HyperFrames tool

Independent, optional Windows x64 component. The MediaHub platform installer contains no copy of this payload.

The pinned tool package supplies Node, Chrome headless shell, FFmpeg/FFprobe, Noto Sans SC, GSAP, HyperFrames Producer, Studio and Studio server. The shipped package starts with `runtime/node/node.exe service-entry.mjs` and never installs global Agent skills or uses a system Node/browser/FFmpeg. No cloud rendering, transcription, TTS, remote templates, telemetry or upstream updater is enabled.

## RPC

Input and output are UTF-8 NDJSON on stdin/stdout. Requests are `{ "id": "request-id", "method": "...", "params": {} }`. Replies are `{ "id": "request-id", "result": ... }` or `{ "id": "request-id", "error": { "code": "...", "message": "..." } }`. Diagnostics use stderr.

| Method | Parameters | Result |
|---|---|---|
| create | absolute projectDir; optional platform projectId; title; orientation landscape/portrait; duration 1–600; optional assets | projectId, projectDir, entry, width, height, fps |
| import | projectDir; assets [{assetId, sourcePath}] | Original asset IDs, hashed local copies and mappings |
| preview | projectDir | studioUrl, previewUrl, ownPid, tokenScope, projectId |
| lint | projectDir | ok, findings, totalErrors, per-file upstream lint results |
| check | projectDir | ok, lint, real browser diagnostics and screenshot |
| render | projectDir; unique taskId; quality draft/standard/high | accepted, taskId, status, proposed outputPath |
| status | optional taskId/projectDir | runtime health or durable task state |
| cancel | taskId | stopped=true only after render worker exits |
| shutdown / stop | optional idleOnly=true for update/uninstall | Rejects TOOL_BUSY atomically when a render is accepted; otherwise stopped=true after servers stop |

Events: `{event:'progress',taskId,progress,stage}`, `{event:'task',taskId,status,...}` and `{event:'project-changed',projectId}`. Task state includes `source:'agent'|'studio'`, projectId, projectDir, start/end times. Only a successful worker exit followed by bundled ffprobe validation returns `artifact:{path,name,mediaValidated:true,media}`. The platform must persist these events and index only validated artifacts. Interrupted task records are never replayed automatically.

One render runs at a time. Each render has its own native Windows Job Object: forced cancellation closes that Job and reclaims its Node worker, Chrome and FFmpeg descendants, including detached processes. The helper and its MIT source are inside the independent component. First release exports H.264 MP4, SDR, authored 1920×1080 or 1080×1920, 30fps. Templates use local assets. Tool removal never removes projects.

## Studio and isolation

The initial MediaHub Studio is a dedicated local editor and preview surface: landscape/portrait canvas, playback, seek, source save, file refresh, lint, real browser check, export and real cancellation. It uses the upstream Studio API render adapter and the exact same Producer pipeline as Agent RPC. It is **not the entire upstream visual editor**; visual timeline editing, object manipulation, registry blocks, cloud and audio generation are excluded from this release.

Studio binds to localhost and requires an instance token in an HttpOnly host-only SameSite=Strict cookie. The connect URL is ephemeral and must not be logged or shown in Agent documentation. Preview is served on a separate 127.0.0.1 origin, with no cookie or management API. Parent controls use postMessage with explicit origin/source; generated HTML has restrictive CSP. The platform must embed Studio in a separate sandboxed Electron session without its preload bridge and allow only its local preview frames. Projects never receive the platform management credential.

## Reproducible packaging

Run `npm ci --ignore-scripts` in this directory; run `node ../../scripts/package-hyperframes.mjs --prepare-only` to prepare the private runtime, then omit the flag to build the independent release archive. Required build inputs: MEDIAHUB_FFMPEG_CACHE (extracted MediaHub source-built binary directory) and MEDIAHUB_FFMPEG_SOURCE (the matching source ZIP). Optional inputs: MEDIAHUB_NODE_CACHE, MEDIAHUB_FFMPEG_SOURCE_SHA256. Runtime hashes are validated and recorded in runtime-lock.json. Immutable ZIP, per-file manifest, sources inventory and SHA256 are emitted to release/.

The distributable uses the MediaHub FFmpeg 8.1.1 source build with exactly two external media libraries, x264 and zlib. It includes licenses, binary checksums, build configuration, fixed source hashes and a complete corresponding-source ZIP containing the original sources, configure logs and build script. Unrelated Gyan full-build binaries are not accepted by the public packaging script.

GSAP is under Webflow's [Standard No Charge GSAP License](https://gsap.com/community/standard-license/), not MIT/Apache. Its published FAQ permits commercial and AI-generated animation code; similar no-code visual animation builders are restricted. This Studio edits source code, and keeps all original GSAP notices. A future complete visual animation builder requires a fresh license review.
