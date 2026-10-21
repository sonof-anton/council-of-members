$ErrorActionPreference = 'SilentlyContinue'
for ($i = 0; $i -lt 90; $i++) {
    $f = Get-ChildItem 'C:\Users\rhodd\Projects\council-of-ais\logs\transcript-*' | Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if ($f -and $f.LastWriteTime -gt (Get-Date).AddMinutes(-2)) {
        Write-Host "FOUND: $($f.FullName)"
        Start-Sleep 3
        Get-Content $f.FullName
        exit 0
    }
    Start-Sleep 2
}
Write-Host "TIMEOUT waiting for new log"
