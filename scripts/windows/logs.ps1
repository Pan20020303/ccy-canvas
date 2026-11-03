# Tail backend log (or pg with -Pg switch).
param([switch]$Pg)

$root = (Resolve-Path "$PSScriptRoot\..\..").Path
if ($Pg) {
  docker logs -f ccy-canvas-postgres
} else {
  Get-Content "$root\run\api.log" -Tail 50 -Wait
}
