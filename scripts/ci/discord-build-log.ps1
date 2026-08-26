param(
    [Parameter(Mandatory = $true)]
    [string]$Status,

    [string]$Details = "",

    [ValidateSet("none", "action", "release")]
    [string]$LinkType = "none"
)

$webhook = $env:DISCORD_BUILD_WEBHOOK

if ([string]::IsNullOrWhiteSpace($webhook)) {
    Write-Warning "DISCORD_BUILD_WEBHOOK nie jest ustawiony."
    exit 0
}

$message = $Status

if (-not [string]::IsNullOrWhiteSpace($Details)) {
    $message += "`n`n$Details"
}

switch ($LinkType) {
    "action" {
        $url = "$env:GITHUB_SERVER_URL/$env:GITHUB_REPOSITORY/actions/runs/$env:GITHUB_RUN_ID"
        $message += "`n`nGitHub Actions: $url"
    }

    "release" {
        if (-not [string]::IsNullOrWhiteSpace($env:RELEASE_TAG)) {
            $url = "$env:GITHUB_SERVER_URL/$env:GITHUB_REPOSITORY/releases/tag/$env:RELEASE_TAG"
            $message += "`n`nGitHub Release: $url"
        }
    }
}

$payload = @{
    content = $message
} | ConvertTo-Json -Compress

try {
    Invoke-RestMethod `
        -Uri $webhook `
        -Method Post `
        -ContentType "application/json" `
        -Body $payload |
        Out-Null
}
catch {
    # Discord notification must never break the actual release.
    Write-Warning "Discord notification failed: $($_.Exception.Message)"
}

exit 0
