#Requires -Version 5.1
<#
.SYNOPSIS
  一键停止：DSH 宿主 + NapCat。

.DESCRIPTION
  按端口 8643 找到宿主进程并结束；再结束 QQ 进程（NapCat 注入在 QQ 里）。
  不会删除任何配置或数据。

.EXAMPLE
  .\stop-all.ps1

.EXAMPLE
  .\stop-all.ps1 -DryRun
#>
[CmdletBinding()]
param(
    [switch]$DryRun,
    [switch]$KeepNapCat,
    [switch]$NoPause
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
$dshPort = 8643

function Step([string]$m) { Write-Host ("» " + $m) -ForegroundColor Cyan }
function Ok([string]$m) { Write-Host ("  [ok] " + $m) -ForegroundColor Green }
function Note([string]$m) { Write-Host ("  [!]  " + $m) -ForegroundColor Yellow }

Write-Host ''
Write-Host '鲸鱼娘启动器 · 停止' -ForegroundColor White
if ($DryRun) { Write-Host '模式：DryRun（只看不动）' -ForegroundColor Yellow }
Write-Host ''

Step '停止 DSH 宿主'
$conn = Get-NetTCPConnection -LocalPort $dshPort -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($null -ne $conn) {
    $owner = [int]$conn.OwningProcess
    if ($DryRun) {
        Note ('将结束 PID ' + $owner)
    }
    else {
        Stop-Process -Id $owner -Force -ErrorAction SilentlyContinue
        Ok ('已结束 PID ' + $owner)
    }
}
else {
    Note '宿主没在跑'
}

if ($KeepNapCat) {
    Step '保留 NapCat（-KeepNapCat）'
}
else {
    Step '停止 NapCat（QQ）'
    $qq = Get-Process -Name QQ -ErrorAction SilentlyContinue
    if ($null -eq $qq) {
        Note 'NapCat 没在跑'
    }
    elseif ($DryRun) {
        Note ('将结束 ' + $qq.Count + ' 个 QQ 进程')
    }
    else {
        $qq | Stop-Process -Force -ErrorAction SilentlyContinue
        Ok ('已结束 ' + $qq.Count + ' 个 QQ 进程')
    }
}

Write-Host ''
Write-Host '完成。' -ForegroundColor Green
Write-Host ''

if (-not $NoPause -and -not $DryRun -and $Host.Name -ne 'ServerRemoteHost') {
    Write-Host '按任意键关闭…' -ForegroundColor DarkGray
    try { $null = $Host.UI.RawUI.ReadKey('NoEcho,IncludeKeyDown') } catch { Start-Sleep -Seconds 5 }
}
