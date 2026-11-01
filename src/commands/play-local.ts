import { existsSync } from 'node:fs'
import path from 'node:path'
import { Cooldown } from '@slipher/cooldown'
import {
  Command,
  type CommandContext,
  createAttachmentOption,
  createStringOption,
  Declare,
  Embed,
  Middlewares,
  Options
} from 'seyfert'
import { isExpiredInteraction } from '../shared/errorGuard.ts'
import { fetchImportFile, ImportFileError } from '../shared/importFile.ts'
import { parseM3u } from '../shared/m3u.ts'
import {
  ensurePlayerForVoice,
  maybeStartPlayback,
  resolveAndQueue
} from '../shared/playback.ts'
import { safeDefer } from '../utils/interactions.ts'

const PLAYLIST_RE = /\.m3u8?$/i

const isAbsolutePath = (value: string): boolean =>
  /^[A-Za-z]:[\\/]/.test(value) ||
  value.startsWith('\\\\') ||
  value.startsWith('//')

const resolvePath = (value: string, base?: string): string | null => {
  if (isAbsolutePath(value)) return value
  if (base) return path.join(base, value)
  return null
}

@Cooldown.user(1000 * 60, { uses: 2 })
@Declare({
  name: 'play-local',
  description: 'Play a local file or a local playlist (m3u/m3u8) from disk.'
})
@Options({
  file: createAttachmentOption({
    description: 'The audio file or m3u/m3u8 playlist to play',
    required: true
  }),
  base: createStringOption({
    description:
      'Music folder used to resolve relative playlist paths (optional)',
    required: false
  })
})
@Middlewares(['cooldown', 'checkVoice'])
export default class PlayLocal extends Command {
  public override async run(ctx: CommandContext) {
    try {
      if (!(await safeDefer(ctx, true))) return

      const { file, base } = ctx.options as {
        file: { url: string; filename?: string; size?: number }
        base?: string
      }
      const baseDir = base?.trim() || undefined

      const player = await ensurePlayerForVoice(ctx, ctx.channelId)
      if (!player) {
        await ctx.editOrReply({
          embeds: [
            new Embed()
              .setDescription(
                'You must be in a voice channel to use this command.'
              )
              .setColor(0xff0000)
          ],
          flags: 64
        })
        return
      }

      // Single audio file → play via the HTTP source.
      if (!PLAYLIST_RE.test(file.filename ?? '')) {
        try {
          const { added } = await resolveAndQueue({
            client: ctx.client,
            player,
            query: file.url,
            requester: ctx.interaction.user
          })
          if (!added.length) {
            await ctx.editOrReply({
              embeds: [
                new Embed()
                  .setDescription('❌ Could not load that file.')
                  .setColor(0xff0000)
              ],
              flags: 64
            })
            return
          }
          await maybeStartPlayback(player)
          await ctx.editOrReply({
            embeds: [
              new Embed()
                .setDescription('✅ Added the file to the queue.')
                .setColor(0x100e09)
            ],
            flags: 64
          })
        } catch (error) {
          console.error('[play-local] file failed:', error)
          await ctx.editOrReply({
            embeds: [
              new Embed()
                .setDescription('❌ Could not play that file.')
                .setColor(0xff0000)
            ],
            flags: 64
          })
        }
        return
      }

      // Playlist file → parse m3u and play local disk files.
      const entries = parseM3u(await fetchImportFile(file))
      if (entries.length === 0) {
        await ctx.editOrReply({
          embeds: [
            new Embed()
              .setDescription('❌ No tracks found in the playlist file.')
              .setColor(0xff0000)
          ],
          flags: 64
        })
        return
      }

      let successCount = 0
      let failCount = 0
      let relativeSkipped = 0

      for (const entry of entries) {
        const resolved = resolvePath(entry.path, baseDir)
        if (!resolved) {
          relativeSkipped++
          continue
        }
        if (!existsSync(resolved)) {
          failCount++
          continue
        }
        try {
          const { added } = await resolveAndQueue({
            client: ctx.client,
            player,
            query: resolved,
            requester: ctx.interaction.user
          })
          if (added.length > 0) {
            const track = added[0] as
              | { title?: string; author?: string }
              | undefined
            if (track) {
              const isUnknown = (value?: string) =>
                !value || value.toLowerCase().startsWith('unknown')
              if (isUnknown(track.title) && entry.title)
                track.title = entry.title
              if (isUnknown(track.author) && entry.author)
                track.author = entry.author
            }
            successCount++
          } else {
            failCount++
          }
        } catch {
          failCount++
        }
      }

      const started = await maybeStartPlayback(player)

      const description = [
        `✅ Queued: **${successCount}** tracks`,
        failCount > 0 ? `❌ Failed: **${failCount}** tracks` : '',
        relativeSkipped > 0
          ? `⚠️ Skipped **${relativeSkipped}** relative path(s) — export absolute paths or pass a \`base\` folder.`
          : '',
        !started &&
        !player.playing &&
        !player.paused &&
        (player.queue?.size ?? 0) > 0
          ? '⚠️ Queued but could not auto-start — use /play to begin.'
          : ''
      ]
        .filter(Boolean)
        .join('\n')

      await ctx.editOrReply({
        embeds: [
          new Embed()
            .setTitle('🎵 Local Playlist')
            .setDescription(description)
            .setColor(0x100e09)
            .setTimestamp()
        ],
        flags: 64
      })
    } catch (error: unknown) {
      if (isExpiredInteraction(error)) return
      console.error('[play-local] failed:', error)
      const message =
        error instanceof ImportFileError
          ? error.message
          : 'Could not play that file. Please try again.'
      try {
        await ctx.editOrReply({
          embeds: [
            new Embed().setDescription(`❌ ${message}`).setColor(0xff0000)
          ],
          flags: 64
        })
      } catch (responseError) {
        if (isExpiredInteraction(responseError)) return
        throw responseError
      }
    }
  }
}
