#Requires -Version 5.1
<#
.SYNOPSIS
  一键启动：DSH（qqbot profile）+ NapCat。

.DESCRIPTION
  1. 读取 launcher\config.psd1
  2. 若 8643 没在监听，就启动 DSH 宿主（新开控制台窗口）
  3. 等 8643 就绪
  4. 启动 NapCat（识别真正的 NapCat 进程，不会把主 QQ 误当成它）
  5. 等 WebUI 6099 就绪，再等 DSH 侧出现 Established 连接
  6. 打印状态；失败时给出日志尾巴和排查提示

.PARAMETER Restart
  先停掉现有的宿主和所有 QQ 进程，再重新启动。

.PARAMETER KillQQ
  启动 NapCat 前结束**所有** QQ 进程（包括你自己的主 QQ）。
  NapCat 和主 QQ 默认共用 %APPDATA%\QQ，主 QQ 开着时 NapCat 经常起不来。

.PARAMETER DryRun
  只打印将要做什么，不启动任何进程。

.PARAMETER NoNapCat
  只启动 DSH，不管 NapCat。

.PARAMETER NoPause
  结束后不停顿（供计划任务/脚本调用）。

.EXAMPLE
  .\start-all.ps1

.EXAMPLE
  .\start-all.ps1 -KillQQ

.EXAMPLE
  .\start-all.ps1 -Restart
#>
[CmdletBinding()]
param(
    [switch]$Restart,
    [switch]$KillQQ,
    [switch]$DryRun,
    [switch]$NoNapCat,
    [switch]$NoPause
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
$dshPort = 8643
$napCatWebUiPort = 6099
$logDir = $PSScriptRoot
$launcherLog = Join-Path $logDir 'launcher.log'
$napCatLog = Join-Path $logDir 'napcat.log'

function Write-Log([string]$message) {
    try {
        $line = (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + '  ' + $message
        Add-Content -LiteralPath $launcherLog -Value $line -Encoding UTF8
    }
    catch { }
}
function Step([string]$m) { Write-Host ("» " + $m) -ForegroundColor Cyan; Write-Log $m }
function Ok([string]$m) { Write-Host ("  [ok] " + $m) -ForegroundColor Green; Write-Log ('ok: ' + $m) }
function Note([string]$m) { Write-Host ("  [!]  " + $m) -ForegroundColor Yellow; Write-Log ('note: ' + $m) }
function Fail([string]$m) { Write-Host ("  [x]  " + $m) -ForegroundColor Red; Write-Log ('fail: ' + $m) }

function Test-Listening([int]$port) {
    $conn = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
    return ($null -ne $conn)
}
function Test-ChannelConnected([int]$port) {
    $conn = Get-NetTCPConnection -LocalPort $port -State Established -ErrorAction SilentlyContinue
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
function Wait-Connected([int]$port, [int]$seconds) {
    for ($i = 0; $i -lt $seconds; $i++) {
        if (Test-ChannelConnected $port) { return $true }
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
# NapCat 注入的 QQ 进程，命令行里带 NapCat 路径；主 QQ 的没有。
function Get-NapCatProcesses {
    Get-CimInstance Win32_Process -Filter "Name='QQ.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $null -ne $_.CommandLine -and $_.CommandLine -like '*NapCat*' }
}
function Get-MainQqProcesses {
    Get-CimInstance Win32_Process -Filter "Name='QQ.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $null -eq $_.CommandLine -or $_.CommandLine -notlike '*NapCat*' }
}
function Test-NapCatAlive {
    if (Test-Listening $napCatWebUiPort) { return $true }
    return ((Get-NapCatProcesses | Measure-Object).Count -gt 0)
}
function Show-LogTail([string]$path, [int]$lines = 15) {
    if (-not (Test-Path -LiteralPath $path)) { return }
    Write-Host '    ---- 日志末尾 ----' -ForegroundColor DarkGray
    Get-Content -LiteralPath $path -Tail $lines -ErrorAction SilentlyContinue | ForEach-Object {
        Write-Host ('    ' + $_) -ForegroundColor DarkGray
    }
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
Write-Log '---- start-all ----'

# 停：重启 or 强制关 QQ
if ($Restart -or $KillQQ) {
    if ($Restart) { Step '重启：先停止现有进程' } else { Step '-KillQQ：结束所有 QQ 进程' }
    if ($DryRun) {
        Note '将停止宿主（如有）和所有 QQ/NapCat 进程'
    }
    else {
        if ($Restart) {
            $owner = Get-PortOwner $dshPort
            if ($owner -ne 0) {
                Stop-Process -Id $owner -Force -ErrorAction SilentlyContinue
                Ok ('已停止宿主 PID ' + $owner)
            }
            else {
                Note '宿主没在跑'
            }
        }
        $napCatProcs = @(Get-NapCatProcesses)
        if ($napCatProcs.Count -gt 0) {
            $napCatProcs | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
            Ok ('已结束 ' + $napCatProcs.Count + ' 个 NapCat 进程')
        }
        if ($Restart -or $KillQQ) {
            $allQq = @(Get-CimInstance Win32_Process -Filter "Name='QQ.exe'" -ErrorAction SilentlyContinue)
            if ($allQq.Count -gt 0) {
                $allQq | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
                Ok ('已结束 ' + $allQq.Count + ' 个 QQ 进程')
            }
        }
        Start-Sleep -Seconds 3
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

    $napCatAlive = Test-NapCatAlive
    $mainQq = @(Get-MainQqProcesses)

    if ($napCatAlive -and (Test-ChannelConnected $dshPort)) {
        Ok 'NapCat 已在运行，且已连上 DSH'
    }
    elseif ($napCatAlive -and -not (Test-ChannelConnected $dshPort)) {
        # 进程在、WebUI 在、但没连上：可能是没登录或网络配置没启用
        Note 'NapCat 进程已在，但还没连上 DSH（可能未登录/网络配置未启用）'
        if (Wait-Connected $dshPort 20) { Ok '通道已连上' }
        else { Note '20 秒内仍未连上，去 NapCat 窗口看看登录状态' }
    }
    else {
        if ($mainQq.Count -gt 0) {
            Note ('检测到主 QQ 在运行（' + $mainQq.Count + ' 个进程）。NapCat 和主 QQ 默认共用 %APPDATA%\QQ，')
            Note '这经常导致 NapCat 起不来；如果失败，请用 -KillQQ 先关掉主 QQ 再启动。'
        }
        $napCat = Find-NapCat $config.NapCatLauncher
        if ($null -eq $napCat) {
            Fail '找不到 napcat.quick.bat'
            Note '请在 launcher\config.psd1 里填 NapCatLauncher'
        }
        elseif ($DryRun) {
            Note ('将运行：' + $napCat)
        }
        else {
            $napCatDir = Split-Path -Parent $napCat
            $attempt = 0
            $started = $false
            $attemptLog = $napCatLog
            while ($attempt -lt 2 -and -not $started) {
                $attempt += 1
                if ($attempt -gt 1) {
                    Note '第一次没起来，清掉残留进程后重试'
                    @(Get-NapCatProcesses) | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
                    Start-Sleep -Seconds 6
                }
                # 宿主刚监听时事件循环可能还在初始化，先等几秒再让 NapCat 连
                Start-Sleep -Seconds 3
                $attemptLog = Join-Path $logDir ('napcat-' + (Get-Date -Format 'HHmmss') + '-' + $attempt + '.log')
                Write-Log ('launch napcat (attempt ' + $attempt + '): ' + $napCat)
                # cmd /c 重定向，< nul 让批处理末尾的 pause 立即返回，避免窗口一直占着日志
                $cmdLine = '/c ""' + $napCat + '" > "' + $attemptLog + '" 2>&1 < nul"'
                Start-Process -FilePath 'cmd.exe' -ArgumentList $cmdLine -WorkingDirectory $napCatDir -WindowStyle Minimized | Out-Null
                if (Wait-Port $napCatWebUiPort $config.NapCatWaitSeconds) { $started = $true }
            }

            if ($started) {
                Ok ('WebUI 端口 ' + $napCatWebUiPort + ' 就绪')
                if (Wait-Connected $dshPort 45) {
                    Ok '已连上 DSH（OneBot 通道 Established）'
                }
                else {
                    Note 'WebUI 起来了，但还没连上 DSH'
                    Note '可能还在扫码登录，或 NapCat 网络配置里的 WebSocket 客户端没启用'
                    Show-LogTail $attemptLog
                }
            }
            else {
                Fail ('两次尝试后 NapCat WebUI 仍未就绪')
                Show-LogTail $attemptLog
                Write-Host ''
                Note '常见原因：'
                Note '  1) 主 QQ 正开着，和 NapCat 抢 %APPDATA%\QQ  → 用 -KillQQ 重试'
                Note '  2) 上一次的 NapCat 残留进程没退干净     → 用 -Restart 重试'
                Note '  3) 需要扫码登录                        → 手动双击 napcat.quick.bat'
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
if (Test-ChannelConnected $dshPort) { Ok '通道   : 已连接' } else { Note '通道   : 未连接' }

Write-Host ''
Write-Host ('日志：' + $launcherLog) -ForegroundColor DarkGray
Write-Host ('      ' + $logDir + '\napcat-*.log') -ForegroundColor DarkGray
Write-Host ''

if (-not $NoPause -and -not $DryRun -and $Host.Name -ne 'ServerRemoteHost') {
    Write-Host '按任意键关闭本窗口（不影响已启动的进程）…' -ForegroundColor DarkGray
    try { $null = $Host.UI.RawUI.ReadKey('NoEcho,IncludeKeyDown') } catch { Start-Sleep -Seconds 5 }
}
