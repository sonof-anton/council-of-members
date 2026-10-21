$f = Get-ChildItem 'C:\Users\rhodd\Projects\council-of-ais\logs\transcript-*' | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if ($f) { Get-Content $f.FullName -Raw }
