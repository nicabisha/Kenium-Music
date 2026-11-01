import { spawn } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  unlinkSync
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export type YoutubeResolveResult = {
  filePath: string
  title?: string
  author?: string
  duration?: number
  webpageUrl?: string
  thumbnail?: string
}

const YT_DLP_PATH = process.env.YT_DLP_PATH || 'yt-dlp'
const JS_RUNTIME = process.env.YT_DLP_JS_RUNTIME || 'node'
const DOWNLOAD_DIR = path.join(os.tmpdir(), 'kenium-youtube')
const MAX_FILE_AGE_MS = 60 * 60 * 1000
const YOUTUBE_URL_RE =
  /^https?:\/\/(www\.|m\.|music\.)?(youtube\.com|youtu\.be)\//i

const toNumber = (value: string | undefined): number | undefined => {
  if (!value) return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

const runYtDlp = (args: string[]): Promise<string> =>
  new Promise((resolve, reject) => {
    const child = spawn(YT_DLP_PATH, args, { windowsHide: true })
    let stdout = ''
    let stderr = ''
    const timeout = setTimeout(() => child.kill(), 120_000)

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })
    child.on('error', (error) => {
      clearTimeout(timeout)
      reject(error)
    })
    child.on('close', (code) => {
      clearTimeout(timeout)
      if (code === 0) resolve(stdout)
      else reject(new Error(stderr.trim() || `yt-dlp exited with code ${code}`))
    })
  })

const cleanupOldDownloads = () => {
  try {
    mkdirSync(DOWNLOAD_DIR, { recursive: true })
    const now = Date.now()
    for (const name of readdirSync(DOWNLOAD_DIR)) {
      const file = path.join(DOWNLOAD_DIR, name)
      try {
        if (now - statSync(file).mtimeMs > MAX_FILE_AGE_MS) unlinkSync(file)
      } catch {
        // ignore individual file cleanup errors
      }
    }
  } catch {
    // ignore directory errors
  }
}

export async function resolveYoutube(
  query: string
): Promise<YoutubeResolveResult | null> {
  cleanupOldDownloads()
  try {
    mkdirSync(DOWNLOAD_DIR, { recursive: true })
  } catch {
    return null
  }

  const input = YOUTUBE_URL_RE.test(query)
    ? query
    : `https://music.youtube.com/search?q=${encodeURIComponent(query)}`

  // Step 1: fetch metadata. `--print` implies simulate, so nothing is downloaded.
  const meta = await runYtDlp([
    input,
    '--print',
    '%(id)s',
    '--print',
    '%(title)s',
    '--print',
    '%(uploader)s',
    '--print',
    '%(duration)s',
    '--print',
    '%(webpage_url)s',
    '--print',
    '%(thumbnail)s',
    '--js-runtimes',
    JS_RUNTIME,
    '--playlist-items',
    '1',
    '--no-warnings'
  ]).catch((error: unknown) => {
    console.error('[ytdlp] metadata failed:', error)
    return null
  })

  if (!meta) return null

  const lines = meta
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  const id = lines[0]
  const webpageUrl = lines[4]
  const thumbnail = lines[5]
  if (!id) return null

  const filePath = path.join(DOWNLOAD_DIR, `${id}.m4a`)

  // Step 2: download the audio (plain -o, no --print).
  try {
    await runYtDlp([
      webpageUrl || input,
      '-f',
      'bestaudio[ext=m4a]/bestaudio',
      '-o',
      filePath,
      '--js-runtimes',
      JS_RUNTIME,
      '--no-playlist',
      '--no-warnings'
    ])
  } catch (error) {
    console.error('[ytdlp] download failed:', error)
    return null
  }

  if (!existsSync(filePath)) {
    console.error('[ytdlp] download produced no file:', filePath)
    return null
  }

  return {
    filePath,
    title: lines[1] || undefined,
    author: lines[2] || undefined,
    duration: toNumber(lines[3]),
    webpageUrl: webpageUrl || undefined,
    thumbnail: thumbnail || undefined
  }
}
