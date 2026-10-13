#!/usr/bin/env bash
set -Eeuo pipefail

# Run with the MSYS2 UCRT64 shell. No sources or build files are edited in place.
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd -- "$SCRIPT_DIR/../.." && pwd)"
BUILD_ROOT="${MEDIAHUB_FFMPEG_BUILD_ROOT:-$REPO_DIR/work/ffmpeg-build}"
mkdir -p "$BUILD_ROOT"
BUILD_ROOT="$(cd -- "$BUILD_ROOT" && pwd)"
PREFIX="$BUILD_ROOT/prefix"
ARCHIVES="$BUILD_ROOT/source-archives"
BUILD="$BUILD_ROOT/build"
OUT="$REPO_DIR/work/ffmpeg-output"
SOURCE_OUT="$OUT/source"
BINARY_OUT="$OUT/windows-x64"
JOBS="${MEDIAHUB_BUILD_JOBS:-$(nproc)}"
case "$MSYSTEM" in UCRT64) ;; *) printf 'Use MSYS2 UCRT64, got %s\n' "${MSYSTEM:-unknown}" >&2; exit 2 ;; esac
[[ "$JOBS" =~ ^[1-9][0-9]*$ ]] || { printf 'Invalid build jobs\n' >&2; exit 2; }
mkdir -p "$PREFIX" "$ARCHIVES" "$BUILD" "$SOURCE_OUT/source-archives" "$SOURCE_OUT/build-records" "$SOURCE_OUT/licenses" "$BINARY_OUT/licenses"
export SOURCE_DATE_EPOCH=1777856400
export LC_ALL=C
export TZ=UTC
export PATH="/ucrt64/bin:/usr/bin:/bin"
export CC=gcc AR=ar RANLIB=ranlib STRIP=strip
export PKG_CONFIG_LIBDIR="$PREFIX/lib/pkgconfig"
export PKG_CONFIG_PATH="$PREFIX/lib/pkgconfig"
export PKG_CONFIG_ALLOW_SYSTEM_CFLAGS=1 PKG_CONFIG_ALLOW_SYSTEM_LIBS=1

fetch() {
  local url="$1" file="$2" checksum="$3" directory="$4"
  if [[ ! -f "$ARCHIVES/$file" ]] || ! printf '%s  %s\n' "$checksum" "$ARCHIVES/$file" | sha256sum --check --status; then
    curl --fail --location --retry 5 --retry-delay 3 --connect-timeout 30 --output "$ARCHIVES/$file.part" "$url"
    printf '%s  %s\n' "$checksum" "$ARCHIVES/$file.part" | sha256sum --check --status
    mv -- "$ARCHIVES/$file.part" "$ARCHIVES/$file"
  fi
  printf '%s  %s\n' "$checksum" "$ARCHIVES/$file" | sha256sum --check
  cp -- "$ARCHIVES/$file" "$SOURCE_OUT/source-archives/$file"
  [[ ! -d "$BUILD/$directory" ]] || { printf 'Build directory already exists; choose a fresh MEDIAHUB_FFMPEG_BUILD_ROOT.\n' >&2; exit 2; }
  tar -xf "$ARCHIVES/$file" -C "$BUILD"
}

fetch 'https://ffmpeg.org/releases/ffmpeg-8.1.1.tar.xz' 'ffmpeg-8.1.1.tar.xz' 'b6863adde98898f42602017462871b5f6333e65aec803fdd7a6308639c52edf3' 'ffmpeg-8.1.1'
fetch 'https://code.videolan.org/videolan/x264/-/archive/b35605ace3ddf7c1a5d67a2eb553f034aef41d55/x264-b35605ace3ddf7c1a5d67a2eb553f034aef41d55.tar.gz' 'x264-b35605ace3ddf7c1a5d67a2eb553f034aef41d55.tar.gz' 'cd71a7515b0e9a012e1ac9b1f8415bebcaf6fc97d4db32286642ac4c0fbe24f9' 'x264-b35605ace3ddf7c1a5d67a2eb553f034aef41d55'
fetch 'https://zlib.net/fossils/zlib-1.3.1.tar.gz' 'zlib-1.3.1.tar.gz' '9a93b2b7dfdac77ceba5a558a580e74667dd6fede4585b91eefb60f03b72df23' 'zlib-1.3.1'

cp -- "$SCRIPT_DIR/source-lock.json" "$SCRIPT_DIR/build.sh" "$SCRIPT_DIR/README.md" "$SCRIPT_DIR/verify.ps1" "$SOURCE_OUT/"
cp -- "$REPO_DIR/.github/workflows/ffmpeg.yml" "$SOURCE_OUT/ffmpeg.yml"
cp -- "$SCRIPT_DIR/source-lock.json" "$BINARY_OUT/"
printf 'No upstream source patches are applied. configure/make only create generated build files.\n' > "$SOURCE_OUT/patches.txt"
pacman -Q > "$SOURCE_OUT/build-records/msys2-packages.txt"
{ gcc --version; ld --version; nasm -v; make --version; pkgconf --version; uname -a; } > "$SOURCE_OUT/build-records/toolchain.txt"
if [[ -d /ucrt64/share/licenses ]]; then cp -R /ucrt64/share/licenses "$SOURCE_OUT/licenses/toolchain-notices"; fi

cd "$BUILD/zlib-1.3.1"
./configure --static --prefix="$PREFIX" 2>&1 | tee "$SOURCE_OUT/build-records/zlib-configure.log"
make -j "$JOBS"
make install
cp -- zlib.h "$SOURCE_OUT/licenses/zlib-zlib.h"
cp -- zlib.h "$BINARY_OUT/licenses/zlib-zlib.h"
cp -- Makefile "$SOURCE_OUT/build-records/zlib-Makefile"

cd "$BUILD/x264-b35605ace3ddf7c1a5d67a2eb553f034aef41d55"
./configure --host=x86_64-w64-mingw32 --prefix="$PREFIX" --enable-static --disable-cli --disable-opencl --disable-avs --disable-lavf --disable-swscale --extra-cflags='-O2' --extra-ldflags='-static' 2>&1 | tee "$SOURCE_OUT/build-records/x264-configure.log"
make -j "$JOBS"
make install-lib-static
cp -- COPYING "$SOURCE_OUT/licenses/x264-COPYING"
cp -- COPYING "$BINARY_OUT/licenses/x264-COPYING"
cp -- config.mak config.h x264_config.h "$SOURCE_OUT/build-records/"

cd "$BUILD/ffmpeg-8.1.1"
./configure \
  --prefix="$PREFIX" --target-os=mingw32 --arch=x86_64 \
  --enable-gpl --enable-libx264 --enable-zlib \
  --disable-ffplay --disable-shared --enable-static --disable-autodetect \
  --disable-network --disable-protocols --enable-protocol=file,pipe \
  --enable-w32threads --disable-pthreads --disable-debug --disable-doc \
  --pkg-config-flags=--static --extra-cflags="-O2 -I$PREFIX/include" \
  --extra-ldflags="-static -L$PREFIX/lib" 2>&1 | tee "$SOURCE_OUT/build-records/ffmpeg-configure.log"
make -j "$JOBS" ffmpeg.exe ffprobe.exe
cp -- ffmpeg.exe ffprobe.exe "$BINARY_OUT/"
cp -- COPYING.GPLv2 COPYING.GPLv3 COPYING.LGPLv2.1 COPYING.LGPLv3 LICENSE.md "$SOURCE_OUT/licenses/"
cp -- COPYING.GPLv2 LICENSE.md "$BINARY_OUT/licenses/"
cp -- config.h config_components.h ffbuild/config.mak ffbuild/config.log "$SOURCE_OUT/build-records/"
"$BINARY_OUT/ffmpeg.exe" -version > "$BINARY_OUT/version.txt"
"$BINARY_OUT/ffmpeg.exe" -buildconf > "$BINARY_OUT/buildconf.txt" 2>&1
"$BINARY_OUT/ffmpeg.exe" -L > "$BINARY_OUT/license.txt" 2>&1
"$BINARY_OUT/ffprobe.exe" -version > "$BINARY_OUT/ffprobe-version.txt"
"$BINARY_OUT/ffmpeg.exe" -hide_banner -protocols > "$BINARY_OUT/protocols.txt"
"$BINARY_OUT/ffmpeg.exe" -hide_banner -encoders > "$BINARY_OUT/encoders.txt"
for executable in ffmpeg ffprobe; do
  objdump -p "$BINARY_OUT/$executable.exe" > "$BINARY_OUT/$executable-pe-imports.txt"
  awk '/DLL Name:/{print $3}' "$BINARY_OUT/$executable-pe-imports.txt" | while IFS= read -r dll; do
    # Only Windows system DLLs are allowed. All media-library code is in the source archive.
    case "${dll,,}" in
      api-ms-win-*.dll|ext-ms-win-*.dll|kernel32.dll|kernelbase.dll|ntdll.dll|msvcrt.dll|ucrtbase.dll|advapi32.dll|bcrypt.dll|ole32.dll|oleaut32.dll|user32.dll|gdi32.dll|shell32.dll|shlwapi.dll|winmm.dll|avrt.dll|psapi.dll|secur32.dll|ws2_32.dll|comdlg32.dll|comctl32.dll) ;;
      *) printf 'Unexpected external DLL in %s: %s\n' "$executable" "$dll" >&2; exit 1 ;;
    esac
  done
done
printf 'FFmpeg 8.1.1 with x264 is GPL-2.0-or-later. Source archive, unmodified upstream sources, configure logs and build script accompany these binaries.\nThis software is based in part on the work of the Independent JPEG Group; those upstream files have not been modified.\nOnly the external media libraries x264 (GPL-2.0-or-later) and zlib (Zlib) are enabled. MinGW compiler runtime notices are included with the source package.\n' > "$BINARY_OUT/NOTICE.txt"
cp -- "$BINARY_OUT/NOTICE.txt" "$BINARY_OUT/buildconf.txt" "$BINARY_OUT/version.txt" "$BINARY_OUT/ffprobe-version.txt" "$SOURCE_OUT/build-records/"
cd "$BINARY_OUT"
sha256sum ffmpeg.exe ffprobe.exe > binary-checksums.sha256
cp -- binary-checksums.sha256 "$OUT/"
printf 'Built binaries: %s\nCorresponding source: %s\n' "$BINARY_OUT" "$SOURCE_OUT"
