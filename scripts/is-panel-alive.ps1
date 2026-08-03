# Sprawdza, czy panel Scyzoryka juz odpowiada, zanim Uruchom-Scyzoryk.cmd
# zdecyduje, czy uruchomic go na nowo. Audyt v1.0.4, P1-9: pojedyncze
# sprawdzenie z timeoutem 2s moglo dac falszywy negatyw, gdy panel byl zajety
# (np. agreguje health wszystkich 8 podaplikacji), ale wciaz zywy - co
# prowadzilo do niepotrzebnego uruchomienia stop-scyzoryk.ps1 i przerwania
# aktywnej pracy. Powtarzamy sprawdzenie przez co najmniej 12s, zanim uznamy
# panel za martwy.
param(
  [string]$Url = 'http://127.0.0.1:3000',
  [int]$AttemptCount = 6,
  [int]$AttemptTimeoutSec = 2,
  [int]$DelayBetweenMs = 500
)

for ($i = 1; $i -le $AttemptCount; $i++) {
  try {
    $r = Invoke-WebRequest -UseBasicParsing -Uri "$Url/api/health" -TimeoutSec $AttemptTimeoutSec
    if ($r.StatusCode -eq 200) { exit 0 }
  } catch {}
  if ($i -lt $AttemptCount) { Start-Sleep -Milliseconds $DelayBetweenMs }
}
exit 1
