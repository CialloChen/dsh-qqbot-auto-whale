#Requires -Version 5.1
<#
.SYNOPSIS
  看一眼当前状态：宿主、NapCat、端口、最近一次发送审计。
#>
[CmdletBinding()]
param(
    [switch]$NoPause
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
$dshPort = 8643
$napCatWebUiPort = 6099
$dshHome = Join-Path $env:USERPROFILE '.dsh'

function Ok([string]$m) { Write-Host ("  [ok] " + $m) -ForegroundColor Green }
function Note([string]$m) { Write-Host ("  [!]  " + $m) -ForegroundColor Yellow }
function Row([string]$k, [string]$v) { Write-Host ("  " + $k.PadRight(10) + $v) }

Write-Host ''
Write-Host '鲸鱼娘启动器 · 状态' -ForegroundColor White
Write-Host ''

$conn = Get-NetTCPConnection -LocalPort $dshPort -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($null -ne $conn) {
    $proc = Get-Process -Id ([int]$conn.OwningProcess) -ErrorAction SilentlyContinue
    Ok 'DSH 宿主运行中'
    Row '端口' ($dshPort.ToString() + ' (PID ' + $conn.OwningProcess + ', ' + $proc.ProcessName + ')')
}
else {
    Note 'DSH 宿主未运行'
}

$webui = Get-NetTCPConnection -LocalPort $napCatWebUiPort -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($null -ne $webui) {
    Ok 'NapCat 运行中'
    Row 'WebUI' ('http://127.0.0.1:' + $napCatWebUiPort + '/webui')
}
else {
    Note 'NapCat 未运行'
}

$qq = Get-Process -Name QQ -ErrorAction SilentlyContinue
Row 'QQ 进程' $(if ($null -ne $qq) { ($qq | Measure-Object).Count.ToString() + ' 个' } else { '无' })

$actions = Join-Path $dshHome 'media\onebot\qq-actions.log'
if (Test-Path -LiteralPath $actions) {
    $info = Get-Item -LiteralPath $actions
    Row '最近发送' ($info.LastWriteTime.ToString('yyyy-MM-dd HH:mm:ss') + '（' + [math]::Round($info.Length / 1KB, 1) + ' KB）')
}
else {
    Row '最近发送' '还没有 qq-actions.log'
}

$sessionsRoot = Join-Path $dshHome 'sessions'
if (Test-Path -LiteralPath $sessionsRoot) {
    $sessionDirs = Get-ChildItem -LiteralPath $sessionsRoot -Directory -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -like '*dsh-qqbot-workspace*' }
    $count = 0
    foreach ($dir in $sessionDirs) {
        $count += (Get-ChildItem -LiteralPath $dir.FullName -Directory -ErrorAction SilentlyContinue | Measure-Object).Count
    }
    Row '会话目录' ($count.ToString() + ' 个')
}

Write-Host ''
if (-not $NoPause -and $Host.Name -ne 'ServerRemoteHost') {
    Write-Host '按任意键关闭…' -ForegroundColor DarkGray
    try { $null = $Host.UI.RawUI.ReadKey('NoEcho,IncludeKeyDown') } catch { Start-Sleep -Seconds 5 }
}
