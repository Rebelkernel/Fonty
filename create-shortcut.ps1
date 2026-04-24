$ws = New-Object -ComObject WScript.Shell
$lnk = [Environment]::GetFolderPath('Desktop') + '\FONTY.lnk'
$sc = $ws.CreateShortcut($lnk)
$sc.TargetPath = "$env:LOCALAPPDATA\Programs\FONTY\fonty.exe"
$sc.WorkingDirectory = "$env:LOCALAPPDATA\Programs\FONTY"
$sc.IconLocation = "$env:LOCALAPPDATA\Programs\FONTY\icon.ico"
$sc.Description = 'FONTY - local font manager'
$sc.Save()
Write-Host "Shortcut updated: $lnk -> $($sc.TargetPath)"
