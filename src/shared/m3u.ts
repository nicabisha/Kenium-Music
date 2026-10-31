export type M3uEntry = {
  path: string
  title?: string
  author?: string
  duration?: number
}

const EXTINF_RE = /^#EXTINF:\s*(-?\d+(?:\.\d+)?)\s*,\s*(.*)$/

const splitTitleAuthor = (
  label: string
): { title?: string; author?: string } => {
  const trimmed = label.trim()
  if (!trimmed) return {}
  const separator = trimmed.indexOf(' - ')
  if (separator > 0) {
    return {
      author: trimmed.slice(0, separator).trim(),
      title: trimmed.slice(separator + 3).trim()
    }
  }
  return { title: trimmed }
}

export function parseM3u(content: string): M3uEntry[] {
  const entries: M3uEntry[] = []
  let pending: { duration?: number; title?: string; author?: string } | null =
    null

  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue

    if (line.startsWith('#')) {
      if (line.startsWith('#EXTINF:')) {
        const match = EXTINF_RE.exec(line)
        if (match) {
          const seconds = Number(match[1])
          const { title, author } = splitTitleAuthor(match[2] ?? '')
          pending = {
            ...(Number.isFinite(seconds) && seconds >= 0
              ? { duration: seconds }
              : {}),
            ...(title ? { title } : {}),
            ...(author ? { author } : {})
          }
        }
      }
      continue
    }

    entries.push({
      path: line,
      ...(pending?.duration !== undefined
        ? { duration: pending.duration }
        : {}),
      ...(pending?.title ? { title: pending.title } : {}),
      ...(pending?.author ? { author: pending.author } : {})
    })
    pending = null
  }

  return entries
}
