[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or $env:RUNNER_OS -ne 'Windows') {
  throw 'Legacy installation acceptance runs only in a disposable GitHub-hosted Windows runner. It must not run on a personal computer or self-hosted runner.'
}
$repoRoot = Split-Path $PSScriptRoot -Parent
Push-Location -LiteralPath $repoRoot
try {
  & node (Join-Path $PSScriptRoot 'accept-legacy.cjs')
  if ($LASTEXITCODE -ne 0) { throw "Legacy acceptance failed (exit $LASTEXITCODE). See work/legacy-acceptance/report.json." }
} finally { Pop-Location }
