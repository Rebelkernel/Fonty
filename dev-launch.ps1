# Refresh the desktop shortcut to point at the freshly-built exe and
# relaunch it. Called from the assistant's workflow after every build so
# the PowerShell command passed through the permission prompt stays short.
$ErrorActionPreference = 'Stop'
$exe = 'C:\Users\Adria\Desktop\FONTY\src-tauri\target\release\fonty.exe'
$work = Split-Path $exe
$icon = 'C:\Users\Adria\Desktop\FONTY\src-tauri\icons\icon.ico'
$lnk = [Environment]::GetFolderPath('Desktop') + '\FONTY.lnk'
if (Test-Path $lnk) { Remove-Item $lnk -Force }
$ws = New-Object -ComObject WScript.Shell
$sc = $ws.CreateShortcut($lnk)
$sc.TargetPath = $exe
$sc.WorkingDirectory = $work
$sc.IconLocation = $icon
$sc.Description = 'FONTY'
$sc.Save()
Get-Process -Name 'fonty' -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Milliseconds 300
Start-Process -FilePath $exe -WorkingDirectory $work
Start-Sleep -Milliseconds 1000
$p = Get-Process -Name 'fonty' -ErrorAction SilentlyContinue
if ($p) {
    $built = (Get-Item $exe).LastWriteTime
    Write-Output "Relaunched PID $($p.Id) (built $built)"
} else {
    Write-Output 'FAILED to launch'
}
