param([Parameter(Mandatory=$true)][string]$BinaryDirectory, [string]$OutputDirectory)
$ErrorActionPreference = 'Stop'
$binaryRoot = (Resolve-Path -LiteralPath $BinaryDirectory).Path
if (!$OutputDirectory) { $OutputDirectory = Join-Path $binaryRoot 'acceptance' }
$outputRoot = [IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Force -Path $outputRoot | Out-Null
$ffmpeg = Join-Path $binaryRoot 'ffmpeg.exe'
$ffprobe = Join-Path $binaryRoot 'ffprobe.exe'
$oldPath = $env:PATH
try {
    # Verifies that the binaries do not need a user-installed media runtime.
    $env:PATH = Join-Path $env:SystemRoot 'System32'
    $version = & $ffmpeg -version 2>&1 | Out-String
    if ($LASTEXITCODE -ne 0 -or $version -notmatch 'ffmpeg version 8\.1\.1') { throw 'Unexpected FFmpeg version' }
    $probeVersion = & $ffprobe -version 2>&1 | Out-String
    if ($LASTEXITCODE -ne 0 -or $probeVersion -notmatch 'ffprobe version 8\.1\.1') { throw 'Unexpected FFprobe version' }
    $version | Set-Content -LiteralPath (Join-Path $outputRoot 'ffmpeg-version.txt') -Encoding utf8
    $probeVersion | Set-Content -LiteralPath (Join-Path $outputRoot 'ffprobe-version.txt') -Encoding utf8
    $protocols = & $ffmpeg -hide_banner -protocols 2>&1 | Out-String
    if ($LASTEXITCODE -ne 0 -or $protocols -match '\b(http|https|tcp|udp|ftp|tls)\b') { throw 'Network protocol present' }
    $protocols | Set-Content -LiteralPath (Join-Path $outputRoot 'protocols.txt') -Encoding utf8
    $png = Join-Path $outputRoot '中文 frame 01.png'
    & $ffmpeg -v error -f lavfi -i 'color=c=0x147d6a:s=1920x1080:r=30' -frames:v 1 -y $png
    if ($LASTEXITCODE -ne 0) { throw 'PNG generation failed' }
    $mp4 = Join-Path $outputRoot '中文 video 01.mp4'
    & $ffmpeg -v error -loop 1 -framerate 30 -i $png -f lavfi -i 'sine=frequency=440:sample_rate=48000' -t 1 -c:v libx264 -preset ultrafast -pix_fmt yuv420p -c:a aac -movflags +faststart -y $mp4
    if ($LASTEXITCODE -ne 0) { throw 'H264/AAC/PNG render failed' }
    $mediaText = & $ffprobe -v error -show_format -show_streams -of json $mp4 | Out-String
    if ($LASTEXITCODE -ne 0) { throw 'MP4 media inspection failed' }
    $media = $mediaText | ConvertFrom-Json
    $video = $media.streams | Where-Object codec_type -eq 'video' | Select-Object -First 1
    $audio = $media.streams | Where-Object codec_type -eq 'audio' | Select-Object -First 1
    if ($video.codec_name -ne 'h264' -or $video.width -ne 1920 -or $video.height -ne 1080 -or $video.avg_frame_rate -ne '30/1' -or $audio.codec_name -ne 'aac') { throw 'Unexpected rendered media properties' }
    $mediaText | Set-Content -LiteralPath (Join-Path $outputRoot 'media.json') -Encoding utf8
    $portrait = Join-Path $outputRoot 'portrait.mp4'
    & $ffmpeg -v error -f lavfi -i 'color=c=black:s=1080x1920:r=30' -t 0.2 -c:v libx264 -preset ultrafast -pix_fmt yuv420p -y $portrait
    if ($LASTEXITCODE -ne 0) { throw 'Portrait render failed' }
    $checksums = @{}
    foreach ($name in @('ffmpeg.exe','ffprobe.exe')) { $checksums[$name] = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $binaryRoot $name)).Hash.ToLowerInvariant() }
    @{ version = '8.1.1'; target = 'windows-x64'; staticMediaDependencies = @('x264','zlib'); checksums = $checksums; passed = $true } | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $outputRoot 'acceptance.json') -Encoding utf8
} finally { $env:PATH = $oldPath }
