#Requires -Version 5.1
<#
.SYNOPSIS
  把 dsh-qqbot-auto-whale 补丁装进 DSH 的 qqbot profile。

.DESCRIPTION
  1. 定位 dsh 命令
  2. 确认 profile 存在
  3. 没装插件就用 dsh plugin add 装 dsh-onebot-qq@0.9.3
  4. 校验插件版本（不符则拒绝）
  5. 备份并覆盖 6 个补丁文件
  6. 复制配置模板（已存在则只提示，不覆盖）

.PARAMETER Profile
  DSH profile 名，默认 qqbot。

.PARAMETER DshHome
  DSH 数据目录，默认 %USERPROFILE%\.dsh。

.PARAMETER TargetVersion
  目标 dsh-onebot-qq 版本，默认 0.9.3。

.PARAMETER DshPath
  dsh.cmd 的完整路径（PATH 里找不到时用）。

.PARAMETER CreateProfile
  profile 不存在时自动创建（写入最小 package.json 并安装依赖）。

.PARAMETER SkipConfig
  不复制配置模板。

.PARAMETER DryRun
  只打印将要执行的操作，不写任何文件。

.PARAMETER Force
  即使版本不匹配也继续（不推荐）。

.EXAMPLE
  .\install.ps1 -Profile qqbot

.EXAMPLE
  .\install.ps1 -Profile qqbot -DryRun
#>
[CmdletBinding()]
param(
    [string]$Profile = 'qqbot',
    [string]$DshHome = '',
    [string]$TargetVersion = '0.9.3',
    [string]$DshPath = '',
    [switch]$CreateProfile,
    [switch]$SkipConfig,
    [switch]$DryRun,
    [switch]$Force
)

$ErrorActionPreference = 'Stop'

$repoRoot = $PSScriptRoot
$patchDir = Join-Path $repoRoot 'patch\lib'
$exampleConfig = Join-Path $repoRoot 'examples\cordis.patch.example.yml'
$patchedFiles = @('tools.js', 'bridge.js', 'inbound.js', 'outbound.js', 'memory.js', 'frames.js')

function Step([string]$Message) { Write-Host ("» " + $Message) -ForegroundColor Cyan }
function Ok([string]$Message) { Write-Host ("  [ok] " + $Message) -ForegroundColor Green }
function Note([string]$Message) { Write-Host ("  [!]  " + $Message) -ForegroundColor Yellow }
function Fail([string]$Message) { Write-Host ("  [x]  " + $Message) -ForegroundColor Red }

if ($DshHome -eq '') {
    $DshHome = Join-Path $env:USERPROFILE '.dsh'
}

Write-Host ''
Write-Host 'dsh-qqbot-auto-whale 安装器' -ForegroundColor White
Write-Host ('profile = ' + $Profile + '   dsh-home = ' + $DshHome)
if ($DryRun) {
    Write-Host '模式：DryRun（只看不动）' -ForegroundColor Yellow
}
Write-Host ''

# ---------------------------------------------------------------- 1. 定位 dsh
Step '定位 dsh 命令'

$dsh = $null
if ($DshPath -ne '') {
    if (Test-Path -LiteralPath $DshPath) {
        $dsh = $DshPath
    }
    else {
        throw ('指定的 dsh 路径不存在：' + $DshPath)
    }
}
if ($null -eq $dsh) {
    $command = Get-Command dsh -ErrorAction SilentlyContinue
    if ($null -ne $command) {
        $dsh = $command.Source
    }
}
if ($null -eq $dsh) {
    $guess = Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd'
    if (Test-Path -LiteralPath $guess) {
        $dsh = $guess
    }
}
if ($null -eq $dsh) {
    Fail '找不到 dsh 命令'
    throw '请先安装 DeepSeek Harness，或用 -DshPath 指定 dsh.cmd 的完整路径。'
}
Ok $dsh

# ------------------------------------------------------------ 2. 检查 profile
Step '检查 profile'

$profileDir = Join-Path $DshHome ('profiles\' + $Profile)
if (-not (Test-Path -LiteralPath $profileDir)) {
    if (-not $CreateProfile) {
        Fail ('profile 不存在：' + $profileDir)
        throw '先按 docs\install.md 第 4 节创建 profile，或加 -CreateProfile 让脚本创建一个。'
    }
    if ($DryRun) {
        Note ('将创建 profile 目录：' + $profileDir)
    }
    else {
        New-Item -ItemType Directory -Force -Path $profileDir | Out-Null
        $profilePackage = [ordered]@{
            name    = 'dsh-profile-' + $Profile
            private = $true
            dsh     = @{
                profile = @{
                    bundles = @('@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-onebot-qq')
                }
            }
        }
        $profilePackage | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $profileDir 'package.json') -Encoding UTF8
        Ok ('已创建 ' + $profileDir)
    }
}
else {
    Ok ('已存在 ' + $profileDir)
}

# ------------------------------------------------------------- 3. 检查插件
Step '检查 dsh-onebot-qq 插件'

$pluginDir = Join-Path $profileDir 'node_modules\dsh-onebot-qq'
$pluginLib = Join-Path $pluginDir 'lib'
$pluginPackage = Join-Path $pluginDir 'package.json'

if (-not (Test-Path -LiteralPath $pluginLib)) {
    if ($DryRun) {
        Note ('插件未安装；实际执行时会运行：dsh plugin --profile ' + $Profile + ' add dsh-onebot-qq@' + $TargetVersion)
    }
    else {
        Note '插件未安装，开始安装（首次需要联网）…'
        & $dsh plugin --profile $Profile add ('dsh-onebot-qq@' + $TargetVersion)
        if (-not (Test-Path -LiteralPath $pluginLib)) {
            throw '插件安装后仍找不到 lib 目录，安装可能失败。'
        }
        Ok '插件已安装'
    }
}
else {
    Ok ('已安装 ' + $pluginDir)
}

# --------------------------------------------------------------- 4. 校验版本
if (Test-Path -LiteralPath $pluginPackage) {
    Step '校验插件版本'
    $installed = (Get-Content -LiteralPath $pluginPackage -Raw | ConvertFrom-Json).version
    if ($installed -eq $TargetVersion) {
        Ok ('版本 ' + $installed)
    }
    elseif ($Force) {
        Note ('版本 ' + $installed + ' 与目标 ' + $TargetVersion + ' 不一致，-Force 已跳过校验（可能有兼容问题）')
    }
    else {
        Fail ('版本 ' + $installed + ' 与目标 ' + $TargetVersion + ' 不一致')
        throw '补丁是按 ' + $TargetVersion + ' 的接口写的。请安装对应版本，或用 -Force 强制继续。'
    }
}

# ------------------------------------------------------------ 5. 覆盖补丁
Step '安装补丁文件'

foreach ($name in $patchedFiles) {
    if (-not (Test-Path -LiteralPath (Join-Path $patchDir $name))) {
        throw ('补丁文件缺失：' + (Join-Path $patchDir $name))
    }
}

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$copied = 0

foreach ($name in $patchedFiles) {
    $source = Join-Path $patchDir $name
    $destination = Join-Path $pluginLib $name

    if (-not (Test-Path -LiteralPath $pluginLib)) {
        if ($DryRun) {
            Note ('将写入 ' + $destination)
            continue
        }
        throw ('找不到插件 lib 目录：' + $pluginLib)
    }

    if ($DryRun) {
        if (Test-Path -LiteralPath $destination) {
            Note ('将备份并覆盖 ' + $name)
        }
        else {
            Note ('将新增 ' + $name)
        }
        $copied += 1
        continue
    }

    if (Test-Path -LiteralPath $destination) {
        Copy-Item -LiteralPath $destination -Destination ($destination + '.bak-' + $stamp) -Force
    }
    Copy-Item -LiteralPath $source -Destination $destination -Force
    Ok $name
    $copied += 1
}

if (-not $DryRun) {
    Write-Host ('  共处理 ' + $copied + ' 个文件，备份后缀 .bak-' + $stamp)
}

# ------------------------------------------------------------ 6. 配置模板
if ($SkipConfig) {
    Step '跳过配置模板（-SkipConfig）'
}
else {
    Step '配置模板'
    $profileConfig = Join-Path $profileDir 'cordis.patch.yml'
    if (Test-Path -LiteralPath $profileConfig) {
        Note 'profile 已有 cordis.patch.yml，未覆盖'
        Note ('对照模板手动合并：' + $exampleConfig)
    }
    elseif ($DryRun) {
        Note ('将复制模板到 ' + $profileConfig)
    }
    else {
        Copy-Item -LiteralPath $exampleConfig -Destination $profileConfig -Force
        Ok '已放好模板，记着改里面的 REPLACE_WITH_* 占位符'
    }
}

# ---------------------------------------------------------------- 7. 收尾
Write-Host ''
if ($DryRun) {
    Write-Host 'DryRun 结束，没有修改任何文件。' -ForegroundColor Yellow
}
else {
    Write-Host '安装完成。' -ForegroundColor Green
}
Write-Host ''
Write-Host '下一步：'
Write-Host '  1) 编辑 profile 的 cordis.patch.yml，替换 REPLACE_WITH_* 占位符'
Write-Host '  2) （可选）把 ffmpeg.exe / ffprobe.exe 放到 <DSH_HOME>\tools\ffmpeg\bin\'
Write-Host ('  3) 启动： dsh --profile ' + $Profile + ' --port 0 --no-open')
Write-Host '  详细步骤见 docs\install.md'
Write-Host ''
