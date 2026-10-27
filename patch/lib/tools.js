/**
 * Model-facing tools for the OneBot channel: media sends, merged forwards,
 * the whitelisted NapCat API proxy, and group history. Tools infer the target
 * chat from the calling agent's session; an explicit chat_id overrides.
 * @module dsh-onebot/tools
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import { basename, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileToBase64, isUrl } from './media.js';
import { splitChatId } from './chat.js';
import { parseMessage, cqUnescape } from './cq.js';
import { registerMemoryTools } from './memory.js';
import { cleanupFrames, configureTools, extractFrames, normalizeStill, sniffMedia } from './frames.js';
/** OneBot actions a model may invoke through qq_napcat_api. */
const NAPCAT_API_WHITELIST = [
    'get_group_member_list',
    'get_group_member_info',
    'get_stranger_info',
    'get_forward_msg',
    'get_record',
    'get_file',
    'upload_group_file',
    'upload_private_file',
    'get_group_root_files',
    'get_group_files_by_folder',
    'get_group_file_url',
    'get_private_file_url',
    'get_ai_characters',
    'send_group_ai_record',
];
/** Local sticker packs under mediaDir/stickers, plus the bot's own meme collection. */
const STICKER_PACK_NAMES = ['feiyu', 'phoebe', 'whale'];
const STICKER_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);
/** At most one animated/video frame analysis per chat in this window. */
const FRAME_ANALYSIS_MIN_INTERVAL_MS = 45_000;
const lastFrameAnalysis = new Map();
/**
 * Whether this chat may spend a frame-analysis call now. Animations/videos are
 * the only expensive look: a burst of GIFs would otherwise turn into dozens of
 * images per model turn.
 */
function frameBudget(chatId, kind) {
    const key = chatId + '#' + kind;
    const now = Date.now();
    const last = lastFrameAnalysis.get(key) ?? 0;
    if (now - last < FRAME_ANALYSIS_MIN_INTERVAL_MS)
        return false;
    lastFrameAnalysis.set(key, now);
    return true;
}
/** Shared output shape for multi-frame reads: ordered stills plus their times. */
function framesOutput() {
    return {
        schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
                path: { type: 'string', required: true },
                kind: { type: 'string', required: true, description: 'image / animation / video' },
                durationSec: { type: 'number' },
                frameCount: { type: 'integer', required: true },
                frames: {
                    type: 'array',
                    required: true,
                    items: {
                        type: 'object',
                        additionalProperties: false,
                        properties: {
                            attachmentId: { type: 'string', required: true },
                            mediaType: { type: 'string', required: true },
                            bytes: { type: 'integer', required: true },
                            width: { type: 'integer', required: true },
                            height: { type: 'integer', required: true },
                            at: { type: 'number', required: true },
                        },
                    },
                },
            },
        },
        render: (_args, value) => {
            const v = value;
            const frames = Array.isArray(v.frames) ? v.frames : [];
            const head = v.kind === 'image'
                ? `<path>${v.path}</path>\n<type>image</type>`
                : `<path>${v.path}</path>\n<type>${v.kind}</type>\n<duration>${(v.durationSec ?? 0).toFixed(2)}s</duration>\n<frames>${frames.length}</frames>\n按时间顺序看这 ${frames.length} 帧，它们来自同一段画面。`;
            const blocks = [{ type: 'text', text: head }];
            frames.forEach((frame, index) => {
                blocks.push({
                    type: 'text',
                    text: `第 ${String(index + 1)}/${String(frames.length)} 帧 @${(frame.at ?? 0).toFixed(2)}s`,
                });
                blocks.push({
                    type: 'image',
                    attachment: {
                        attachmentId: frame.attachmentId,
                        mediaType: frame.mediaType,
                        bytes: frame.bytes,
                        width: frame.width,
                        height: frame.height,
                    },
                });
            });
            return blocks;
        },
    };
}
/** Read frame files and persist them as attachments, keeping their timestamp. */
async function uploadFrames(ctx, frameFiles) {
    const attachments = ctx.get('attachments');
    if (attachments === undefined)
        throw new Error('附件服务不可用');
    const refs = [];
    for (const frame of frameFiles) {
        const data = await readFile(frame.path);
        const ref = await attachments.saveImage({
            data,
            mediaType: 'image/png',
            name: 'frame.png',
        });
        refs.push({
            attachmentId: ref.attachmentId,
            mediaType: ref.mediaType,
            bytes: ref.bytes,
            width: ref.width,
            height: ref.height,
            at: frame.at,
        });
    }
    return refs;
}
/** Convert one still into the frames-output shape. */
async function singleFrameOutput(ctx, path, name) {
    const attachments = ctx.get('attachments');
    if (attachments === undefined)
        throw new Error('附件服务不可用');
    let uploadPath = path;
    let cleanupDir;
    try {
        // The attachment store rejects images beyond its per-side / total-pixel
        // caps (IMAGE_DIMENSION_TOO_LARGE / IMAGE_TOO_MANY_PIXELS), which showed
        // up as "读不了这张图". Shrink oversized stills before uploading.
        const normalized = await normalizeStill(path);
        if (normalized.temp === true && normalized.dir !== undefined) {
            uploadPath = normalized.path;
            cleanupDir = normalized.dir;
        }
        const data = await readFile(uploadPath);
        // Trust the bytes, not the file name: QQ stores PNG screenshots under a
        // default `.jpg` name, and the attachment store rejects a declared type
        // that does not match the payload (IMAGE_TYPE_MISMATCH).
        const mediaType = detectImageMediaType(data);
        if (mediaType === undefined)
            throw new Error('qq_read_image: 不支持的图片格式（只支持 png/jpeg/webp/gif）');
        const ref = await attachments.saveImage({ data, mediaType, name });
        return {
            path,
            kind: 'image',
            frameCount: 1,
            frames: [{
                attachmentId: ref.attachmentId,
                mediaType: ref.mediaType,
                bytes: ref.bytes,
                width: ref.width,
                height: ref.height,
                at: 0,
            }],
        };
    }
    finally {
        if (cleanupDir !== undefined)
            await cleanupFrames(cleanupDir);
    }
}
/** Output projection shared by the send tools (unconstrained JSON value). */
function sendOutput() {
    return {
        schema: { type: 'json' },
        render: (_args, value) => {
            const v = value;
            return [{ type: 'text', text: v.messageId != null ? '已发送（message_id=' + v.messageId + '）' : '已发送' }];
        },
    };
}
/** Resolve the target chat for a tool call. */
function resolveChat(bridge, exec, chatIdArg) {
    if (typeof chatIdArg === 'string' && chatIdArg !== '')
        return chatIdArg;
    const sessionId = exec.agent?.session.id;
    if (sessionId !== undefined) {
        const chatId = bridge.chatForSession(String(sessionId));
        if (chatId !== undefined)
            return chatId;
    }
    throw new Error('无法确定目标会话：请传 chat_id（格式 private:<qq> 或 group:<群号>）');
}
/**
 * Outbound media fence roots for the calling session's current turn
 * (M1-A3b): the plugin media dir always, plus the chat workspace on admin
 * turns. An unknown caller session degrades to mediaDir-only inside the
 * bridge — fail-closed.
 */
async function mediaRoots(bridge, exec) {
    const gate = await bridge.mediaSendRoots(exec.agent?.session.id);
    return gate.roots;
}
/**
 * Read one local media file behind the outbound fence, translating the
 * fence refusal (which reaches the model verbatim) into an actionable
 * hint; size-cap and OS errors keep their original message.
 */
async function fencedMediaFile(path, maxBytes, allowedRoots) {
    try {
        return await fileToBase64(path, maxBytes, allowedRoots);
    }
    catch (error) {
        if (error instanceof Error && error.message.startsWith('path not allowed or does not exist')) {
            throw new Error('本地路径不在允许的媒体目录内（管理员回合可另读会话工作区），或文件不存在：' + path);
        }
        throw error;
    }
}
/**
 * List usable sticker files from one or both local packs. Paths are resolved
 * under the plugin media dir so qq_send_sticker never needs hard-coded paths.
 */
async function stickerFiles(bridge, pack, maxBytes) {
    const root = join(bridge.deps.config.mediaDir, 'stickers');
    const packs = pack === 'all' ? STICKER_PACK_NAMES : [pack];
    const files = [];
    for (const name of packs) {
        const dir = name === 'whale'
            ? join(bridge.deps.config.mediaDir, 'whale-memory', 'memes')
            : join(root, name);
        let entries;
        try {
            entries = await readdir(dir, { withFileTypes: true });
        }
        catch {
            continue;
        }
        for (const entry of entries) {
            if (!entry.isFile() || !STICKER_EXTS.has(extname(entry.name).toLowerCase()))
                continue;
            const path = join(dir, entry.name);
            try {
                const info = await stat(path);
                if (info.size > 0 && info.size <= maxBytes)
                    files.push(path);
            }
            catch {
                // Ignore files that disappear between readdir and stat.
            }
        }
    }
    return files;
}
/** Map a local image path to its declared media type. */
function imageMediaTypeForPath(path) {
    switch (extname(path).toLowerCase()) {
        case '.png': return 'image/png';
        case '.jpg':
        case '.jpeg': return 'image/jpeg';
        case '.gif': return 'image/gif';
        case '.webp': return 'image/webp';
        default: return undefined;
    }
}
/** Sniff a still image's real media type from its magic bytes. */
function detectImageMediaType(data) {
    if (data.length >= 8 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47)
        return 'image/png';
    if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff)
        return 'image/jpeg';
    if (data.length >= 6) {
        const head = data.toString('latin1', 0, 6);
        if (head === 'GIF87a' || head === 'GIF89a')
            return 'image/gif';
        if (data.toString('latin1', 0, 4) === 'RIFF' && data.toString('latin1', 8, 12) === 'WEBP')
            return 'image/webp';
    }
    return undefined;
}
/**
 * Register all qq_* tools on the context. Registration is effect-based: the
 * returned disposer unregisters them.
 * @param ctx - plugin context.
 * @param bridge - the chat bridge.
 * @param connection - the OneBot connection.
 * @param limits - media size caps.
 * @returns the disposer.
 */
export function registerTools(ctx, bridge, connection, limits) {
    configureTools(bridge.deps.config.mediaDir);
    const disposers = [];
    const register = (tool) => {
        disposers.push(ctx.tools.register(tool));
    };
    register(defineTool({
        name: 'qq_send_image',
        description: '向 QQ 会话发送一张或多张图片（本地文件路径或 http(s) URL，最多 9 张）。用于回复用户时附带截图/生成图等。',
        parameters: {
            sources: {
                type: 'array',
                items: { type: 'string' },
                required: true,
                description: '图片来源：本地绝对路径或 http(s) URL，最多 9 个',
            },
            chat_id: {
                type: 'string',
                description: '目标会话，格式 private:<QQ号> 或 group:<群号>；省略时默认当前会话',
            },
            caption: {
                type: 'string',
                description: '图片说明文字（可选，作为图片前的文本发送）',
            },
        },
        output: sendOutput(),
        isConcurrencySafe: () => true,
        execute: async (args, exec) => {
            const a = args;
            const sources = Array.isArray(a.sources) ? a.sources.filter((s) => typeof s === 'string') : [];
            if (sources.length === 0)
                throw new Error('qq_send_image: sources 不能为空');
            if (sources.length > 9)
                throw new Error('qq_send_image: 一次最多 9 张图片');
            const chatId = resolveChat(bridge, exec, a.chat_id);
            const allowedRoots = await mediaRoots(bridge, exec);
            const segments = [];
            if (typeof a.caption === 'string' && a.caption !== '') {
                segments.push({ type: 'text', data: { text: a.caption } });
            }
            for (const source of sources) {
                if (isUrl(source)) {
                    segments.push({ type: 'image', data: { url: source } });
                }
                else {
                    segments.push({ type: 'image', data: { file: await fencedMediaFile(source, limits.maxImageBytes, allowedRoots) } });
                }
            }
            const messageId = await bridge.sendSegments(chatId, segments);
            return { sent: true, messageId: messageId ?? null };
        },
    }));
    register(defineTool({
        name: 'qq_read_image',
        description: '读取 media 目录下的图片并交给你查看（入站图片或表情包）。动图会自动抽成多帧、按时间顺序给你；必须给 media 目录内的绝对路径，不能读 media 目录外的文件。',
        parameters: {
            file_path: {
                type: 'string',
                description: '图片绝对路径，必须在 C:\\Users\\umdersweetbox\\.dsh\\media\\onebot 下；省略时读取当前会话最近一张入站图',
            },
        },
        output: framesOutput(),
        isConcurrencySafe: () => true,
        execute: async (args, exec) => {
            const a = args;
            const chatId = resolveChat(bridge, exec, undefined);
            const fallback = bridge.registry.getSettings(chatId).lastImagePath;
            const rawPath = typeof a.file_path === 'string' && a.file_path !== '' ? a.file_path : fallback;
            if (typeof rawPath !== 'string' || rawPath === '')
                throw new Error('qq_read_image: 没有指定图片，当前会话也没有入站图片');
            const mediaRoot = await realpath(resolve(bridge.deps.config.mediaDir));
            const target = await realpath(resolve(rawPath));
            const rel = relative(mediaRoot, target);
            if (rel === '' || rel.startsWith('..') || isAbsolute(rel))
                throw new Error('qq_read_image: 只允许读取 media 目录下的图片');
            const kind = await sniffMedia(target);
            if (kind === 'video')
                throw new Error('qq_read_image: 这是视频，请用 qq_read_video 读');
            if (kind === 'gif' || kind === 'webp' || kind === 'apng') {
                // Animated payloads never go to the attachment store raw: it would
                // keep a single frame and, when the inbound name says .jpg, may
                // reject the declared type outright. Cut stills ourselves.
                const maxFrames = frameBudget(chatId, 'animation') ? 4 : 1;
                try {
                    const extracted = await extractFrames(target, { maxFrames, maxEdge: 512 });
                    try {
                        if (extracted.frames.length > 0) {
                            const refs = await uploadFrames(ctx, extracted.frames);
                            return {
                                path: target,
                                kind: 'animation',
                                durationSec: extracted.duration,
                                frameCount: refs.length,
                                frames: refs,
                            };
                        }
                    }
                    finally {
                        await cleanupFrames(extracted.dir);
                    }
                }
                catch {
                    // No ffmpeg (or an undecodable animation): fall back to the
                    // single-image path below; a static first frame still helps.
                }
            }
            return await singleFrameOutput(ctx, target, basename(target));
        },
    }));
    register(defineTool({
        name: 'qq_read_video',
        description: '读取 video 文件（消息里的 [视频:...]）并交给你查看：抽 2-6 张关键帧，按时间顺序发给你。视频/动图这类会动的画面都用它。',
        parameters: {
            path: {
                type: 'string',
                description: '视频绝对路径，必须在 media 目录下；省略时用当前会话最近一个视频',
            },
            frames: {
                type: 'number',
                description: '抽几帧（2-6），默认 4',
            },
        },
        output: framesOutput(),
        isConcurrencySafe: () => true,
        execute: async (args, exec) => {
            const a = args;
            const chatId = resolveChat(bridge, exec, undefined);
            const rawPath = typeof a.path === 'string' && a.path !== '' ? a.path : bridge.registry.getSettings(chatId).lastVideoPath;
            if (typeof rawPath !== 'string' || rawPath === '')
                throw new Error('qq_read_video: 没有指定视频，当前会话也没有入站视频');
            const mediaRoot = await realpath(resolve(bridge.deps.config.mediaDir));
            const target = await realpath(resolve(rawPath));
            const rel = relative(mediaRoot, target);
            if (rel === '' || rel.startsWith('..') || isAbsolute(rel))
                throw new Error('qq_read_video: 只允许读取 media 目录下的视频');
            if (!frameBudget(chatId, 'video'))
                throw new Error('qq_read_video: 这个会话刚分析过视频/动图，过几十秒再看');
            const wanted = Math.max(2, Math.min(typeof a.frames === 'number' ? Math.round(a.frames) : 4, 6));
            const extracted = await extractFrames(target, { maxFrames: wanted, maxEdge: 512 });
            try {
                if (extracted.frames.length === 0)
                    throw new Error('qq_read_video: 抽帧失败，格式可能不支持');
                const refs = await uploadFrames(ctx, extracted.frames);
                return {
                    path: target,
                    kind: 'video',
                    durationSec: extracted.duration,
                    frameCount: refs.length,
                    frames: refs,
                };
            }
            finally {
                await cleanupFrames(extracted.dir);
            }
        },
    }));
    register(defineTool({
        name: 'qq_send_sticker',
        description: '向 QQ 会话发送一张本地表情包（肥鱼 / Phoebe / 自己收藏的 whale 包中随机或按文件名挑选）。适合群聊接梗、吐槽、回应，不要每句都发。',
        parameters: {
            pack: {
                type: 'string',
                description: '表情包包名：feiyu（肥鱼）、phoebe（菲比啾比）、whale（自己收藏的图），省略为 all',
            },
            name: {
                type: 'string',
                description: '可选：指定文件名（不含路径），省略则随机',
            },
            chat_id: {
                type: 'string',
                description: '目标会话，格式 private:<QQ号> 或 group:<群号>；省略时默认当前会话',
            },
            caption: {
                type: 'string',
                description: '图片说明文字（可选，作为图片前的文本发送）',
            },
        },
        output: sendOutput(),
        isConcurrencySafe: () => true,
        execute: async (args, exec) => {
            const a = args;
            const pack = typeof a.pack === 'string' && a.pack !== '' ? a.pack : 'all';
            if (pack !== 'all' && !STICKER_PACK_NAMES.includes(pack))
                throw new Error('qq_send_sticker: pack 只能是 feiyu / phoebe / whale / all');
            const chatId = resolveChat(bridge, exec, a.chat_id);
            const allowedRoots = await mediaRoots(bridge, exec);
            const files = await stickerFiles(bridge, pack, limits.maxImageBytes);
            if (files.length === 0)
                throw new Error('qq_send_sticker: 没有可用表情包（目录为空或文件超过大小上限）');
            let chosen;
            if (typeof a.name === 'string' && a.name !== '') {
                const wanted = a.name.toLowerCase();
                const basename = (p) => p.split(/[\\/]/).pop().toLowerCase();
                chosen = files.find((p) => basename(p) === wanted)
                    ?? files.find((p) => basename(p).includes(wanted));
                if (chosen === undefined)
                    throw new Error('qq_send_sticker: 找不到表情包 ' + a.name);
            }
            else {
                chosen = files[Math.floor(Math.random() * files.length)];
            }
            const segments = [];
            if (typeof a.caption === 'string' && a.caption !== '')
                segments.push({ type: 'text', data: { text: a.caption } });
            segments.push({ type: 'image', data: { file: await fencedMediaFile(chosen, limits.maxImageBytes, allowedRoots) } });
            const messageId = await bridge.sendSegments(chatId, segments);
            const normalized = chosen.replace(/\\/g, '/');
            return {
                sent: true,
                messageId: messageId ?? null,
                pack: normalized.includes('/whale-memory/') ? 'whale'
                    : normalized.includes('/feiyu/') ? 'feiyu' : 'phoebe',
                file: chosen.split(/[\\/]/).pop(),
            };
        },
    }));
    register(defineTool({
        name: 'qq_send_voice',
        description: '向 QQ 会话发送一条语音消息（本地音频文件路径，mp3/wav/silk 等；NapCat 负责转码）。',
        parameters: {
            path: { type: 'string', required: true, description: '本地音频文件绝对路径' },
            chat_id: { type: 'string', description: '目标会话；省略时默认当前会话' },
        },
        output: sendOutput(),
        isConcurrencySafe: () => true,
        execute: async (args, exec) => {
            const a = args;
            if (typeof a.path !== 'string' || a.path === '')
                throw new Error('qq_send_voice: path 必填');
            const chatId = resolveChat(bridge, exec, a.chat_id);
            const allowedRoots = await mediaRoots(bridge, exec);
            const messageId = await bridge.sendSegments(chatId, [
                { type: 'record', data: { file: await fencedMediaFile(a.path, limits.maxVoiceBytes, allowedRoots) } },
            ]);
            return { sent: true, messageId: messageId ?? null };
        },
    }));
    register(defineTool({
        name: 'qq_send_video',
        description: '向 QQ 会话发送一条视频消息（本地视频文件绝对路径）。',
        parameters: {
            path: { type: 'string', required: true, description: '本地视频文件绝对路径' },
            chat_id: { type: 'string', description: '目标会话；省略时默认当前会话' },
        },
        output: sendOutput(),
        isConcurrencySafe: () => true,
        execute: async (args, exec) => {
            const a = args;
            if (typeof a.path !== 'string' || a.path === '')
                throw new Error('qq_send_video: path 必填');
            const chatId = resolveChat(bridge, exec, a.chat_id);
            const allowedRoots = await mediaRoots(bridge, exec);
            const messageId = await bridge.sendSegments(chatId, [
                { type: 'video', data: { file: await fencedMediaFile(a.path, limits.maxFileBytes, allowedRoots) } },
            ]);
            return { sent: true, messageId: messageId ?? null };
        },
    }));
    register(defineTool({
        name: 'qq_send_file',
        description: '向 QQ 会话发送一个文件（本地文件绝对路径）。',
        parameters: {
            path: { type: 'string', required: true, description: '本地文件绝对路径' },
            name: { type: 'string', description: '文件名（默认取路径文件名）' },
            chat_id: { type: 'string', description: '目标会话；省略时默认当前会话' },
        },
        output: sendOutput(),
        isConcurrencySafe: () => true,
        execute: async (args, exec) => {
            const a = args;
            if (typeof a.path !== 'string' || a.path === '')
                throw new Error('qq_send_file: path 必填');
            const chatId = resolveChat(bridge, exec, a.chat_id);
            const allowedRoots = await mediaRoots(bridge, exec);
            const name = typeof a.name === 'string' && a.name !== '' ? a.name : a.path.split('/').pop() ?? 'file';
            const messageId = await bridge.sendSegments(chatId, [
                { type: 'file', data: { file: await fencedMediaFile(a.path, limits.maxFileBytes, allowedRoots), name } },
            ]);
            return { sent: true, messageId: messageId ?? null };
        },
    }));
    register(defineTool({
        name: 'qq_send_forward',
        description: '以「合并转发」形式向 QQ 会话发送多条消息（每条含发送者名和内容，适合代码+说明、分步报告等）。',
        parameters: {
            messages: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: {
                        name: { type: 'string', description: '显示名（≤24 字）' },
                        content: { type: 'string', description: '消息内容（≤500 字，必填）' },
                    },
                    additionalProperties: true,
                },
                required: true,
                description: '合并转发的消息节点列表',
            },
            chat_id: { type: 'string', description: '目标会话；省略时默认当前会话' },
        },
        output: sendOutput(),
        isConcurrencySafe: () => true,
        execute: async (args, exec) => {
            const a = args;
            if (!Array.isArray(a.messages) || a.messages.length === 0)
                throw new Error('qq_send_forward: messages 不能为空');
            const nodes = a.messages.map(m => {
                const node = m;
                return {
                    name: typeof node.name === 'string' && node.name !== '' ? node.name : '助手',
                    content: typeof node.content === 'string' ? node.content : '',
                };
            });
            if (nodes.some(n => n.content === ''))
                throw new Error('qq_send_forward: 每条消息都需要 content');
            const chatId = resolveChat(bridge, exec, a.chat_id);
            await bridge.sendForward(chatId, nodes);
            return { sent: true, messageId: null };
        },
    }));
    register(defineTool({
        name: 'qq_napcat_api',
        description: '调用 NapCat 白名单内的 OneBot 扩展 API（群成员列表/信息、文件、OCR、AI 语音等）。非白名单 action 会被拒绝。',
        parameters: {
            action: {
                type: 'string',
                required: true,
                description: '白名单 action：' + NAPCAT_API_WHITELIST.join(' / '),
            },
            params: {
                type: 'object',
                additionalProperties: true,
                description: 'action 参数（JSON 对象）',
            },
        },
        output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }] },
        isConcurrencySafe: () => true,
        execute: async (args, exec) => {
            const a = args;
            if (typeof a.action !== 'string' || !NAPCAT_API_WHITELIST.includes(a.action)) {
                throw new Error('qq_napcat_api: action 不在白名单内（' + NAPCAT_API_WHITELIST.join(', ') + '）');
            }
            const params = typeof a.params === 'object' && a.params !== null ? a.params : {};
            return await connection.call(a.action, params);
        },
    }));
    register(defineTool({
        name: 'qq_group_history',
        description: '拉取群聊最近消息历史（供总结群内上下文、查看用户之前的发言）。仅群聊可用。',
        parameters: {
            chat_id: { type: 'string', description: '目标群会话 group:<群号>；省略时默认当前会话（须为群聊）' },
            count: { type: 'number', description: '拉取条数（≤50，默认 20）' },
            message_seq: { type: 'number', description: '起始消息序号（翻页用，可选）' },
        },
        output: {
            schema: {
                type: 'array',
                items: { type: 'object', additionalProperties: true },
            },
            render: (_args, value) => {
                const list = Array.isArray(value) ? value : [];
                return [{ type: 'text', text: list.length + ' 条历史消息' }];
            },
        },
        isConcurrencySafe: () => true,
        execute: async (args, exec) => {
            const a = args;
            const chatId = resolveChat(bridge, exec, a.chat_id);
            if (splitChatId(chatId).kind !== 'group')
                throw new Error('qq_group_history: 仅支持群聊');
            const groupId = Number(splitChatId(chatId).target);
            const count = Math.min(Math.max(typeof a.count === 'number' ? Math.floor(a.count) : 20, 1), 50);
            const params = { group_id: groupId, count };
            if (typeof a.message_seq === 'number')
                params.message_seq = a.message_seq;
            const data = await connection.call('get_group_msg_history', params);
            const messages = Array.isArray(data.messages) ? data.messages : [];
            return messages.map(m => {
                const msg = m;
                const sender = (msg.sender ?? {});
                const message = msg.message;
                const segments = Array.isArray(message) ? message : undefined;
                const raw = typeof msg.raw_message === 'string' ? msg.raw_message : '';
                const parsed = parseMessage(segments, raw);
                return {
                    message_id: msg.message_id != null ? String(msg.message_id) : null,
                    time: msg.time != null ? String(msg.time) : null,
                    user_id: sender.user_id != null ? String(sender.user_id) : msg.user_id != null ? String(msg.user_id) : null,
                    nickname: typeof sender.card === 'string' && sender.card !== '' ? sender.card
                        : typeof sender.nickname === 'string' && sender.nickname !== '' ? sender.nickname
                            : String(sender.user_id ?? ''),
                    text: cqUnescape(parsed.text),
                };
            });
        },
    }));
    registerMemoryTools(register, bridge, resolveChat);
    return () => {
        for (const dispose of disposers)
            dispose();
    };
}
