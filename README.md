# dsh-qqbot-auto-whale

给 [`dsh-onebot-qq`](https://github.com/mario841859784/dsh-onebot) 加一层补丁：
**动图/视频抽帧**、**可随聊天变化的自我状态**、**私人笔记本和表情包收藏**。

不是 fork，是**补丁 + 一键安装脚本**。仓库里只放改动的 6 个文件，安装时从 npm 拉原版再覆盖。

## 装什么

| 能力 | 说明 |
|---|---|
| 动图理解 | `qq_read_image` 按文件头识别 GIF / 动态 WebP / APNG，自动抽 2-4 帧 |
| 视频理解（L2） | `qq_read_video`，用 ffmpeg 抽 2-6 帧 |
| 自我状态 | 每条消息前注入 `【鲸鱼娘·心境】`，心情/好感/精力会随时间衰减 |
| 私人记忆 | `qq_state_update` / `qq_memory_write` / `qq_memory_read`，只写 `whale-memory` |
| 表情包收藏 | `qq_save_meme` / `qq_meme_list`，配 `qq_send_sticker` 的 `whale` 包 |
| 戳一戳 | 识别指向机器人的 poke，合成 `[戳一戳]` 交给模型回应 |
| 静默 | `[[NO_REPLY]]` 哨兵，模型不想说话时完全不发消息 |

## 快速安装

```powershell
git clone https://github.com/CialloChen/dsh-qqbot-auto-whale.git
cd dsh-qqbot-auto-whale
.\install.ps1 -Profile qqbot
```

装之前可以先看它会做什么：

```powershell
.\install.ps1 -Profile qqbot -DryRun
```

脚本会：检查 dsh → 确保插件已装（默认 `dsh-onebot-qq@0.9.3`）→ 校验版本 → 备份并覆盖 7 个文件 → 复制配置模板（不覆盖已有的）。

完整步骤（QQ NT、DSH、profile、NapCat、排错）见 **[docs/install.md](docs/install.md)**。

## 一键启动

装好之后，日常只双击一个文件：

```
launcher\start-all.cmd
```

它会依次做：检查 8643 → 没跑就启动 DSH 宿主（新开控制台看日志）→ 等端口就绪 → 没跑就启动 NapCat → 打印状态。

配套三个：

| 文件 | 作用 |
|---|---|
| `launcher\start-all.cmd` | 启动（已运行的会跳过，不重复开） |
| `launcher\stop-all.cmd` | 停止宿主和 NapCat |
| `launcher\status.cmd` | 看端口、进程、最近一次发送时间 |

路径都在 [`launcher/config.psd1`](launcher/config.psd1) 里改（dsh 路径、profile、workspace、NapCat 启动器、key 文件），不填会自动找。

## 要求

- DeepSeek Harness **0.2.1-rc.x**
- `dsh-onebot-qq` **0.9.3**（脚本会校验，版本不符会拒绝）
- 可选：ffmpeg + ffprobe（动图多帧、视频抽帧；不装则动图只看首帧）
- Windows + PowerShell 5.1 或 7

## ffmpeg

放到下面任一位置即可被自动识别：

1. 环境变量 `DSH_QQBOT_FFMPEG`
2. `<DSH_HOME>\tools\ffmpeg\bin\ffmpeg.exe`
3. PATH 里的 `ffmpeg`

## 卸载

```powershell
.\uninstall.ps1 -Profile qqbot
```

只还原那 7 个文件（用 `install.ps1` 留下的 `.bak-<时间戳>`），不动你的配置和数据。

## 这个仓库里有什么

```
patch/lib/     改动的 7 个文件（5 改 2 新）
examples/      profile 配置模板（含鲸鱼娘人格）
docs/          从零安装指南
launcher/      一键启动 / 停止 / 状态
install.ps1    安装补丁
uninstall.ps1  还原
CHANGES.md     逐文件改动说明
NOTICE         上游署名与修改声明
```

## 原理与边界

- 上游 `lib/` 是 `src/*.ts` 的编译产物。本仓库直接改 `lib/`，所以**不要在上游仓库里跑 `npm run build`**——那会覆盖这些补丁。想长期跟进上游，需要把逻辑迁回 TypeScript 源码，那是另一件事。
- 补丁按 `0.9.3` 的函数签名写的。上游改接口后安装会失败（脚本先校验版本），不会装出半坏的东西。
- 人格、限流、白名单都在 `examples/cordis.patch.example.yml`，属于配置层，不随补丁覆盖。

## 许可

基于 [`dsh-onebot-qq`](https://github.com/mario841859784/dsh-onebot)，BSD 3-Clause，
Copyright (c) 2026, dsh-external contributors。见 [LICENSE](LICENSE) 与 [NOTICE](NOTICE)。

新增文件 `patch/lib/memory.js`、`patch/lib/frames.js` 同样以 BSD 3-Clause 发布。
