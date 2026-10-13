# MediaHub FFmpeg source build

This module builds FFmpeg **8.1.1** and FFprobe for Windows x64 from fixed, hash-checked upstream sources. The only external media libraries enabled are **x264** at stable commit `b35605ace3ddf7c1a5d67a2eb553f034aef41d55` and **zlib 1.3.1**. See `source-lock.json` for archive URLs, full commits and SHA-256 values. FFmpeg release tag `n8.1.1` resolves to `239f2c733de417201d7ad3b3b8b0d9b63285b2b1`.

FFmpeg and x264 are distributed here under GPL-2.0-or-later; zlib retains its zlib license. All original copyright and license files remain in the complete upstream archives. This software is based in part on the work of the Independent JPEG Group. No upstream source patches are applied.

## Build

Use the repository's **FFmpeg Windows source build** GitHub workflow (`.github/workflows/ffmpeg.yml`), or run this in a fresh **MSYS2 UCRT64** shell after installing `make`, `curl`, `diffutils`, `tar`, `xz`, `mingw-w64-ucrt-x86_64-gcc`, `mingw-w64-ucrt-x86_64-nasm`, and `mingw-w64-ucrt-x86_64-pkgconf`:

```sh
bash tools/ffmpeg-source/build.sh
```

Builds are performed under ignored `work/`; choose a fresh `MEDIAHUB_FFMPEG_BUILD_ROOT` when rerunning. Binaries and corresponding source are produced under `work/ffmpeg-output/`. `MEDIAHUB_BUILD_JOBS` optionally limits parallel compilation.

The published source bundle also works on its own: extract it into a folder, open that folder in MSYS2 UCRT64, and run `bash ./build.sh`. It uses the included archives without downloading them and writes generated files under that folder's `work/`. Their hashes are still verified. When using the repository instead, copy the three exact archives into `$MEDIAHUB_FFMPEG_BUILD_ROOT/source-archives/` before running the script to build without downloading sources.

The source archive contains the three complete untouched upstream archives, lock file, workflow and build script, generated configuration, configuration logs, licenses, MinGW toolchain notices, and the exact installed package versions. Compiler packages can evolve; this recipe makes the media source and configuration rebuildable, and does not claim that a future different compiler produces identical bytes.

FFmpeg uses static media libraries, Windows native threads, its internal codecs/filters/muxers/demuxers, and file/pipe protocols. Network protocols, auto-detected external libraries, shared media libraries, FFplay, documentation and debug symbols are disabled. x264 CLI and integrations with other media libraries are disabled. Generated PE import reports must contain only Windows system DLLs; imported MinGW, MSYS, x264, zlib or other third-party DLLs fail the build.

## Acceptance and distribution

```powershell
./tools/ffmpeg-source/verify.ps1 -BinaryDirectory ./work/ffmpeg-output/windows-x64
```

Acceptance clears media runtime paths, checks both program versions, checks that network protocols are absent, creates PNG input, encodes horizontal and vertical H.264 video, encodes AAC audio, and probes the MP4 in paths containing spaces and Chinese characters.

The workflow produces immutable assets `mediahub-ffmpeg-8.1.1-windows-x64.zip` and `mediahub-ffmpeg-8.1.1-source.zip`, plus `SHA256SUMS.txt`. Publish both assets together on the same MediaHub GitHub release server. Every HyperFrames tool package containing these executables must identify their hashes, include the binary notices, and link to the matching source asset. Do not substitute other FFmpeg binaries while keeping this source bundle.
