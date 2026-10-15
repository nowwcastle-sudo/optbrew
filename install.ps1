# optbrew installer for Windows PowerShell 5.1 and PowerShell 7.
# It installs the pinned npm release into each agent's skills folder and checks the result.
#   irm https://raw.githubusercontent.com/nowwcastle-sudo/optbrew/v0.1.3/install.ps1 | iex
# To choose agents or a project folder, download the file and run it with parameters:
#   powershell -ExecutionPolicy Bypass -File .\install.ps1 -Agents codex,claude-code -Scope project -Project C:\path\to\site
# Keep this file ASCII without a byte order mark: irm keeps a BOM as a character and iex then fails to parse.
param(
  [string[]]$Agents = @('codex', 'claude-code'),
  [ValidateSet('user', 'project')][string]$Scope = 'user',
  [string]$Project = '',
  [string]$Package = 'optbrew@0.1.3'
)
# The body runs in a child scope so that irm | iex leaves no variables, functions or preferences in the caller's session.
& {
  $ErrorActionPreference = 'Stop'
  $encoding = [Console]::OutputEncoding
  [Console]::OutputEncoding = [Text.Encoding]::UTF8
  try {
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Node.js 22 or later is required: https://nodejs.org' }
    $major = [int]((node -p 'process.versions.node').Split('.')[0])
    if ($major -lt 22) { throw "Node.js 22 or later is required (found $major)." }
    # npx.ps1 is blocked under the default Windows execution policy; npx.cmd is not.
    $npx = if (Get-Command npx.cmd -ErrorAction SilentlyContinue) { 'npx.cmd' } else { 'npx' }

    # -Agents codex,claude-code arrives as an array inside PowerShell and as one string through -File.
    $agentList = (($Agents -join ',') -split '[,\s]+' | Where-Object { $_ }) -join ','
    $target = @('--agents', $agentList, '--scope', $Scope)
    if ($Scope -eq 'project') {
      if (-not $Project) { throw 'Pass -Project with -Scope project.' }
      $target += @('--project', $Project)
    }

    function Invoke-Optbrew([string[]]$Arguments) {
      $out = & $npx --yes --package $Package optbrew @Arguments --json
      if ($LASTEXITCODE) {
        $scopeArgs = if ($Scope -eq 'project') { "--scope project --project `"$Project`"" } else { '--scope user' }
        throw ("optbrew $($Arguments[0]) failed with exit code $LASTEXITCODE (message above). If optbrew is already installed, " +
          "update it with: $npx optbrew@latest update $scopeArgs`n" +
          'If update stops with migration_required, see https://github.com/nowwcastle-sudo/optbrew/blob/v0.1.3/docs/platforms.md#reinstall-after-a-migration_required-update')
      }
      ($out -join "`n") | ConvertFrom-Json
    }

    Write-Host "optbrew: $Package, $Scope scope, agents $agentList"
    $plan = Invoke-Optbrew (@('install') + $target + @('--dry-run'))
    $plan.decision.targets | ForEach-Object { Write-Host "  target: $($_.path)" }
    $installed = Invoke-Optbrew (@('install') + $target)
    Write-Host "install: $($installed.status)"
    $doctor = Invoke-Optbrew (@('doctor') + $target)
    $doctor.targets | ForEach-Object { Write-Host "  $($_.agent): files $($_.file_present), hash $($_.hash_ok), registered $($_.registered)" }
    $bad = @($doctor.targets | Where-Object { -not ($_.file_present -and $_.hash_ok -and $_.registered) })
    if ($bad.Count) { throw "doctor found $($bad.Count) target(s) that failed the check." }
    Write-Host 'Done. Start a new agent session and ask it to run optbrew.'
  } finally {
    [Console]::OutputEncoding = $encoding
  }
}
