$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
$answer = [System.Windows.Forms.MessageBox]::Show('Uninstall AuraBrowser? Your local browsing data and profile settings will be kept.', 'Uninstall AuraBrowser', 'YesNo', 'Question')
if ($answer -ne [System.Windows.Forms.DialogResult]::Yes) { exit 0 }
$installDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$startMenu = Join-Path ([Environment]::GetFolderPath('Programs')) 'AuraBrowser'
$desktopShortcut = Join-Path ([Environment]::GetFolderPath('DesktopDirectory')) 'AuraBrowser.lnk'
Get-Process -Name 'AuraBrowser' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $desktopShortcut -Force -ErrorAction SilentlyContinue
if (Test-Path -LiteralPath $startMenu) { Remove-Item -LiteralPath $startMenu -Recurse -Force -ErrorAction SilentlyContinue }
Remove-Item -LiteralPath ('HKCU:' + [char]92 + 'Software' + [char]92 + 'Microsoft' + [char]92 + 'Windows' + [char]92 + 'CurrentVersion' + [char]92 + 'Uninstall' + [char]92 + 'AuraBrowser') -Recurse -Force -ErrorAction SilentlyContinue
$scriptPath = $MyInvocation.MyCommand.Path
Start-Sleep -Milliseconds 500
Remove-Item -LiteralPath $installDir -Recurse -Force -ErrorAction SilentlyContinue
