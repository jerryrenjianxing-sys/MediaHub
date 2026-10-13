[CmdletBinding()]
param([string]$OutputDirectory = (Join-Path $PSScriptRoot '../build/native'))
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path $PSScriptRoot -Parent
$buildDirectory = Join-Path $repoRoot 'work/native-build'
& cmake -S (Join-Path $repoRoot 'native') -B $buildDirectory -A x64
if ($LASTEXITCODE -ne 0) { throw 'Native configure failed' }
& cmake --build $buildDirectory --config Release
if ($LASTEXITCODE -ne 0) { throw 'Native build failed' }
New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $buildDirectory 'Release/mediahub-pipe.exe') -Destination (Join-Path $OutputDirectory 'mediahub-pipe.exe')
Write-Output (Join-Path $OutputDirectory 'mediahub-pipe.exe')
