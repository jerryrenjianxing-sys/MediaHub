# HyperFrames in MediaHub

Query capabilities before use. Create a platform project with landscape or portrait orientation, then invoke `hyperframes.create` to create its local video composition. Use `hyperframes.preview` for the embedded Studio, `hyperframes.check` for static and browser inspection, and `hyperframes.render` for MP4 export. Only one render runs at a time.

Use `hyperframes.import` with `options.assetId` to copy a registered shared asset into the project while retaining its original asset ID. The project directory supplied by MediaHub is authoritative. Edit its HTML composition using the component's local animation resources and fonts; network scripts are unavailable during offline acceptance.

Query the returned task ID. A completed render includes a registered artifact whose real file has passed media inspection. `hyperframes.stop` stops its local preview. Component updates require an idle tool. Uninstalling the component preserves projects, original assets and completed videos.

The first release supports SDR 1080p at 30 fps. Do not modify the bundled runtime, install global dependencies, turn on upstream telemetry, or treat a generated composition as trusted platform code.
