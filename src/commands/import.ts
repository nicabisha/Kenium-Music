import { Cooldown } from '@slipher/cooldown'
import {
  Command,
  type CommandContext,
  createAttachmentOption,
  Declare,
  Embed,
  Middlewares,
  Options
} from 'seyfert'
import { isExpiredInteraction } from '../shared/errorGuard.ts'
import { fetchImportFile, ImportFileError } from '../shared/importFile.ts'
import { maybeStartPlayback } from '../shared/playback.ts'
import {
  buildTrackResolveQueries,
  type PlaylistFileTrack,
  parsePlaylistFile
} from '../shared/playlist_format.ts'
import { getContextLanguage } from '../utils/i18n.ts'
import { safeDefer } from '../utils/interactions.ts'

@Cooldown.user(1000 * 60, { uses: 2 })

@Declare({
  name: 'import',
  description: 'Import a queue from a file (txt, pdf)'
})
@Options({
  file: createAttachmentOption({
    description: 'The file to import',
    required: true
  })
})
@Middlewares(['checkVoice', 'cooldown', 'checkPlayer'])
export default class importcmds extends Command {
  public override async run(ctx: CommandContext): Promise<void> {
    try {
      if (!(await safeDefer(ctx, true))) return

      const { client } = ctx
      const lang = getContextLanguage(ctx)
      const t = ctx.t.get(lang)
      const { file } = ctx.options as {
        file: { url: string; size?: number }
      }
      const fileContent = await fetchImportFile(file)

      if (!fileContent.trim()) {
        await ctx.editOrReply({
          embeds: [
            new Embed()
              .setDescription(t?.import?.emptyFile || '❌ The file is empty')
              .setColor(0xff0000)
          ]
        })
        return
      }
      if (!ctx.guildId) return
      const player = client.aqua.players.get(ctx.guildId)
      if (!player) return

      const parsed = parsePlaylistFile(fileContent, 'Kenium Queue')
      const tracks =
        parsed?.tracks
          .filter((track) => buildTrackResolveQueries(track).length)
          .filter(Boolean) || []

      if (tracks.length === 0) {
        await ctx.editOrReply({
          embeds: [
            new Embed()
              .setDescription(
                t?.import?.noValidTracks ||
                  '❌ No valid tracks found in the file'
              )
              .setColor(0xff0000)
          ]
        })
        return
      }

      const importingText =
        t?.import?.importing?.replace('{count}', tracks.length.toString()) ||
        `🎵 Importing ${tracks.length} tracks...`

      const embed = new Embed().setDescription(importingText).setColor(0x00ff00)

      await ctx.editOrReply({ embeds: [embed], flags: 64 })

      const batchSize = Math.min(
        10,
        Math.max(3, Math.floor(tracks.length / 20))
      )
      let successCount = 0
      let failCount = 0

      for (let i = 0; i < tracks.length; i += batchSize) {
        const batch = tracks.slice(i, i + batchSize)

        const results = await Promise.allSettled(
          batch.map(async (track: PlaylistFileTrack) => {
            for (const query of buildTrackResolveQueries(track)) {
              const result = await client.aqua.resolve({
                query,
                requester: ctx.interaction.user,
                ...(query.startsWith('isrc:') ? { source: 'spsearch' } : {})
              })

              if (result?.tracks?.[0]) {
                await player.queue.add(result.tracks[0])
                return true
              }
            }
            return false
          })
        )

        results.forEach((result) => {
          if (result.status === 'fulfilled' && result.value) {
            successCount++
          } else {
            failCount++
          }
        })

        if (i + batchSize < tracks.length) {
          const delay = Math.max(
            50,
            200 - (successCount / (successCount + failCount)) * 150
          )
          await new Promise((resolve) => setTimeout(resolve, delay))
        }
      }

      const started = await maybeStartPlayback(player)

      const completeTitle = t?.import?.complete || '🔥 Import Complete'
      const successText =
        t?.import?.successfullyImported?.replace(
          '{count}',
          successCount.toString()
        ) || `✅ Successfully imported: **${successCount}** tracks`
      const failText =
        failCount > 0
          ? t?.import?.failedToImport?.replace(
              '{count}',
              failCount.toString()
            ) || `❌ Failed to import: **${failCount}** tracks`
          : ''
      const totalText =
        t?.import?.totalQueueSize?.replace(
          '{count}',
          player.queue.length.toString()
        ) || `🎵 Total queue size: **${player.queue.length}** tracks`

      const autoStartNote =
        !started && !player.playing && !player.paused && player.queue.length > 0
          ? '⚠️ Queued but could not auto-start — use /play to begin.'
          : ''
      const description = [successText, failText, totalText, autoStartNote]
        .filter(Boolean)
        .join('\n')

      const resultEmbed = new Embed()
        .setTitle(completeTitle)
        .setDescription(description)
        .setColor(0x100e09)
        .setTimestamp()

      await ctx.editOrReply({ embeds: [resultEmbed], flags: 64 })
    } catch (error: unknown) {
      if (isExpiredInteraction(error)) return
      console.error('[import] failed:', error)
      const message =
        error instanceof ImportFileError
          ? error.message
          : 'The file could not be imported. Please try again.'
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
