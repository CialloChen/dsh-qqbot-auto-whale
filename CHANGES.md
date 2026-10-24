# 修改说明（相对 dsh-onebot-qq 0.9.3）

## 新增文件

### `lib/frames.js`
动图 / 视频抽帧：

- `sniffMedia(path)`：按文件头识别 GIF / 动态 WebP / APNG / MP4 / WebM，不看扩展名
  （入站 QQ 图片常被存成 `.jpg`，但内容可能是 GIF）
- `probe(path)`：用 ffprobe 取时长、宽高、帧数
- `extractFrames(path, { maxFrames, maxEdge })`：按时长均匀抽 2-4 帧，缩放成长边 ≤512 的 PNG
- `cleanupFrames(dir)`、`toolsAvailable()`
- ffmpeg 查找顺序：`DSH_QQBOT_FFMPEG` → `<DSH_HOME>/tools/ffmpeg/bin/ffmpeg.exe` → PATH

### `lib/memory.js`
鲸鱼娘的自我状态与私人笔记本：

- 目录固定为 `<mediaDir>/whale-memory/`，任何路径都做 realpath 包含性校验
- `state.json`：心情、强度、好感、精力、印象、最近事件、最后更新时间
- `notes/*.md`：笔记（文件名做净化，禁止分隔符与 `..`）
- `memes/` + `index.json`：表情包收藏（按内容哈希去重）
- `buildStatePrefix(mediaDir)`：同步读 state，生成一行注入文本（含时间衰减：久未更新会回精力、心情变淡）
- 工具：`qq_state_update`、`qq_memory_write`、`qq_memory_read`、`qq_save_meme`、`qq_meme_list`

## 修改文件

### `lib/tools.js`

1. `NAPCAT_API_WHITELIST` 移除 `ocr_image`（本地图片路径下会超时）。
2. 新增 `qq_send_sticker`：从 `mediaDir/stickers/{feiyu,phoebe}` 或
   `whale-memory/memes`（`pack=whale`）随机/按名发送。
3. 新增 `qq_read_image`：读取 media 目录内图片；按文件头识别动图并抽 2-4 帧；
   输出改为 `{ path, kind, durationSec, frameCount, frames[] }`，多图一次返回。
4. 新增 `qq_read_video`：从 `[视频:...]` 路径抽 2-6 帧。
5. 动图/视频共用限流：每会话每 45 秒最多一次（动图与视频分开计数）。
6. `registerTools` 开头调用 `configureTools(mediaDir)`，并注册 memory 工具组。
7. 静态图片按**文件头**判定 mediaType（PNG/JPEG/GIF/WebP），不再用扩展名。
   QQ 会把截图存成 `.jpg` 但内容是 PNG，附件服务校验类型与字节不一致时会抛
   `IMAGE_TYPE_MISMATCH`，表现为「读不了这张图」。

### `lib/bridge.js`
1. `prefixTurn()` 在用户消息前注入 `buildStatePrefix()` 的一行心境状态（位于
   `<user_message>` 边界外，视为机器人自身状态而非用户输入）。
2. 入站入口拦截戳一戳：调用 `normalizePokeNotice`，用 `get_group_member_info`
   补昵称（1.5 秒超时兜底 QQ 号），再走正常入站管线。
3. 主动发言：`startProactive()` 按 `proactiveIntervalMinutes` 起定时器，
   `maybeProactive()` 检查空闲时长、静默时段、每日上限后，向
   `proactiveChats` 里的会话注入 `PROACTIVE_NUDGE`（【主动】系统提醒）并走正常回合。
   消息仍受 `[[NO_REPLY]]` 控制，模型不想说就不发。

### `lib/outbound.js`
1. `[[NO_REPLY]]` 哨兵：模型输出恰好为该标记时不发送任何消息（返回空段列表）。
2. `[[SPLIT]]` 连发：一条回复里用该标记分隔，会拆成多条消息依次发送
   （每条之间 350-700ms 随机停顿）；没有标记时行为不变。

### `lib/index.js`
新增配置项：`proactiveEnabled`、`proactiveChats`、`proactiveMinIdleMinutes`、
`proactiveIntervalMinutes`、`proactiveMaxPerDay`、`proactiveQuietStartHour`、
`proactiveQuietEndHour`，并把它们透传给 bridge 的 `deps.config`。

### `lib/inbound.js`
1. 视频解析时记录 `settings.lastVideoPath`，供 `qq_read_video` 省略路径时回退。
2. 新增 `normalizePokeNotice(event, selfId)`：把指向机器人的戳一戳 notice 转成
   `[戳一戳]` 合成消息。只处理目标是自己、且不是自己戳自己的情况；群里没有
   `target_id` 的戳一戳一律忽略，避免误唤醒。

### `lib/connection.js`
把 `post_type === 'notice'` 的事件转给入站处理器（原实现直接丢弃 notice）。
非戳一戳的 notice 仍会被 `normalizeOneBot11` 判空忽略。

## 配置（不属于插件代码）
`cordis.patch.example.yml` 里的 persona、rate limit、preset 均为配置层改动，
不随 `lib/` 覆盖生效，需要单独合并。
