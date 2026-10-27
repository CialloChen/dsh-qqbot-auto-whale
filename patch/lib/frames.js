/**
 * Frame extraction for animated images and short videos. The model only takes
 * still images, so "reading" a GIF/WebP/MP4 means: probe it with ffprobe, cut
 * a handful of evenly spaced stills with ffmpeg, and hand those back as
 * separate image attachments. All process spawning is bounded by a timeout and
 * a maxBuffer; a missing ffmpeg degrades to "single first frame", never a
 * crash.
 * @module dsh-onebot/frames
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, open, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
const PROBE_TIMEOUT_MS = 15_000;
const FRAME_TIMEOUT_MS = 20_000;
const MAX_BUFFER = 8 * 1024 * 1024;
let resolvedTools;
function run(exe, args, timeout) {
    return new Promise((resolve, reject) => {
        execFile(exe, args, { timeout, maxBuffer: MAX_BUFFER, windowsHide: true }, (error, stdout, stderr) => {
            if (error !== null) {
                reject(new Error(String(error.message) + (stderr !== '' ? ' | ' + stderr.slice(0, 400) : '')));
                return;
            }
            resolve(stdout);
        });
    });
}
/** Locate ffmpeg/ffprobe: explicit env override, the .dsh tools dir, then PATH. */
export function configureTools(mediaDir) {
    const candidates = [];
    if (typeof process.env.DSH_QQBOT_FFMPEG === 'string' && process.env.DSH_QQBOT_FFMPEG !== '') {
        candidates.push(process.env.DSH_QQBOT_FFMPEG);
    }
    if (mediaDir !== '') {
        // <dsh-home>/tools/ffmpeg/bin/ffmpeg.exe when mediaDir is <dsh-home>/media/onebot
        candidates.push(join(mediaDir, '..', '..', 'tools', 'ffmpeg', 'bin', 'ffmpeg.exe'));
    }
    let found;
    for (const candidate of candidates) {
        if (existsSync(candidate)) {
            found = candidate;
            break;
        }
    }
    if (found === undefined) {
        resolvedTools = { ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' };
    }
    else {
        const sibling = join(dirname(found), 'ffprobe.exe');
        resolvedTools = { ffmpeg: found, ffprobe: existsSync(sibling) ? sibling : 'ffprobe' };
    }
    return resolvedTools;
}
function findTools() {
    if (resolvedTools === undefined)
        return configureTools('');
    return resolvedTools;
}
/** For tests/diagnostics: drop the cached ffmpeg paths. */
export function resetToolCache() {
    resolvedTools = undefined;
}
/**
 * Read the first bytes of a file to tell an animated image/video from a plain
 * still. Extension is deliberately ignored: inbound QQ media is often stored
 * under a default `.jpg` name whatever the real payload is.
 * @param path - local file to sniff.
 * @returns 'gif' | 'webp' | 'apng' | 'video' | 'static'.
 */
export async function sniffMedia(path) {
    let handle;
    try {
        handle = await open(path, 'r');
        const buffer = Buffer.alloc(16);
        const { bytesRead } = await handle.read(buffer, 0, 16, 0);
        if (bytesRead < 8)
            return 'static';
        const head = buffer.toString('latin1');
        if (head.startsWith('GIF87a') || head.startsWith('GIF89a'))
            return 'gif';
        if (head.startsWith('RIFF') && head.slice(8, 12) === 'WEBP') {
            const tail = await readSome(handle, 0, 4096);
            return tail.includes('ANIM') ? 'webp' : 'static';
        }
        if (head.startsWith('\x89PNG\r\n\x1a\n')) {
            const tail = await readSome(handle, 0, 4096);
            return tail.includes('acTL') ? 'apng' : 'static';
        }
        if (head.slice(4, 8) === 'ftyp')
            return 'video';
        if (buffer[0] === 0x1a && buffer[1] === 0x45 && buffer[2] === 0xdf && buffer[3] === 0xa3)
            return 'video';
    }
    catch {
        return 'static';
    }
    finally {
        await handle?.close().catch(() => undefined);
    }
    return 'static';
}
async function readSome(handle, position, length) {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, position);
    return buffer.toString('latin1', 0, bytesRead);
}
/** Probe duration and frame geometry; tolerates ffprobe's "N/A" strings. */
export async function probe(path) {
    const { ffprobe } = findTools();
    const raw = await run(ffprobe, [
        '-v', 'error',
        '-select_streams', 'v:0',
        '-show_entries', 'stream=width,height,avg_frame_rate,nb_frames',
        '-show_entries', 'format=duration',
        '-of', 'json',
        path,
    ], PROBE_TIMEOUT_MS);
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch {
        return { duration: 0, width: 0, height: 0, frames: 0 };
    }
    const stream = Array.isArray(parsed.streams) ? parsed.streams[0] ?? {} : {};
    const format = typeof parsed.format === 'object' && parsed.format !== null ? parsed.format : {};
    const duration = Number.parseFloat(String(format.duration ?? ''));
    const frames = Number.parseInt(String(stream.nb_frames ?? ''), 10);
    const width = Number.parseInt(String(stream.width ?? ''), 10);
    const height = Number.parseInt(String(stream.height ?? ''), 10);
    return {
        duration: Number.isFinite(duration) && duration > 0 ? duration : 0,
        width: Number.isFinite(width) ? width : 0,
        height: Number.isFinite(height) ? height : 0,
        frames: Number.isFinite(frames) && frames > 0 ? frames : 0,
    };
}
/** Choose how many stills to cut for a clip of this length. */
function frameCountFor(duration) {
    if (duration <= 0)
        return 4;
    return Math.max(2, Math.min(4, Math.ceil(duration * 1.5)));
}
/**
 * Cut evenly spaced stills out of an animated image or video.
 * @param path - source file (under the plugin media dir).
 * @param options - max frames and long-edge cap.
 * @returns still file paths with their timestamp in seconds (temp dir).
 */
export async function extractFrames(path, options = {}) {
    const maxFrames = Math.max(1, Math.min(options.maxFrames ?? 4, 6));
    const maxEdge = Math.max(64, Math.min(options.maxEdge ?? 512, 1024));
    const { ffmpeg } = findTools();
    const dir = await mkdtemp(join(tmpdir(), 'qqframes-'));
    const scale = 'scale=' + String(maxEdge) + ':-2';
    try {
        const info = await probe(path);
        const duration = info.duration;
        const count = Math.min(maxFrames, frameCountFor(duration));
        const frames = [];
        if (duration > 0) {
            for (let index = 0; index < count; index += 1) {
                const at = (duration * (index + 0.5)) / count;
                const out = join(dir, 'f' + String(index) + '.png');
                try {
                    await run(ffmpeg, [
                        '-v', 'error', '-y',
                        '-ss', at.toFixed(3),
                        '-i', path,
                        '-frames:v', '1',
                        '-vf', scale,
                        out,
                    ], FRAME_TIMEOUT_MS);
                }
                catch {
                    continue;
                }
                if (existsSync(out))
                    frames.push({ path: out, at });
            }
        }
        if (frames.length > 0)
            return { dir, frames, duration };
        // No usable duration (some GIF/WebP): dump every frame, then sample.
        await run(ffmpeg, ['-v', 'error', '-y', '-i', path, '-vsync', '0', '-vf', scale, join(dir, 'all_%04d.png')], FRAME_TIMEOUT_MS * 2);
        const files = (await readdir(dir)).filter((name) => name.startsWith('all_')).sort();
        const step = Math.max(1, Math.floor(files.length / count));
        const picked = [];
        for (let index = 0; index < files.length && picked.length < count; index += step) {
            picked.push(files[index]);
        }
        const total = files.length;
        return {
            dir,
            duration,
            frames: picked.map((name, index) => ({
                path: join(dir, name),
                at: total > 1 ? (index / Math.max(1, picked.length - 1)) * duration : 0,
            })),
        };
    }
    catch (error) {
        await rm(dir, { recursive: true, force: true }).catch(() => undefined);
        throw error;
    }
}
/**
 * 超大静图先缩到附件服务能接受的尺寸。
 *
 * 附件服务对单边和总像素都有硬上限（默认单边 8192、64MP），超了直接抛
 * IMAGE_DIMENSION_TOO_LARGE / IMAGE_TOO_MANY_PIXELS，表现为「读不了这张图」。
 * 这里在交给附件服务之前，用 ffmpeg 把它压到总像素预算内，避免整条读取失败。
 *
 * @param path - 原图路径。
 * @param options - maxPixels（默认 4MP）、maxEdge（默认 8192）。
 * @returns { path, temp, dir?, width?, height? }；没超限时 temp=false 且 path 不变。
 */
export async function normalizeStill(path, options = {}) {
    const maxPixels = Math.max(1, options.maxPixels ?? 4 * 1024 * 1024);
    const maxEdge = Math.max(64, options.maxEdge ?? 8192);
    const info = await probe(path).catch(() => ({ width: 0, height: 0, duration: 0, frames: 0 }));
    const width = info.width;
    const height = info.height;
    if (!(width > 0 && height > 0))
        return { path, temp: false };
    if (width * height <= maxPixels && Math.max(width, height) <= maxEdge)
        return { path, temp: false };
    const factor = Math.min(1, Math.sqrt(maxPixels / (width * height)), maxEdge / Math.max(width, height));
    const targetWidth = Math.max(2, Math.floor((width * factor) / 2) * 2);
    const targetHeight = Math.max(2, Math.floor((height * factor) / 2) * 2);
    const { ffmpeg } = findTools();
    const dir = await mkdtemp(join(tmpdir(), 'qqstill-'));
    const out = join(dir, 'normalized.png');
    try {
        await run(ffmpeg, [
            '-v', 'error', '-y',
            '-i', path,
            '-frames:v', '1',
            '-vf', 'scale=' + String(targetWidth) + ':' + String(targetHeight),
            out,
        ], FRAME_TIMEOUT_MS);
        if (!existsSync(out)) {
            await rm(dir, { recursive: true, force: true }).catch(() => undefined);
            return { path, temp: false };
        }
        return { path: out, temp: true, dir, width: targetWidth, height: targetHeight };
    }
    catch {
        await rm(dir, { recursive: true, force: true }).catch(() => undefined);
        return { path, temp: false };
    }
}
/** Delete a frame scratch dir produced by {@link extractFrames}. */
export async function cleanupFrames(dir) {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
}
/** Whether ffmpeg/ffprobe can actually be spawned (used to degrade gracefully). */
export async function toolsAvailable() {
    try {
        const { ffmpeg } = findTools();
        await run(ffmpeg, ['-version'], 5_000);
        return true;
    }
    catch {
        return false;
    }
}
