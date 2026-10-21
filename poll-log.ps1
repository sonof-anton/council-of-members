$ErrorActionPreference = 'SilentlyContinue'
$lastSize = 0
for ($i = 0; $i -lt 300; $i++) {
    $f = Get-ChildItem 'C:\Users\rhodd\Projects\council-of-ais\logs\council-*' | Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if ($f -and $f.LastWriteTime -gt (Get-Date).AddMinutes(-5)) {
        $content = Get-Content $f.FullName -Raw
        if ($content.Length -gt $lastSize) {
            $new = $content.Substring($lastSize)
            Write-Host $new -NoNewline
            $lastSize = $content.Length
        }
    }
    Start-Sleep 2
}
