$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
$defaultInstall = Join-Path (Join-Path $env:LOCALAPPDATA 'Programs') 'AuraBrowser'
New-Item -ItemType Directory -Path $defaultInstall -Force | Out-Null
$picker = New-Object System.Windows.Forms.FolderBrowserDialog
$picker.Description = 'Choose a parent folder. AuraBrowser will be installed in an AuraBrowser subfolder.'
$picker.SelectedPath = Join-Path $env:LOCALAPPDATA 'Programs'
$picker.ShowNewFolderButton = $true
if ($picker.ShowDialog() -ne [System.Windows.Forms.DialogResult]::OK) { exit 0 }
$installParent = [System.IO.Path]::GetFullPath($picker.SelectedPath)
$installDir = Join-Path $installParent 'AuraBrowser'
if ((Test-Path -LiteralPath $installDir) -and -not (Test-Path -LiteralPath (Join-Path $installDir 'AuraBrowser.exe'))) { throw 'The selected location already contains a different AuraBrowser folder.' }
$archive = Join-Path $PSScriptRoot 'AuraBrowser-Portable.zip'
if (-not (Test-Path -LiteralPath $archive)) { $archive = Join-Path $PSScriptRoot 'AuraBrowser-Windows-x64-portable-clean.zip' }
$extractDir = Join-Path ([System.IO.Path]::GetTempPath()) ('AuraBrowser-Setup-' + [guid]::NewGuid().ToString('N'))
try {
  Expand-Archive -LiteralPath $archive -DestinationPath $extractDir -Force
  $sourceDir = Join-Path $extractDir 'AuraBrowser-Windows-x64-portable'
  $browserExe = Join-Path $sourceDir 'AuraBrowser.exe'
  if (-not (Test-Path -LiteralPath $browserExe)) { throw 'The AuraBrowser package is incomplete.' }
  New-Item -ItemType Directory -Path $installDir -Force | Out-Null
  Copy-Item -Path (Join-Path $sourceDir '*') -Destination $installDir -Recurse -Force
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'Uninstall-AuraBrowser.ps1') -Destination (Join-Path $installDir 'Uninstall-AuraBrowser.ps1') -Force
  $exePath = Join-Path $installDir 'AuraBrowser.exe'
  $shell = New-Object -ComObject WScript.Shell
  $startMenu = Join-Path ([Environment]::GetFolderPath('Programs')) 'AuraBrowser'
  New-Item -ItemType Directory -Path $startMenu -Force | Out-Null
  foreach ($shortcutPath in @((Join-Path ([Environment]::GetFolderPath('DesktopDirectory')) 'AuraBrowser.lnk'), (Join-Path $startMenu 'AuraBrowser.lnk'))) {
    $shortcut = $shell.CreateShortcut($shortcutPath)
    $shortcut.TargetPath = $exePath
    $shortcut.WorkingDirectory = $installDir
    $shortcut.IconLocation = $exePath + ',0'
    $shortcut.Save()
  }
  $uninstallShortcut = $shell.CreateShortcut((Join-Path $startMenu 'Uninstall AuraBrowser.lnk'))
  $uninstallShortcut.TargetPath = Join-Path $env:SystemRoot ('System32' + [char]92 + 'WindowsPowerShell' + [char]92 + 'v1.0' + [char]92 + 'powershell.exe')
  $uninstallShortcut.Arguments = '-NoProfile -ExecutionPolicy Bypass -File "' + (Join-Path $installDir 'Uninstall-AuraBrowser.ps1') + '"'
  $uninstallShortcut.WorkingDirectory = $installDir
  $uninstallShortcut.Save()
  $uninstallKey = 'HKCU:' + [char]92 + 'Software' + [char]92 + 'Microsoft' + [char]92 + 'Windows' + [char]92 + 'CurrentVersion' + [char]92 + 'Uninstall' + [char]92 + 'AuraBrowser'
  New-Item -Path $uninstallKey -Force | Out-Null
  New-ItemProperty -Path $uninstallKey -Name DisplayName -Value 'AuraBrowser' -PropertyType String -Force | Out-Null
  New-ItemProperty -Path $uninstallKey -Name DisplayVersion -Value '0.3.1' -PropertyType String -Force | Out-Null
  New-ItemProperty -Path $uninstallKey -Name InstallLocation -Value $installDir -PropertyType String -Force | Out-Null
  New-ItemProperty -Path $uninstallKey -Name UninstallString -Value ('powershell.exe -NoProfile -ExecutionPolicy Bypass -File "' + (Join-Path $installDir 'Uninstall-AuraBrowser.ps1') + '"') -PropertyType String -Force | Out-Null
  [System.Windows.Forms.MessageBox]::Show('AuraBrowser was installed. Its first launch opens the one-time setup page.', 'AuraBrowser setup', 'OK', 'Information') | Out-Null
  Start-Process -FilePath $exePath -WorkingDirectory $installDir
} catch {
  [System.Windows.Forms.MessageBox]::Show($_.Exception.Message, 'AuraBrowser installation failed', 'OK', 'Error') | Out-Null
  exit 1
} finally {
  if (Test-Path -LiteralPath $extractDir) { Remove-Item -LiteralPath $extractDir -Recurse -Force -ErrorAction SilentlyContinue }
}
