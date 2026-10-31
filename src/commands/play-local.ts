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
  description: 'Queue a local playlist (m3u/m3u8) from disk.'
})
@Options({
  file: createAttachmentOption({
    description: 'The m3u/m3u8 playlist to queue',
    required: true
  }),
  base: createStringOption({
    description: 'Music folder used to resolve relative paths (optional)',
    required: false
  })
})
@Middlewares(['cooldown', 'checkVoice'])
export default class PlayLocal extends Command {
  public override async run(ctx: CommandContext) {
    try {
      if (!(await safeDefer(ctx, true))) return

      const { file, base } = ctx.options as {
        file: { url: string; size?: number }
        base?: string
      }
      const baseDir = base?.trim() || undefined

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
          if (added.length > 0) successCount++
          else failCount++
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
          : 'Could not queue the local playlist. Please try again.'
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
