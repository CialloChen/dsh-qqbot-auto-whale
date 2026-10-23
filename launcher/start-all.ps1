#Requires -Version 5.1
<#
.SYNOPSIS
  一键启动：DSH（qqbot profile）+ NapCat。

.DESCRIPTION
  1. 读取 launcher\config.psd1
  2. 若 8643 没在监听，就启动 DSH 宿主（新开一个控制台窗口，日志在那里）
  3. 等 8643 就绪
  4. 若 QQ/NapCat 没在跑，就启动它
  5. 等 NapCat WebUI 端口就绪
  6. 打印状态

.PARAMETER Restart
  先停掉现有的宿主和 NapCat，再重新启动。

.PARAMETER DryRun
  只打印将要做什么，不启动任何进程。

.PARAMETER NoNapCat
  只启动 DSH，不管 NapCat。

.PARAMETER NoPause
  结束后不停顿（供计划任务/脚本调用）。

.EXAMPLE
  .\start-all.ps1

.EXAMPLE
  .\start-all.ps1 -Restart
#>
[CmdletBinding()]
param(
    [switch]$Restart,
    [switch]$DryRun,
    [switch]$NoNapCat,
    [switch]$NoPause
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
$dshPort = 8643
$napCatWebUiPort = 6099

function Step([string]$m) { Write-Host ("» " + $m) -ForegroundColor Cyan }
function Ok([string]$m) { Write-Host ("  [ok] " + $m) -ForegroundColor Green }
function Note([string]$m) { Write-Host ("  [!]  " + $m) -ForegroundColor Yellow }
function Fail([string]$m) { Write-Host ("  [x]  " + $m) -ForegroundColor Red }

function Test-Listening([int]$port) {
    $conn = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
    return ($null -ne $conn)
}

function Get-PortOwner([int]$port) {
    $conn = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -eq $conn) { return 0 }
    return [int]$conn.OwningProcess
}

function Wait-Port([int]$port, [int]$seconds) {
    for ($i = 0; $i -lt $seconds; $i++) {
        if (Test-Listening $port) { return $true }
        Start-Sleep -Seconds 1
    }
    return $false
}

function Find-Dsh([string]$configured) {
    if ($configured -ne '' -and (Test-Path -LiteralPath $configured)) { return $configured }
    $cmd = Get-Command dsh -ErrorAction SilentlyContinue
    if ($null -ne $cmd) { return $cmd.Source }
    $guess = Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd'
    if (Test-Path -LiteralPath $guess) { return $guess }
    return $null
}

function Find-NapCat([string]$configured) {
    if ($configured -ne '' -and (Test-Path -LiteralPath $configured)) { return $configured }
    $candidates = @(
        'C:\DSH_Desktop\NapCat.Shell.Windows.OneKey\NapCat.52230.Shell\napcat.quick.bat',
        (Join-Path $env:USERPROFILE 'Desktop\NapCat.Shell.Windows.OneKey\NapCat.52230.Shell\napcat.quick.bat'),
        'C:\NapCat\napcat.quick.bat'
    )
    foreach ($candidate in $candidates) {
        if (Test-Path -LiteralPath $candidate) { return $candidate }
    }
    $roots = @('C:\DSH_Desktop', (Join-Path $env:USERPROFILE 'Desktop'), (Join-Path $env:USERPROFILE 'Downloads'), 'D:\')
    foreach ($root in $roots) {
        if (-not (Test-Path -LiteralPath $root)) { continue }
        $hit = Get-ChildItem -LiteralPath $root -Filter 'napcat.quick.bat' -Recurse -Depth 3 -File -ErrorAction SilentlyContinue |
            Select-Object -First 1
        if ($null -ne $hit) { return $hit.FullName }
    }
    return $null
}

$configPath = Join-Path $PSScriptRoot 'config.psd1'
$config = @{
    DshPath           = ''
    Profile           = 'qqbot'
    Workspace         = ''
    NapCatLauncher    = ''
    KeyFile           = ''
    HostWaitSeconds   = 60
    NapCatWaitSeconds = 60
}
if (Test-Path -LiteralPath $configPath) {
    $loaded = Import-PowerShellDataFile -LiteralPath $configPath
    foreach ($key in $loaded.Keys) { $config[$key] = $loaded[$key] }
}

$dsh = Find-Dsh $config.DshPath
if ($null -eq $dsh) {
    Fail '找不到 dsh 命令'
    throw '请先安装 DeepSeek Harness，或在 launcher\config.psd1 里填 DshPath。'
}
$profileName = if ($config.Profile -ne '') { $config.Profile } else { 'qqbot' }
$workspace = if ($config.Workspace -ne '') { $config.Workspace } else { Join-Path $env:USERPROFILE 'Documents\dsh-qqbot-workspace' }
$keyFile = if ($config.KeyFile -ne '') { $config.KeyFile } else { Join-Path $env:USERPROFILE '.dsh\qqbot-deepseek.key' }

Write-Host ''
Write-Host '鲸鱼娘启动器' -ForegroundColor White
Write-Host ('profile = ' + $profileName + '   workspace = ' + $workspace)
if ($DryRun) { Write-Host '模式：DryRun（只看不动）' -ForegroundColor Yellow }
Write-Host ''

# 可选：先停
if ($Restart) {
    Step '重启：先停止现有进程'
    if ($DryRun) {
        Note ("将停止 8643 上的进程（如有）和 QQ/NapCat")
    }
    else {
        $owner = Get-PortOwner $dshPort
        if ($owner -ne 0) {
            Stop-Process -Id $owner -Force -ErrorAction SilentlyContinue
            Ok ('已停止宿主 PID ' + $owner)
        }
        else {
            Note '宿主没在跑'
        }
        $qq = Get-Process -Name QQ -ErrorAction SilentlyContinue
        if ($null -ne $qq) {
            $qq | Stop-Process -Force -ErrorAction SilentlyContinue
            Ok '已停止 QQ/NapCat'
        }
        else {
            Note 'NapCat 没在跑'
        }
        Start-Sleep -Seconds 2
    }
}

# 1) DSH 宿主
Step '启动 DSH 宿主'
if (Test-Listening $dshPort) {
    $owner = Get-PortOwner $dshPort
    Ok ('已在运行（PID ' + $owner + '，端口 ' + $dshPort + '）')
}
elseif ($DryRun) {
    Note ('将运行：' + $dsh + ' --profile ' + $profileName + ' --port 0 --no-open')
}
else {
    if (Test-Path -LiteralPath $keyFile) {
        $key = (Get-Content -LiteralPath $keyFile -Raw).Trim()
        if ($key -ne '') {
            $env:DEEPSEEK_QQBOT_API_KEY = $key
            Ok '已加载专用 key'
        }
    }
    else {
        Note ('没有 key 文件（' + $keyFile + '），将使用环境里已有的 DEEPSEEK_QQBOT_API_KEY')
    }
    $env:NODE_OPTIONS = '--use-system-ca'
    if (-not (Test-Path -LiteralPath $workspace)) {
        New-Item -ItemType Directory -Force -Path $workspace | Out-Null
    }
    $hostArgs = @('--profile', $profileName, '--port', '0', '--no-open')
    Start-Process -FilePath $dsh -ArgumentList $hostArgs -WorkingDirectory $workspace -WindowStyle Normal | Out-Null
    if (Wait-Port $dshPort $config.HostWaitSeconds) {
        Ok ('已启动，端口 ' + $dshPort + ' 就绪')
    }
    else {
        Fail ('等 ' + $config.HostWaitSeconds + ' 秒后端口仍未就绪，去看新开的宿主窗口')
    }
}

# 2) NapCat
if ($NoNapCat) {
    Step '跳过 NapCat（-NoNapCat）'
}
else {
    Step '启动 NapCat'
    $qq = Get-Process -Name QQ -ErrorAction SilentlyContinue
    if ($null -ne $qq) {
        Ok ('QQ/NapCat 已在运行（PID ' + ($qq | Select-Object -First 1).Id + '）')
    }
    else {
        $napCat = Find-NapCat $config.NapCatLauncher
        if ($null -eq $napCat) {
            Fail '找不到 napcat.quick.bat'
            Note '请在 launcher\config.psd1 里填 NapCatLauncher'
        }
        elseif ($DryRun) {
            Note ('将运行：' + $napCat)
        }
        else {
            Start-Process -FilePath $napCat -WorkingDirectory (Split-Path -Parent $napCat) -WindowStyle Minimized | Out-Null
            if (Wait-Port $napCatWebUiPort $config.NapCatWaitSeconds) {
                Ok ('已启动，WebUI 端口 ' + $napCatWebUiPort + ' 就绪')
            }
            else {
                Note ('等 ' + $config.NapCatWaitSeconds + ' 秒后 WebUI 端口仍未就绪；可能还在登录/扫码')
            }
        }
    }
}

# 3) 状态
Write-Host ''
Step '状态'
$hostOwner = Get-PortOwner $dshPort
if ($hostOwner -ne 0) { Ok ('宿主   : 运行中（PID ' + $hostOwner + '）') } else { Note '宿主   : 未运行' }
if (Test-Listening $napCatWebUiPort) { Ok ('NapCat : 运行中（WebUI 127.0.0.1:' + $napCatWebUiPort + '）') } else { Note 'NapCat : 未运行' }

Write-Host ''
Write-Host '宿主窗口里的日志出现下面两行，就说明通道通了：' -ForegroundColor DarkGray
Write-Host '  [dsh-onebot] reverse WS server listening on ws://127.0.0.1:8643' -ForegroundColor DarkGray
Write-Host '  [dsh-onebot] OneBot connected' -ForegroundColor DarkGray
Write-Host ''

if (-not $NoPause -and -not $DryRun -and $Host.Name -ne 'ServerRemoteHost') {
    Write-Host '按任意键关闭本窗口（不影响已启动的进程）…' -ForegroundColor DarkGray
    try { $null = $Host.UI.RawUI.ReadKey('NoEcho,IncludeKeyDown') } catch { Start-Sleep -Seconds 5 }
}
