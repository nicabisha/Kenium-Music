import { Cooldown } from '@slipher/cooldown'
import {
  Command,
  type CommandContext,
  createStringOption,
  Declare,
  Embed,
  Middlewares,
  Options
} from 'seyfert'
import { isExpiredInteraction } from '../shared/errorGuard.ts'
import { ensurePlayerForVoice, maybeStartPlayback } from '../shared/playback.ts'
import { resolveYoutube } from '../shared/ytdlp.ts'
import { getContextLanguage } from '../utils/i18n.ts'
import { safeDefer } from '../utils/interactions.ts'

type PlayTextLike = {
  player?: {
    noVoiceChannel?: string
    noTracksFound?: string
  }
  errors?: {
    general?: string
  }
}

const YOUTUBE_URL_RE =
  /^https?:\/\/(www\.|m\.|music\.)?(youtube\.com|youtu\.be)\//i
const URL_RE = /^https?:\/\//i

const options = {
  query: createStringOption({
    description: 'A YouTube URL or search query',
    required: true
  })
}

@Cooldown.user(1000 * 60, { uses: 3 })
@Declare({
  name: 'play',
  description: 'Play a song by YouTube URL or search query.'
})
@Options(options)
@Middlewares(['checkVoice'])
export default class Play extends Command {
  public override async run(ctx: CommandContext) {
    const lang = getContextLanguage(ctx)
    const t = ctx.t.get(lang) as unknown as PlayTextLike

    try {
      if (!(await safeDefer(ctx, true))) return

      const { query } = ctx.options as { query: string }

      const player = await ensurePlayerForVoice(ctx, ctx.channelId)
      if (!player) {
        await ctx.editOrReply({
          content:
            t.player?.noVoiceChannel ||
            'You must be in a voice channel to use this command.'
        })
        return
      }

      const queue = player.queue
      if (!queue || typeof queue.add !== 'function') {
        await ctx.editOrReply({
          content: t.errors?.general || 'An error occurred. Please try again.'
        })
        return
      }

      // Non-YouTube URLs (SoundCloud, direct audio) go straight to the HTTP source.
      if (URL_RE.test(query) && !YOUTUBE_URL_RE.test(query)) {
        const result = await ctx.client.aqua.resolve({
          query,
          requester: ctx.interaction.user
        })
        const track = result?.tracks?.[0]
        if (!track) {
          await ctx.editOrReply({
            content:
              t.player?.noTracksFound || 'No tracks found for the given URL.'
          })
          return
        }
        queue.add(track)
        await maybeStartPlayback(player)

        const title = track.title || 'Track'
        await ctx.editOrReply({
          embeds: [
            new Embed()
              .setDescription(`Added **${title}** to the queue.`)
              .setColor(0x100e09)
              .setTimestamp()
          ]
        })
        return
      }

      // YouTube URL or search query → yt-dlp.
      const resolved = await resolveYoutube(query)
      if (!resolved) {
        await ctx.editOrReply({
          content:
            t.player?.noTracksFound || 'No tracks found for the given query.'
        })
        return
      }

      const result = await ctx.client.aqua.resolve({
        query: resolved.filePath,
        requester: ctx.interaction.user
      })
      const track = result?.tracks?.[0]
      if (!track) {
        await ctx.editOrReply({
          content:
            t.player?.noTracksFound || 'No tracks found for the given query.'
        })
        return
      }

      if (resolved.title) track.title = resolved.title
      if (resolved.author) track.author = resolved.author
      if (resolved.duration) track.duration = resolved.duration * 1000
      if (resolved.webpageUrl) track.uri = resolved.webpageUrl
      if (resolved.thumbnail) track.artworkUrl = resolved.thumbnail

      queue.add(track)
      await maybeStartPlayback(player)

      const title = resolved.title || 'Track'
      const link = resolved.webpageUrl || query
      await ctx.editOrReply({
        embeds: [
          new Embed()
            .setDescription(`Added [**${title}**](${link}) to the queue.`)
            .setColor(0x100e09)
            .setTimestamp()
        ]
      })
    } catch (error: unknown) {
      if (isExpiredInteraction(error)) return
      console.error('[play] failed:', error)
      try {
        await ctx.editOrReply({
          content: t.errors?.general || 'An error occurred. Please try again.'
        })
      } catch (responseError) {
        if (isExpiredInteraction(responseError)) return
        console.error(responseError)
      }
    }
  }
}
