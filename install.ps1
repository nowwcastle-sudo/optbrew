# optbrew installer for Windows PowerShell 5.1 and PowerShell 7.
# It installs the pinned npm release into each agent's skills folder and checks the result.
#   irm https://raw.githubusercontent.com/nowwcastle-sudo/optbrew/v0.3.5/install.ps1 | iex
# To choose agents or a project folder, download the file and run it with parameters:
#   powershell -ExecutionPolicy Bypass -File .\install.ps1 -Agents codex,claude-code -Scope project -Project C:\path\to\site
# npx runs in a new empty temporary folder with the registry named on its command line, so an .npmrc in the folder this
# starts from (a site project you may not control) can neither swap the package nor add npm options. A private mirror goes
# in -Registry.
# Keep this file ASCII without a byte order mark: irm keeps a BOM as a character and iex then fails to parse.
param(
  [string[]]$Agents = @('codex', 'claude-code'),
  [ValidateSet('user', 'project')][string]$Scope = 'user',
  [string]$Project = '',
  [string]$Package = 'optbrew@0.3.5',
  [string]$Registry = 'https://registry.npmjs.org/'
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
    if ($Registry -notmatch '^https://') { throw 'Pass -Registry as an https:// URL.' }
    # npx.ps1 is blocked under the default Windows execution policy; npx.cmd is not.
    $npx = if (Get-Command npx.cmd -ErrorAction SilentlyContinue) { 'npx.cmd' } else { 'npx' }
    $npxArgs = @('--yes', '--registry', $Registry, '--package', $Package)

    # -Agents codex,claude-code arrives as an array inside PowerShell and as one string through -File.
    $agentList = (($Agents -join ',') -split '[,\s]+' | Where-Object { $_ }) -join ','
    $target = @('--agents', $agentList, '--scope', $Scope)
    if ($Scope -eq 'project') {
      if (-not $Project) { throw 'Pass -Project with -Scope project.' }
      # Made absolute before the working folder changes below, so a relative -Project still names the folder the user meant.
      $projectPath = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Project)
      $target += @('--project', $projectPath)
    }

    function Invoke-Optbrew([string[]]$Arguments) {
      $out = & $npx @npxArgs optbrew @Arguments --json
      if ($LASTEXITCODE) {
        $scopeArgs = if ($Scope -eq 'project') { "--scope project --project `"$projectPath`"" } else { '--scope user' }
        throw ("optbrew $($Arguments[0]) failed with exit code $LASTEXITCODE (message above). If optbrew is already installed, " +
          "update it from an empty folder with: $npx $($npxArgs -join ' ') optbrew update $scopeArgs`n" +
          'If update stops with migration_required, see https://github.com/nowwcastle-sudo/optbrew/blob/v0.3.5/docs/platforms.md#reinstall-after-a-migration_required-update')
      }
      ($out -join "`n") | ConvertFrom-Json
    }

    Write-Host "optbrew: $Package from $Registry, $Scope scope, agents $agentList"
    $work = Join-Path ([IO.Path]::GetTempPath()) ('optbrew-install-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $work | Out-Null
    Push-Location -LiteralPath $work
    try {
      $plan = Invoke-Optbrew (@('install') + $target + @('--dry-run'))
      $plan.decision.targets | ForEach-Object { Write-Host "  target: $($_.path)" }
      $installed = Invoke-Optbrew (@('install') + $target)
      Write-Host "install: $($installed.status)"
      $doctor = Invoke-Optbrew (@('doctor') + $target)
      $doctor.targets | ForEach-Object { Write-Host "  $($_.agent): files $($_.file_present), hash $($_.hash_ok), registered $($_.registered)" }
      $bad = @($doctor.targets | Where-Object { -not ($_.file_present -and $_.hash_ok -and $_.registered) })
      if ($bad.Count) { throw "doctor found $($bad.Count) target(s) that failed the check." }
    } finally {
      Pop-Location
      Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
    }
    Write-Host 'Done. Start a new agent session and ask it to run optbrew.'
  } finally {
    [Console]::OutputEncoding = $encoding
  }
}
