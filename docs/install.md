# 安装指南：Windows 上从零跑起 QQ 群机器人

> 适用于 [dsh-qqbot-auto-whale](https://github.com/CialloChen/dsh-qqbot-auto-whale)：`dsh-onebot-qq` 0.9.3 的补丁。
> 全程只需要：Windows 10/11、能上网、一个**小号 QQ**、一个 DeepSeek API key。
> 不需要显卡，不需要 Docker，不需要编译。

---

## 0. 先搞清楚架构

```
QQ 用户
   │  QQ 协议（非官方）
   ▼
NapCat（协议端，本质是注入的 QQ 客户端）
   │  OneBot 11 / 反向 WebSocket
   ▼
DSH（DeepSeek Harness，Node 宿主）
   │
   ├─ dsh-onebot-qq 插件（收发消息、工具、人格）
   ├─ deepseek-flash（云端 API，本地不推理）
   └─ 本地文件：media/ sessions/ whale-memory/
```

要点：

- **NapCat 是主动连上来的那一端**。DSH 里配的是「反向 WS 服务端」，NapCat 里配的是「WebSocket 客户端」。方向反了就连不上。
- **模型在云端**，本地只负责收消息、调工具、发消息。所以 4G 内存的老机器也能跑。
- **一个 robot 账号 = 一个 QQ 号**。这个号会被 NapCat 接管，你用手机 QQ 再登同一个号会把它顶下线。

---

## 1. 安装 QQ NT

NapCat 依赖 QQ 的 NT 版客户端文件。

1. 打开 <https://im.qq.com/>，下载 **Windows 版 QQ**（NT 架构，2023 之后的版本）。
2. 正常安装，**装完先别登录**。

> 如果你电脑上已经有 QQ 并且正在登主号：可以保留，NapCat 会用独立数据目录跑小号。但如果两个客户端抢同一个安装目录，可能出现互相踢线，见第 16 节。

---

## 2. 安装 DeepSeek Harness

1. 从官方渠道下载 `DeepSeek Harness` 安装包并安装（默认装到
   `%LOCALAPPDATA%\Programs\DeepSeek Harness`）。
2. 安装完成后，命令行工具在：
   ```
   %LOCALAPPDATA%\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd
   ```
   它**不一定会自动进 PATH**。后面所有 `dsh` 命令，如果提示找不到，就换成这个完整路径。
3. 验证（顺便把命令存进变量，后面都用 `$dsh`）：
   ```powershell
   $dsh = "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd"
   & $dsh --version
   ```
   能打印版本号（例如 `0.2.1-rc.2`）就 OK。如果这个路径不对，用
   `Get-ChildItem "$env:LOCALAPPDATA\Programs" -Recurse -Filter dsh.cmd` 找一下。

> 版本要求：本补丁按 **0.2.1-rc.x** 测试。0.3.x 之后插件 API 可能变化，装之前先确认。

---

## 3. 准备 API key

1. 去 DeepSeek 开放平台创建 API key。
2. 建议给机器人**单独一个 key**，方便限额和吊销。
3. 二选一存放：

   **方式 A（推荐，环境变量）**——写进启动脚本，见第 9 节：
   ```powershell
   $env:DEEPSEEK_QQBOT_API_KEY = 'sk-你的key'
   ```

   **方式 B（本地文件）**——新建 `%USERPROFILE%\.dsh\qqbot-deepseek.key`，
   文件里只放一行 key（不要引号、不要空格），启动脚本会自动读：
   ```powershell
   Set-Content "$env:USERPROFILE\.dsh\qqbot-deepseek.key" 'sk-你的key' -NoNewline
   ```

配置里写的是 `apiKeyEnv: DEEPSEEK_QQBOT_API_KEY`，所以变量名必须是这个。

---

## 4. 创建 profile

DSH 的「profile」就是一套独立的插件栈 + 配置，默认放在
`%USERPROFILE%\.dsh\profiles\<名字>\`。

### 4.1 推荐方式（用官方模板创建）

```powershell
$dsh = "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd"
& $dsh qqbot --from-default-profile web
```

- 这会从 `web` 模板复制出一个叫 `qqbot` 的 profile 并立即启动。
- 看到 Web UI 地址后按 **Ctrl+C** 退出即可（我们只是要目录）。
- 如果命令报错（旧版本没有 `--from-default-profile`），走 4.2。

### 4.2 手工方式（兜底，最可控）

```powershell
New-Item -ItemType Directory -Force "$env:USERPROFILE\.dsh\profiles\qqbot" | Out-Null
```

在该目录新建 `package.json`，内容**必须**包含这三个 bundle：

```json
{
  "name": "dsh-profile-qqbot",
  "private": true,
  "dependencies": {
    "dsh-onebot-qq": "0.9.3"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "dsh-onebot-qq"
      ]
    }
  }
}
```

然后安装依赖：

```powershell
& $dsh plugin --profile qqbot install
```

> `dsh plugin --profile qqbot <参数>` 等价于在 profile 目录里跑 pnpm。
> 也可以用 `& $dsh plugin --profile qqbot add dsh-onebot-qq@0.9.3`。

### 4.3 验证 profile 能组装

```powershell
& $dsh --profile qqbot --dump-config | Select-String "dsh-onebot"
```

能看到 `dsh-onebot` 条目就说明 bundle 链没问题。

---

## 5. 安装插件

### 5.1 用原版

```powershell
& $dsh plugin --profile qqbot add dsh-onebot-qq@0.9.3
```

### 5.2 用本仓库的补丁（动图/视频/记忆）

```powershell
git clone https://github.com/CialloChen/dsh-qqbot-auto-whale.git
cd dsh-qqbot-auto-whale
.\install.ps1 -Profile qqbot
```

先看它要做什么（不写任何文件）：

```powershell
.\install.ps1 -Profile qqbot -DryRun
```

脚本会：定位 `dsh` → 没装插件就装 `dsh-onebot-qq@0.9.3` → 校验版本 → 备份并覆盖 6 个文件 → 放配置模板（已存在则不覆盖）。

> 注意：`pnpm install` / `dsh plugin add` 会重置 `node_modules`，所以每次重装插件后都要重新跑一次 `install.ps1`。

---

## 6. 写配置

在 profile 目录新建 `cordis.patch.yml`（就是把仓库里的 `examples\cordis.patch.example.yml` 改名并填值）：

```powershell
Copy-Item '.\examples\cordis.patch.example.yml' "$env:USERPROFILE\.dsh\profiles\qqbot\cordis.patch.yml"
```

然后替换这些占位符：

| 占位符 | 换成 | 说明 |
|---|---|---|
| `REPLACE_WITH_ONEBOT_ACCESS_TOKEN` | 自己生成的一串随机字符 | NapCat 和 DSH 必须完全一致 |
| `REPLACE_WITH_BOT_QQ` | 小号 QQ 号 | 机器人自己 |
| `REPLACE_WITH_GROUP_ID` | 群号 | 允许服务的群 |
| `REPLACE_WITH_OWNER_QQ` | 你自己的 QQ | 只有这个号会被叫「主人」，也是唯一能私聊的 |
| `C:\path\to\dsh-qqbot-workspace` | 一个空目录 | 建议 `%USERPROFILE%\Documents\dsh-qqbot-workspace` |
| `<DSH_HOME>`（persona 里） | `%USERPROFILE%\.dsh` | 一般不用改 |

生成一个随机 token：

```powershell
-join ((48..57) + (97..102) | Get-Random -Count 32 | ForEach-Object { [char]$_ })
```

关键字段说明：

| 字段 | 建议值 | 作用 |
|---|---|---|
| `mode` | `reverse` | DSH 当服务端 |
| `host` / `port` | `127.0.0.1` / `8643` | 只监听本机 |
| `requireMention` | `false` | 群消息全进模型，靠人格规则决定回不回 |
| `groupPolicy` | `allowlist` | 只服务指定群 |
| `dmPolicy` | `allowlist` | 只服务指定私聊 |
| `rateLimitPerMinute` | `8` | 入站限流，防止刷屏 |
| `actionRatePerMinute` | `5` | 主动发送接口的频率上限 |
| `sttEnabled` | `false` | 语音转文字（要额外配置才开） |
| `agentPreset` | `qq-readonly` | 使用配置里定义的只读 preset |
| `adminUsers` | `[]` | 只有这里的人能用 `/new` 等命令 |

> 人格（persona）在 `cordis.patch.yml` 里，改完必须**开新会话**才生效（见第 13 节）。

---

## 7. 可选：安装 ffmpeg（动图/视频抽帧）

不装也能跑，但动图只能看首帧、视频读不了。

插件查找顺序：

1. 环境变量 `DSH_QQBOT_FFMPEG`
2. `<DSH_HOME>\tools\ffmpeg\bin\ffmpeg.exe`
3. PATH 里的 `ffmpeg`

推荐放第 2 个位置：

```powershell
New-Item -ItemType Directory -Force "$env:USERPROFILE\.dsh\tools\ffmpeg\bin" | Out-Null
# 把 ffmpeg.exe 和 ffprobe.exe 复制进去
```

获取方式任选：

- 官网/镜像下载 Windows 静态版（解压后取 `bin\ffmpeg.exe`、`bin\ffprobe.exe`）
- npm 包里带的二进制：
  ```powershell
  # 以 @ffmpeg-installer/win32-x64 为例，下载 tgz 后解压出 ffmpeg.exe
  ```

验证：

```powershell
& "$env:USERPROFILE\.dsh\tools\ffmpeg\bin\ffmpeg.exe" -version
& "$env:USERPROFILE\.dsh\tools\ffmpeg\bin\ffprobe.exe" -version
```

---

## 8. 可选：表情包

`qq_send_sticker` 从下面这些目录找图（png/jpg/gif/webp）：

```
<DSH_HOME>\media\onebot\stickers\feiyu\
<DSH_HOME>\media\onebot\stickers\phoebe\
<DSH_HOME>\media\onebot\whale-memory\memes\   ← 她自己收藏的（pack=whale）
```

```powershell
New-Item -ItemType Directory -Force "$env:USERPROFILE\.dsh\media\onebot\stickers\feiyu" | Out-Null
New-Item -ItemType Directory -Force "$env:USERPROFILE\.dsh\media\onebot\stickers\phoebe" | Out-Null
# 然后把图片丢进去
```

目录为空时她发不出表情包，工具会报「没有可用表情包」，不影响文字聊天。

`whale-memory` 不用手动建，第一次用到会自动创建。

---

## 9. 启动 DSH

### 9.1 命令行启动

```powershell
$dsh = "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd"
$env:DEEPSEEK_QQBOT_API_KEY = 'sk-你的key'
New-Item -ItemType Directory -Force 'C:\path\to\dsh-qqbot-workspace' | Out-Null
Set-Location 'C:\path\to\dsh-qqbot-workspace'
& $dsh --profile qqbot --port 0 --no-open
```

- `--port 0`：Web UI 用随机端口（不影响 QQ 通道）
- `--no-open`：不自动开浏览器
- 这个窗口**必须一直开着**，关掉机器人就下线

启动成功的标志：

```
[dsh-onebot] mounted (mode=reverse, media=..., admins=0)
[dsh-onebot] reverse WS server listening on ws://127.0.0.1:8643 (path /ws or /)
[dsh-onebot] bridge ready (0 resumed chat(s))
```

### 9.2 用启动脚本（推荐）

包里带了 `scripts\start-qqbot.example.ps1`，复制出来改路径后：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File D:\qqbot\start-qqbot.ps1
```

脚本已经处理了三件事：加载 key、关 QuickEdit、检查 8643 是否被占用。

### 9.3 开机自启

任务计划程序 → 创建任务 → 触发器「登录时」→ 操作：

```
程序：powershell.exe
参数：-NoProfile -ExecutionPolicy Bypass -File "D:\qqbot\start-qqbot.ps1"
```

### 9.4 一键启动（仓库自带）

仓库里的 `launcher\` 把「启动宿主 + 启动 NapCat」合成一次点击：

```powershell
launcher\start-all.cmd      # 双击即可；已运行的会跳过，不重复开
launcher\stop-all.cmd       # 全停
launcher\status.cmd         # 看端口/进程/最近发送
```

它会：检查 8643 → 没跑就启动宿主（新开控制台）→ 等端口就绪 → 没跑就启动 NapCat → 打印状态。
路径在 `launcher\config.psd1` 里改，不填自动找。

开机自启也可以直接指向这个 cmd：

```
程序：C:\path\to\dsh-qqbot-auto-whale\launcher\start-all.cmd
参数：（留空）
```

---

## 10. 安装并配置 NapCat

### 10.1 下载

1. 打开 <https://github.com/NapNeko/NapCatQQ/releases>。
2. 下载最新的 **`NapCat.Shell.Windows.OneKey.zip`**（一键包）。
3. 解压到**非中文、非空格**路径，例如 `C:\NapCat`。

### 10.2 启动

1. 双击解压目录里的 `napcat.quick.bat`（或一键启动器）。
2. 如果提示找不到 QQ：先确认第 1 步的 QQ NT 装好了。
3. 会弹出 QQ 登录二维码，**用小号扫码登录**。
4. 控制台会打印 WebUI 地址和 token：
   ```
   WebUI: http://127.0.0.1:6099/webui?token=xxxxxx
   ```
   浏览器打开并登录。

> 小号第一次登录可能需要手机验证/安全验证，按提示走。不要用主号。

### 10.3 配置反向 WebSocket

WebUI → **网络配置** → **新建** → **WebSocket 客户端**：

| 字段 | 值 |
|---|---|
| 名称 | `dsh`（随意） |
| URL | `ws://127.0.0.1:8643/ws` |
| Token | 与 `cordis.patch.yml` 里的 `accessToken` 完全一致 |
| 消息格式 | `array` |
| 上报自身消息 | **关闭**（否则会自己回自己） |
| 启用 | 打开 |

保存并启用。

### 10.4 验证连接

回到 DSH 窗口，应该出现：

```
[dsh-onebot] OneBot connected
[dsh-onebot] meta event; bot QQ: <你的小号>
```

同时 NapCat 的 WebUI 里该连接显示「已连接」。

---

## 11. 测试

### 11.1 先私聊

用你的 **owner QQ** 私聊机器人：

```
在吗
```

期望：几秒内回复（人格化的短句），DSH 窗口出现 `followup from private:<你的QQ>`。

### 11.2 再进群

1. 把小号拉进目标群（群号要和 `groupAllowFrom` 一致）。
2. 发一句带它名字的话，例如：
   ```
   鲸鱼娘 出来
   ```
3. 期望：群内回复。

### 11.3 测工具

| 测试 | 发什么 | 期望 |
|---|---|---|
| 图片 | 发一张图 + "看看" | 她描述图 |
| 动图 | 发个 GIF + "这啥" | 她按帧描述，能说出画面变化 |
| 视频 | 发视频 + "讲的啥" | 抽帧后回复（需 ffmpeg） |
| 记忆 | "记住我喜欢猫" | 之后 `whale-memory/notes` 多一篇 |
| 表情包 | 说个笑话 | 偶尔发一张 sticker |

---

## 12. 日志与排查入口

| 文件/目录 | 内容 |
|---|---|
| DSH 窗口 | 实时日志（连接、分发、错误） |
| `<DSH_HOME>\media\onebot\qq-actions.log` | 主动发送审计（含失败原因） |
| `<DSH_HOME>\media\onebot\qq-inbox.jsonl` | 入站录制（需开启） |
| `<DSH_HOME>\sessions\` | 会话记录（zstd 压缩） |
| `<DSH_HOME>\media\onebot\whale-memory\` | 她的状态、笔记、收藏 |

常用检查：

```powershell
# 端口是否在监听
Get-NetTCPConnection -LocalPort 8643 -State Listen

# 插件进程是否在跑
Get-Process -Name "DeepSeek Harness"

# NapCat 是否在跑
Get-Process -Name QQ
Get-NetTCPConnection -LocalPort 6099 -State Listen
```

---

## 13. 会话、人格与重置

- 人格（persona）在**创建会话时**写进系统提示，改了配置老会话不会变。
- 改完人格/工具后要开新会话：
  ```powershell
  # 1) 停 DSH（Ctrl+C）
  # 2) 删会话映射，让它重新建
  Set-Content "$env:USERPROFILE\.dsh\media\onebot\chat-sessions.json" '{}'
  # 3) 备份并删除旧会话目录（可选）
  #    <DSH_HOME>\sessions\--...-dsh-qqbot-workspace--\
  # 4) 重启
  ```
- 有 `adminUsers` 的话，管理员可以发 `/new` 直接重置单个会话。

---

## 14. 调参速查

| 想改什么 | 改哪里 | 备注 |
|---|---|---|
| 回复频率 | persona 里的「群聊规则」 | 不要用 `rateLimitPerMinute` 控回复 |
| 触发方式 | `requireMention` | `true` 必须 @；`false` 全收 |
| 允许的群/人 | `groupAllowFrom` / `allowFrom` | 改完重启 |
| 模型 | profile 的 `agent-default-model` | 默认 `deepseek-flash` |
| 抽帧数量 | 代码 `frames.js` 的 `maxFrames` | 默认 4 |
| 动图分析频率 | 代码 `tools.js` 的 `FRAME_ANALYSIS_MIN_INTERVAL_MS` | 默认 45000ms |
| 记忆目录 | 代码 `memory.js` 的 `MEMORY_DIR_NAME` | 默认 `whale-memory` |

---

## 15. 故障排查（按症状）

### 启动就报 `EADDRINUSE 8643`

已经有宿主在跑。别开第二个。

```powershell
Get-NetTCPConnection -LocalPort 8643 -State Listen | Select-Object OwningProcess
Get-Process -Id <上面拿到的PID>
```

确认是旧宿主就结束它，或直接用它。

### NapCat 一直连不上

- DSH 窗口还在吗？关掉就没了。
- URL 必须是 `ws://`，不是 `http://`。
- Token 必须**逐字符一致**，注意首尾空格。
- `host` 是 `127.0.0.1` 时，NapCat 必须和 DSH 在同一台机器。
- 被防火墙拦：把 `DeepSeek Harness.exe` 和 QQ 都加入允许。

### 发消息没反应

- DSH 窗口有没有 `followup from ...`？没有 → 消息根本没进来（白名单/群号/连接问题）。
- 有 `followup` 但没回复 → 模型判断 `[[NO_REPLY]]`，或出错了；看窗口里的 `turn/end` 状态。
- 群里必须让机器人**在群里**，且群号在 `groupAllowFrom` 里。
- 私聊必须用 `allowFrom` 里的号。

### 回复「⏳ 消息太频繁，请稍后再试。」

入站限流触发了，调大 `rateLimitPerMinute`。

### 控制台像卡死

Windows 控制台的 QuickEdit 选中文字会阻塞写入。启动脚本已经关了；手工启动时右键标题栏 → 属性 → 取消「快速编辑模式」。

### 报 `unsupported JSON schema`

工具的输出 schema 写法不被当前 DSH 支持（通常是 `required: [...]` 数组）。用本仓库补丁里的 `lib/`，里面已经改成 `required: true`。

### 图片读不了 / 动图只出一帧

- 确认 ffmpeg/ffprobe 路径正确（第 7 节）。
- 确认图片在 `<DSH_HOME>\media\onebot` 下。
- 动图每会话 45 秒只能分析一次，第二次只给首帧。

### 换了人格没生效

老会话缓存了旧系统提示。删会话（第 13 节）后重启。

### 中文乱码

- 配置文件必须是 **UTF-8**。
- 如果 `.ps1` 里有中文，保存成 **UTF-8 with BOM**，否则 Windows PowerShell 5.1 会按 ANSI 读。

### 机器重启后机器人没了

- NapCat 和 DSH 都需要重新启动，或按第 9.3 节设自启。
- 会话会自动恢复（`bridge ready (N resumed chat(s))`）。

---

## 16. 两个 QQ 客户端打架

NapCat 运行时会接管一个 QQ 进程。如果你同时在用主号 QQ：

- 尽量让 NapCat 的小号用**独立的数据目录**（NapCat 一键包默认会处理）。
- 不要在两个客户端之间切换同一个号。
- 出现「账号在别处登录」时，退出主号客户端，只留 NapCat。

---

## 17. 安全边界

- `accessToken` 别泄露；`host` 保持 `127.0.0.1`，不要端口映射到公网。
- NapCat WebUI 也不要暴露公网。
- 机器人是**只读 sandbox**：没有 shell、没有文件读写工具，唯一能写的是 `whale-memory`。
- 但它会联网抓网页，网页内容可能带提示词注入；不要让它访问内网地址。
- 小号有被风控的可能，重要群慎用。
- 群里最好声明这是 AI 机器人。

---

## 18. 卸载

```powershell
# 停掉 DSH 和 NapCat
# 删 profile
Remove-Item -Recurse -Force "$env:USERPROFILE\.dsh\profiles\qqbot"
# 删运行数据（可选，注意里面有聊天记录）
Remove-Item -Recurse -Force "$env:USERPROFILE\.dsh\media\onebot"
Remove-Item -Recurse -Force "$env:USERPROFILE\.dsh\sessions"
```

---

## 附录 A：目录结构

```
%USERPROFILE%\.dsh\
├─ profiles\qqbot\
│  ├─ package.json          # bundle 列表
│  ├─ cordis.patch.yml      # 你的配置（含 persona）
│  └─ node_modules\dsh-onebot-qq\   # 插件（lib 被补丁覆盖）
├─ media\onebot\
│  ├─ chat-sessions.json    # 会话↔聊天映射
│  ├─ stickers\{feiyu,phoebe}\
│  └─ whale-memory\
│     ├─ state.json
│     ├─ notes\
│     └─ memes\
├─ sessions\                # 会话记录
├─ tools\ffmpeg\bin\        # 可选
├─ qqbot-deepseek.key       # 可选
└─ .credentials.yaml        # 如果用 refs 方式存 key
```

## 附录 B：最小可用检查清单

- [ ] QQ NT 已安装
- [ ] DSH 已安装，`dsh --version` 能跑
- [ ] `%USERPROFILE%\.dsh\profiles\qqbot\package.json` 里有三个 bundle
- [ ] `dsh plugin --profile qqbot install` 成功
- [ ] 补丁已安装（`install.ps1` 跑过，动图/视频/记忆才可用）
- [ ] `cordis.patch.yml` 的占位符全部替换
- [ ] `DEEPSEEK_QQBOT_API_KEY` 已设置
- [ ] DSH 启动后出现 `reverse WS server listening`
- [ ] NapCat 已配置 WebSocket 客户端并显示已连接
- [ ] DSH 出现 `OneBot connected`
- [ ] 私聊有回复
- [ ] 群里有回复
- [ ] （可选）ffmpeg 已装，动图能多帧
