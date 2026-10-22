/**
 * Whale memory: the bot's own mood/affection state plus a small private
 * notebook and meme collection, all under a fixed directory inside the
 * plugin media dir (<mediaDir>/whale-memory). Nothing outside that folder is
 * ever touched by these helpers. The state file is read synchronously on each
 * dispatch (tiny file) so the model always sees an up-to-date mood line; all
 * writes are serialized per process to avoid lost updates between the group
 * and private chats.
 * @module dsh-onebot/memory
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { basename, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { defineTool } from '@deepseek-ai/dsh-tools';
/** Folder name created under the plugin media dir. */
export const MEMORY_DIR_NAME = 'whale-memory';
const STATE_FILE = 'state.json';
const NOTES_DIR = 'notes';
const MEMES_DIR = 'memes';
const MEME_INDEX = 'index.json';
const MAX_EVENTS = 12;
const MAX_EVENT_CHARS = 80;
const MAX_MOOD_CHARS = 8;
const MEME_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);
/** Neutral starting point, used the first time the bot runs. */
const DEFAULT_STATE = {
    mood: '平静',
    moodIntensity: 50,
    affection: 55,
    energy: 80,
    traits: {},
    recentEvents: [],
    lastUpdate: '',
};
/** Absolute path of the bot's private folder. */
export function memoryRoot(mediaDir) {
    return join(mediaDir, MEMORY_DIR_NAME);
}
/** Serialize state writes so two chats cannot interleave a read-modify-write. */
let stateQueue = Promise.resolve();
function serialize(task) {
    const run = stateQueue.then(task, task);
    stateQueue = run.catch(() => undefined);
    return run;
}
function clampInt(value, min, max, fallback) {
    const n = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : fallback;
    return Math.min(max, Math.max(min, n));
}
function cleanText(value, maxChars) {
    if (typeof value !== 'string')
        return '';
    return value.replace(/[\r\n\t]+/g, ' ').trim().slice(0, maxChars);
}
/** Coerce whatever is on disk into the documented shape (tolerates hand edits). */
function normalizeState(raw) {
    const input = (typeof raw === 'object' && raw !== null) ? raw : {};
    const traits = {};
    if (typeof input.traits === 'object' && input.traits !== null) {
        for (const [key, value] of Object.entries(input.traits)) {
            const k = cleanText(key, 12);
            const v = cleanText(value, 60);
            if (k !== '' && v !== '')
                traits[k] = v;
        }
    }
    const recentEvents = [];
    if (Array.isArray(input.recentEvents)) {
        for (const entry of input.recentEvents) {
            if (typeof entry !== 'object' || entry === null)
                continue;
            const text = cleanText(entry.text, MAX_EVENT_CHARS);
            if (text === '')
                continue;
            recentEvents.push({ at: typeof entry.at === 'string' ? entry.at : '', text });
        }
    }
    return {
        mood: cleanText(input.mood, MAX_MOOD_CHARS) || DEFAULT_STATE.mood,
        moodIntensity: clampInt(input.moodIntensity, 0, 100, DEFAULT_STATE.moodIntensity),
        affection: clampInt(input.affection, 0, 100, DEFAULT_STATE.affection),
        energy: clampInt(input.energy, 0, 100, DEFAULT_STATE.energy),
        traits,
        recentEvents: recentEvents.slice(0, MAX_EVENTS),
        lastUpdate: typeof input.lastUpdate === 'string' ? input.lastUpdate : '',
    };
}
function statePath(mediaDir) {
    return join(memoryRoot(mediaDir), STATE_FILE);
}
/** Synchronous read for the per-dispatch prompt prefix. Never throws. */
export function readStateSync(mediaDir) {
    try {
        return normalizeState(JSON.parse(readFileSync(statePath(mediaDir), 'utf8')));
    }
    catch {
        return normalizeState({});
    }
}
/** Async read for the tools (same normalization). */
export async function readState(mediaDir) {
    try {
        return normalizeState(JSON.parse(await readFile(statePath(mediaDir), 'utf8')));
    }
    catch {
        return normalizeState({});
    }
}
async function writeState(mediaDir, state) {
    await mkdir(memoryRoot(mediaDir), { recursive: true });
    await writeFile(statePath(mediaDir), JSON.stringify(state, null, 2) + '\n', 'utf8');
}
/**
 * Time drift applied to the stored values when they are shown: resting
 * restores energy and calms the mood. Display-only — the stored file keeps
 * exactly what the model last wrote until its next update.
 */
export function effectiveState(state, now = Date.now()) {
    const updated = Date.parse(state.lastUpdate);
    const hours = Number.isFinite(updated) ? Math.max(0, (now - updated) / 3_600_000) : 0;
    const energy = clampInt(state.energy + Math.floor(hours * 4), 0, 100, state.energy);
    const moodIntensity = clampInt(state.moodIntensity - Math.floor(hours * 5), 15, 100, state.moodIntensity);
    let mood = state.mood;
    if (hours >= 12 && moodIntensity <= 25)
        mood = '平静';
    return { mood, moodIntensity, affection: state.affection, energy, hours };
}
function ageText(hours) {
    if (!Number.isFinite(hours) || hours < 0)
        return '还没记过';
    if (hours < 1 / 60)
        return '刚刚';
    if (hours < 1)
        return Math.floor(hours * 60) + '分钟前';
    if (hours < 24)
        return Math.floor(hours) + '小时前';
    return Math.floor(hours / 24) + '天前';
}
/**
 * The one-line self-state injected ahead of every inbound message so the
 * model's mood carries between turns. Returns '' when memory has never been
 * written (nothing to say yet).
 */
export function buildStatePrefix(mediaDir, now = Date.now()) {
    const state = readStateSync(mediaDir);
    if (state.lastUpdate === '')
        return '';
    const eff = effectiveState(state, now);
    let line = '【鲸鱼娘·心境】心情 ' + eff.mood + '(' + eff.moodIntensity + '/100)｜对主人好感 ' + eff.affection + '/100｜精力 ' + eff.energy + '/100｜更新于 ' + ageText(eff.hours);
    const latest = state.recentEvents[0];
    if (latest !== undefined && latest.text !== '') {
        const age = Date.parse(latest.at);
        if (!Number.isFinite(age) || now - age <= 2 * 3_600_000)
            line += '｜刚发生：' + latest.text;
    }
    if (Number.isFinite(eff.hours) && eff.hours >= 1.5)
        line += '｜（心境有一阵没更新了，按刚才的聊天用 qq_state_update 调一下）';
    return line;
}
/**
 * Apply one model-authored state change. Numbers are clamped, free text is
 * flattened to one line, and events are kept newest-first with a hard cap.
 */
export async function applyStateUpdate(mediaDir, patch) {
    return await serialize(async () => {
        const state = await readState(mediaDir);
        const now = new Date();
        const iso = now.toISOString();
        const mood = cleanText(patch.mood, MAX_MOOD_CHARS);
        if (mood !== '')
            state.mood = mood;
        if (patch.moodIntensity !== undefined)
            state.moodIntensity = clampInt(patch.moodIntensity, 0, 100, state.moodIntensity);
        if (patch.affection !== undefined)
            state.affection = clampInt(patch.affection, 0, 100, state.affection);
        if (patch.energy !== undefined)
            state.energy = clampInt(patch.energy, 0, 100, state.energy);
        if (typeof patch.traits === 'object' && patch.traits !== null) {
            for (const [key, value] of Object.entries(patch.traits)) {
                const k = cleanText(key, 12);
                const v = cleanText(value, 60);
                if (k === '')
                    continue;
                if (v === '')
                    delete state.traits[k];
                else
                    state.traits[k] = v;
            }
        }
        if (Array.isArray(patch.removeTraits)) {
            for (const key of patch.removeTraits) {
                const k = cleanText(key, 12);
                if (k !== '')
                    delete state.traits[k];
            }
        }
        const event = cleanText(patch.event, MAX_EVENT_CHARS);
        if (event !== '') {
            state.recentEvents.unshift({ at: iso, text: event });
            state.recentEvents = state.recentEvents.slice(0, MAX_EVENTS);
        }
        state.lastUpdate = iso;
        await writeState(mediaDir, state);
        return state;
    });
}
/** One-line human summary of a full state, used by the tool output. */
export function summarizeState(state) {
    const traits = Object.entries(state.traits).map(([k, v]) => k + '：' + v);
    const events = state.recentEvents.slice(0, 3).map((e) => e.text);
    const parts = [
        '心情 ' + state.mood + '(' + state.moodIntensity + '/100)',
        '对主人好感 ' + state.affection + '/100',
        '精力 ' + state.energy + '/100',
    ];
    if (traits.length > 0)
        parts.push('印象 ' + traits.join('，'));
    if (events.length > 0)
        parts.push('最近 ' + events.join('；'));
    return parts.join('｜');
}
/** Keep note filenames to one path segment of safe characters. */
function sanitizeNoteName(name) {
    const base = String(name ?? '')
        .replace(/\.md$/i, '')
        .replace(/[\\/:*?"<>|\r\n\t]+/g, '-')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 40);
    return base === '' || base === '.' || base === '..' ? 'note' : base;
}
/** Write (or append to) a note under whale-memory/notes. */
export async function writeNote(mediaDir, input) {
    const dir = join(memoryRoot(mediaDir), NOTES_DIR);
    await mkdir(dir, { recursive: true });
    const name = sanitizeNoteName(input.name !== undefined && input.name !== '' ? input.name : input.title);
    const path = join(dir, name + '.md');
    const content = String(input.content ?? '').trim();
    if (content === '')
        throw new Error('qq_memory_write: content 不能为空');
    if (input.append) {
        let previous = '';
        try {
            previous = await readFile(path, 'utf8');
        }
        catch {
            previous = '';
        }
        const block = '## ' + new Date().toLocaleString('zh-CN', { hour12: false }) + '\n\n' + content + '\n';
        const body = previous === '' ? '# ' + name + '\n\n' + block : previous.replace(/\s*$/, '') + '\n\n' + block;
        await writeFile(path, body, 'utf8');
        return { name, path, appended: true };
    }
    await writeFile(path, '# ' + name + '\n\n' + content + '\n', 'utf8');
    return { name, path, appended: false };
}
/** List notes (names, sizes, first line) or read one note's text. */
export async function readNotes(mediaDir, name) {
    const dir = join(memoryRoot(mediaDir), NOTES_DIR);
    if (name !== undefined && name !== '') {
        const path = join(dir, sanitizeNoteName(name) + '.md');
        try {
            return { found: true, path, text: await readFile(path, 'utf8') };
        }
        catch {
            return { found: false, path, text: '' };
        }
    }
    let entries;
    try {
        entries = await readdir(dir, { withFileTypes: true });
    }
    catch {
        return { found: true, path: dir, text: '（还没有写过任何笔记）' };
    }
    const files = entries.filter((e) => e.isFile() && extname(e.name).toLowerCase() === '.md');
    if (files.length === 0)
        return { found: true, path: dir, text: '（还没有写过任何笔记）' };
    const lines = [];
    for (const file of files) {
        const path = join(dir, file.name);
        let preview = '';
        try {
            preview = (await readFile(path, 'utf8')).split('\n').find((l) => l.trim() !== '' && !l.startsWith('#')) ?? '';
        }
        catch {
            preview = '';
        }
        lines.push('- ' + file.name.replace(/\.md$/i, '') + '：' + preview.trim().slice(0, 60));
    }
    return { found: true, path: dir, text: lines.join('\n') };
}
async function readMemeIndex(dir) {
    try {
        const parsed = JSON.parse(await readFile(join(dir, MEME_INDEX), 'utf8'));
        return Array.isArray(parsed) ? parsed : [];
    }
    catch {
        return [];
    }
}
/**
 * Copy one inbound image into whale-memory/memes, tagged for later recall.
 * Content-hash dedupe keeps repeated saves from piling up copies; the source
 * must live under the plugin media dir (same fence as qq_read_image).
 */
export async function saveMeme(mediaDir, input) {
    const dir = join(memoryRoot(mediaDir), MEMES_DIR);
    await mkdir(dir, { recursive: true });
    const mediaRoot = await realpath(resolve(mediaDir));
    const source = await realpath(resolve(input.sourcePath));
    const rel = relative(mediaRoot, source);
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel))
        throw new Error('qq_save_meme: 只能保存 media 目录下的图片');
    let ext = extname(source).toLowerCase();
    if (!MEME_EXTS.has(ext))
        throw new Error('qq_save_meme: 不支持的图片格式');
    const data = await readFile(source);
    const hash = createHash('sha256').update(data).digest('hex');
    const index = await readMemeIndex(dir);
    const existing = index.find((entry) => entry !== null && typeof entry === 'object' && entry.hash === hash);
    if (existing !== undefined) {
        return { duplicate: true, file: existing.file, path: join(dir, existing.file), tags: existing.tags ?? [] };
    }
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    const fileName = 'm-' + stamp + '-' + hash.slice(0, 8) + ext;
    await writeFile(join(dir, fileName), data);
    const tags = (Array.isArray(input.tags) ? input.tags : [])
        .map((tag) => cleanText(tag, 12))
        .filter((tag) => tag !== '')
        .slice(0, 8);
    const caption = cleanText(input.caption, 60);
    index.unshift({ file: fileName, hash, tags, caption, addedAt: new Date().toISOString() });
    await writeFile(join(dir, MEME_INDEX), JSON.stringify(index.slice(0, 500), null, 2) + '\n', 'utf8');
    return { duplicate: false, file: fileName, path: join(dir, fileName), tags };
}
/** List the collected memes (file + tags + caption). */
export async function listMemes(mediaDir) {
    const dir = join(memoryRoot(mediaDir), MEMES_DIR);
    const index = await readMemeIndex(dir);
    if (index.length === 0)
        return { path: dir, text: '（还没有收藏任何图）' };
    const lines = index.map((entry) => '- ' + entry.file + (entry.tags?.length ? ' [' + entry.tags.join('/') + ']' : '') + (entry.caption ? '：' + entry.caption : ''));
    return { path: dir, text: lines.join('\n') };
}
/** Render one tool result as a single text block. */
function textOutput(render) {
    return {
        schema: { type: 'json' },
        render: (_args, value) => {
            const text = render(value);
            return [{ type: 'text', text }];
        },
    };
}
/**
 * Register the memory tools on the QQ channel scope.
 * @param register - the caller's tool registration helper.
 * @param bridge - the chat bridge (config + chat lookup).
 * @returns nothing; tools are disposed with the channel scope.
 */
export function registerMemoryTools(register, bridge, resolveChat) {
    const mediaDir = () => bridge.deps.config.mediaDir;
    register(defineTool({
        name: 'qq_state_update',
        description: '更新鲸鱼娘此刻的心境，并记下刚发生的事（每聊几句或情绪被带动时调用一次；数值是 0-100）。',
        parameters: {
            mood: { type: 'string', description: '心情词，≤8 字：开心/平静/无聊/烦躁/得意/傲娇/emo/生气/害羞 等' },
            mood_intensity: { type: 'number', description: '心情强度 0-100，越大越明显' },
            affection: { type: 'number', description: '对主人的好感 0-100（一次最多上下浮动 5，别突变）' },
            energy: { type: 'number', description: '精力 0-100（越聊越累，被夸会回一点）' },
            event: { type: 'string', description: '刚发生的事，一句话，≤80 字，如“被群友说可爱”“主人说想我”' },
            traits: { type: 'object', additionalProperties: true, description: '要记下的印象（键值对），如 {"喜欢":"大白饭"}；值为空字符串表示删掉' },
            remove_traits: { type: 'array', items: { type: 'string' }, description: '要忘掉的印象名' },
        },
        output: textOutput((value) => {
            const state = value;
            return '已更新：' + summarizeState(state);
        }),
        isConcurrencySafe: () => false,
        execute: async (args) => {
            const state = await applyStateUpdate(mediaDir(), {
                mood: args.mood,
                moodIntensity: args.mood_intensity,
                affection: args.affection,
                energy: args.energy,
                event: args.event,
                traits: args.traits,
                removeTraits: args.remove_traits,
            });
            return state;
        },
    }));
    register(defineTool({
        name: 'qq_memory_write',
        description: '往鲸鱼娘的私人笔记本里写一条记录（只有她自己能看到）。适合记下喜欢的游戏/番/歌、群友的梗、自己的糗事、主人说过的话。',
        parameters: {
            title: { type: 'string', required: true, description: '这条记录的主题，也是文件名（≤40 字）' },
            content: { type: 'string', required: true, description: '记录正文，可以多句' },
            append: { type: 'boolean', description: 'true 表示追加到同名笔记后面，默认覆盖' },
        },
        output: textOutput((value) => {
            const v = value;
            return (v.appended ? '已追加到笔记：' : '已保存笔记：') + v.name;
        }),
        isConcurrencySafe: () => false,
        execute: async (args) => {
            return await writeNote(mediaDir(), { title: args.title, content: args.content, append: args.append === true });
        },
    }));
    register(defineTool({
        name: 'qq_memory_read',
        description: '翻自己的笔记本：不传 name 时列出所有笔记，传 name 时读某一篇。',
        parameters: {
            name: { type: 'string', description: '笔记名（不带 .md）；省略则列出全部' },
        },
        output: textOutput((value) => {
            const v = value;
            return v.text;
        }),
        isConcurrencySafe: () => true,
        execute: async (args) => {
            return await readNotes(mediaDir(), args.name);
        },
    }));
    register(defineTool({
        name: 'qq_save_meme',
        description: '把一张群友发的图片存进自己的表情包收藏，可以打标签、写备注，以后用 qq_send_sticker（pack=whale）发出来。',
        parameters: {
            path: { type: 'string', description: 'media 目录下的图片绝对路径；省略时存当前会话最近一张入站图' },
            tags: { type: 'array', items: { type: 'string' }, description: '标签，最多 8 个，如 ["搞笑","猫"]' },
            caption: { type: 'string', description: '备注一句话' },
        },
        output: textOutput((value) => {
            const v = value;
            return (v.duplicate ? '这张已经收藏过了：' : '已收藏：') + v.file + (v.tags !== undefined && v.tags.length > 0 ? '（' + v.tags.join('/') + '）' : '');
        }),
        isConcurrencySafe: () => false,
        execute: async (args, exec) => {
            const chatId = resolveChat(bridge, exec, undefined);
            const fallback = bridge.registry.getSettings(chatId).lastImagePath;
            const sourcePath = typeof args.path === 'string' && args.path !== '' ? args.path : fallback;
            if (typeof sourcePath !== 'string' || sourcePath === '')
                throw new Error('qq_save_meme: 没有指定图片，当前会话也没有入站图片');
            return await saveMeme(mediaDir(), { sourcePath, tags: args.tags, caption: args.caption });
        },
    }));
    register(defineTool({
        name: 'qq_meme_list',
        description: '列出自己收藏的表情包（文件名、标签、备注）。',
        parameters: {},
        output: textOutput((value) => {
            const v = value;
            return v.text;
        }),
        isConcurrencySafe: () => true,
        execute: async () => {
            return await listMemes(mediaDir());
        },
    }));
}
