[CmdletBinding()]
param(
  [string]$ConnectionFile = (Join-Path $env:LOCALAPPDATA 'MediaHub/connection.json'),
  [Parameter(Mandatory = $true)][string]$Method,
  [string]$ParamsJson = '{}'
)
$ErrorActionPreference = 'Stop'
if (-not (Test-Path -LiteralPath $ConnectionFile -PathType Leaf)) { throw 'MediaHub connection file was not found. Open MediaHub and copy its Agent connection instructions.' }
$connectionRecord = Get-Content -LiteralPath $ConnectionFile -Raw -Encoding UTF8 | ConvertFrom-Json
if ($connectionRecord.protocol -ne 1 -or $connectionRecord.transport -ne 'windows-named-pipe') { throw 'Unsupported MediaHub connection protocol.' }
if (-not $connectionRecord.pipe -or $connectionRecord.pipe -notmatch '^[a-zA-Z0-9_.-]{1,160}$') { throw 'Invalid MediaHub pipe name.' }
if (-not $connectionRecord.clientPath -or -not (Test-Path -LiteralPath $connectionRecord.clientPath -PathType Leaf)) { throw 'MediaHub native client was not found.' }
$requestParameters = $ParamsJson | ConvertFrom-Json
$requestEnvelope = @{ protocol = 1; id = [guid]::NewGuid().ToString(); method = $Method; params = $requestParameters }
$requestJson = $requestEnvelope | ConvertTo-Json -Depth 32 -Compress
if ([Text.Encoding]::UTF8.GetByteCount($requestJson) -gt 1048576) { throw 'Request exceeds MediaHub transport limit.' }
$startInfo = New-Object Diagnostics.ProcessStartInfo
$startInfo.FileName = $connectionRecord.clientPath
$startInfo.Arguments = "client --pipe $($connectionRecord.pipe)"
$startInfo.UseShellExecute = $false
$startInfo.CreateNoWindow = $true
$startInfo.WindowStyle = [Diagnostics.ProcessWindowStyle]::Hidden
$startInfo.RedirectStandardInput = $true
$startInfo.RedirectStandardOutput = $true
$startInfo.RedirectStandardError = $true
$startInfo.StandardOutputEncoding = New-Object Text.UTF8Encoding($false)
$startInfo.StandardErrorEncoding = New-Object Text.UTF8Encoding($false)
$clientProcess = New-Object Diagnostics.Process
$clientProcess.StartInfo = $startInfo
try {
  [void]$clientProcess.Start()
  $clientProcess.StandardInput.WriteLine($requestJson)
  $clientProcess.StandardInput.Close()
  $responseRead = $clientProcess.StandardOutput.ReadToEndAsync()
  $errorRead = $clientProcess.StandardError.ReadToEndAsync()
  if (-not $clientProcess.WaitForExit(130000)) { $clientProcess.Kill(); throw 'MediaHub request timed out.' }
  $responseText = $responseRead.Result.Trim()
  if ($clientProcess.ExitCode -ne 0) { throw "MediaHub connection failed ($($clientProcess.ExitCode)): $($errorRead.Result.Trim())" }
  if (-not $responseText) { throw 'MediaHub returned an empty response.' }
  $responseRecord = $responseText | ConvertFrom-Json
  Write-Output $responseText
  if ($responseRecord.ok -eq $false) { exit 1 }
} finally { $clientProcess.Dispose() }
