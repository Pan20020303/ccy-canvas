param([string]$SkillsDirectory)
$ErrorActionPreference = 'Stop'
if (!$SkillsDirectory) {
  $codexRoot = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path ([Environment]::GetFolderPath('UserProfile')) '.codex' }
  $SkillsDirectory = Join-Path $codexRoot 'skills'
}
$skillRoot = [IO.Path]::GetFullPath($SkillsDirectory)
$bundleRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../resources/creative-workbench'))
$catalog = Get-Content -Raw -LiteralPath (Join-Path $bundleRoot 'catalog.json') | ConvertFrom-Json
# Preflight every destination. Never replace a user-installed skill.
foreach ($skill in $catalog.skills) {
  if ($skill.id -notmatch '^[a-z0-9-]+$') { throw 'Invalid skill name' }
  $target = [IO.Path]::GetFullPath((Join-Path $skillRoot $skill.id))
  if (!$target.StartsWith($skillRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Invalid destination' }
  if (Test-Path -LiteralPath $target) { throw "Already installed; refusing to overwrite $target" }
}
foreach ($skill in $catalog.skills) {
  $target = Join-Path $skillRoot $skill.id
  Copy-Item -LiteralPath (Join-Path $bundleRoot "v$($catalog.version)/skills/$($skill.id)") -Destination $target -Recurse
  Copy-Item -LiteralPath (Join-Path $target 'SKILL.md') -Destination (Join-Path $target 'SOURCE_SKILL.md')
  Copy-Item -LiteralPath (Join-Path $bundleRoot "codex/$($skill.id)/SKILL.md") -Destination (Join-Path $target 'SKILL.md') -Force
  Copy-Item -LiteralPath (Join-Path $bundleRoot 'codex/ccy-integration.md') -Destination (Join-Path $target 'references/ccy-integration.md')
  if ($skill.id -eq 'gpt-image') {
    Copy-Item -LiteralPath (Join-Path $bundleRoot 'modules/image-fidelity.md') -Destination (Join-Path $target 'references/ccy-image-core.md')
    Copy-Item -LiteralPath (Join-Path $bundleRoot 'modules/image-reference.md') -Destination (Join-Path $target 'references/ccy-image-reference.md')
  }
  if ($skill.id -eq 'sd05-fight-director') { Copy-Item -LiteralPath (Join-Path $bundleRoot 'modules/fight.md') -Destination (Join-Path $target 'references/ccy-fight-core.md') }
  "Installed $($skill.id) into $target"
}
