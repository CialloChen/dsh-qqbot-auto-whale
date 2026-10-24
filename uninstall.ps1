#Requires -Version 5.1
<#
.SYNOPSIS
  还原 install.ps1 覆盖过的补丁文件。

.DESCRIPTION
  每个补丁文件都留了 backups：<文件名>.bak-<时间戳>。
  本脚本按文件取**最新**的那份备份还原；没有备份的文件保持原样。
  不会动 cordis.patch.yml，也不会删除 whale-memory 数据。

.EXAMPLE
  .\uninstall.ps1 -Profile qqbot

.EXAMPLE
  .\uninstall.ps1 -Profile qqbot -DryRun
#>
[CmdletBinding()]
param(
    [string]$Profile = 'qqbot',
    [string]$DshHome = '',
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

$patchedFiles = @('tools.js', 'bridge.js', 'inbound.js', 'outbound.js', 'connection.js', 'index.js', 'memory.js', 'frames.js')

function Step([string]$Message) { Write-Host ("» " + $Message) -ForegroundColor Cyan }
function Ok([string]$Message) { Write-Host ("  [ok] " + $Message) -ForegroundColor Green }
function Note([string]$Message) { Write-Host ("  [!]  " + $Message) -ForegroundColor Yellow }
function Fail([string]$Message) { Write-Host ("  [x]  " + $Message) -ForegroundColor Red }

if ($DshHome -eq '') {
    $DshHome = Join-Path $env:USERPROFILE '.dsh'
}

$pluginDir = Join-Path $DshHome ('profiles\' + $Profile + '\node_modules\dsh-onebot-qq')
$pluginLib = Join-Path $pluginDir 'lib'

Write-Host ''
Write-Host 'dsh-qqbot-auto-whale 卸载器' -ForegroundColor White
Write-Host ('profile = ' + $Profile + '   dsh-home = ' + $DshHome)
if ($DryRun) {
    Write-Host '模式：DryRun（只看不动）' -ForegroundColor Yellow
}
Write-Host ''

Step '检查插件目录'
if (-not (Test-Path -LiteralPath $pluginLib)) {
    Fail ('找不到插件 lib 目录：' + $pluginLib)
    throw '请确认 profile 名是否正确。'
}
Ok $pluginLib

Step '还原补丁文件'
$restored = 0
$missing = @()

foreach ($name in $patchedFiles) {
    $destination = Join-Path $pluginLib $name
    $backups = @(Get-ChildItem -LiteralPath $pluginLib -Filter ($name + '.bak-*') -File -ErrorAction SilentlyContinue |
            Sort-Object LastWriteTime -Descending)

    if ($backups.Count -eq 0) {
        $missing += $name
        continue
    }

    $backup = $backups[0]
    if ($DryRun) {
        Note ('将还原 ' + $name + ' ← ' + $backup.Name)
    }
    else {
        Copy-Item -LiteralPath $backup.FullName -Destination $destination -Force
        Ok ($name + ' ← ' + $backup.Name)
    }
    $restored += 1
}

Write-Host ''
if ($missing.Count -gt 0) {
    Note ('这些文件没有备份，未处理：' + ($missing -join ', '))
    Note '如果它们是新增文件（memory.js / frames.js），可以手动删除；没有备份说明不是本脚本装的。'
}

if ($DryRun) {
    Write-Host ('DryRun 结束：将还原 ' + $restored + ' 个文件。') -ForegroundColor Yellow
}
else {
    Write-Host ('已还原 ' + $restored + ' 个文件。') -ForegroundColor Green
}
Write-Host '配置（cordis.patch.yml）和 whale-memory 数据未改动。'
Write-Host ''
