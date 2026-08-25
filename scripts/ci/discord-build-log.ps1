param(
    [Parameter(Mandatory = $true)]
    [string]$Status,

    [string]$Details = ""
)

$webhook = $env:DISCORD_BUILD_WEBHOOK

if ([string]::IsNullOrWhiteSpace($webhook)) {
    Write-Warning "DISCORD_BUILD_WEBHOOK nie jest ustawiony."
    exit 0
}

$runUrl = "$env:GITHUB_SERVER_URL/$env:GITHUB_REPOSITORY/actions/runs/$env:GITHUB_RUN_ID"

$message = @"
$Status

$Details

🔗 $runUrl
"@

$payload = @{
    content = $message
} | ConvertTo-Json -Compress

try {
    Invoke-RestMethod `
        -Uri $webhook `
        -Method Post `
        -ContentType "application/json" `
        -Body $payload | Out-Null
}
catch {
    Write-Warning "Discord notification failed: $($_.Exception.Message)"
}

exit 0