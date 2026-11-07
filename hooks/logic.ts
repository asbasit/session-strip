import type { Dot, Row } from '../types'

export const SHOWN = 12
export const FOUND = 30

export type Raw = {
  sessionId: string
  title?: string
  isRunning?: boolean
  starting?: boolean
  isArchived?: boolean
  lastActivityAt?: string
  link?: string
  startedBy?: string
  scheduledTaskId?: string
}

// The tool may add a line after the JSON, so read from the first [ to the last ].
export function parseList(text: string): Raw[] | undefined {
  if (text.startsWith('No other sessions')) return []
  try {
    const parsed: unknown = JSON.parse(
      text.slice(text.indexOf('['), text.lastIndexOf(']') + 1),
    )
    return Array.isArray(parsed) ? (parsed as Raw[]) : undefined
  } catch {
    return undefined
  }
}

export function timeOf(raw: Raw): number {
  const at = Date.parse(raw.lastActivityAt ?? '')
  return Number.isNaN(at) ? 0 : at
}

function rootOf(raw: Raw, byId: Map<string, Raw>): Raw {
  let at = raw
  const walked = new Set([at.sessionId])
  for (;;) {
    const parent = at.startedBy ? byId.get(at.startedBy) : undefined
    if (!parent || walked.has(parent.sessionId)) return at
    walked.add(parent.sessionId)
    at = parent
  }
}

const RANK: Record<Dot, number> = { seen: 0, new: 1, working: 2 }

// Side chats fold into their parent, which takes on their time and their dot.
export function fold(raws: readonly Raw[], dotOf: (raw: Raw) => Dot): Row[] {
  const byId = new Map(raws.map(raw => [raw.sessionId, raw]))
  const rows = new Map<string, Row>()

  for (const raw of raws) {
    const root = rootOf(raw, byId)
    const row = rows.get(root.sessionId) ?? {
      id: root.sessionId,
      title: root.title?.trim() || 'Untitled',
      at: 0,
      ...(root.link ? { link: root.link } : {}),
      dot: 'seen' as Dot,
    }
    const dot = dotOf(raw)
    row.at = Math.max(row.at, timeOf(raw))
    row.dot = RANK[dot] > RANK[row.dot] ? dot : row.dot
    rows.set(root.sessionId, row)
  }

  return [...rows.values()].sort(
    (a, b) =>
      Number(b.dot === 'new') - Number(a.dot === 'new') || b.at - a.at,
  )
}

export function matches(rows: readonly Row[], query: string): Row[] {
  const words = query.trim().toLowerCase()

  return words === ''
    ? rows.slice(0, SHOWN)
    : rows.filter(row => row.title.toLowerCase().includes(words))
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = 'Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec'.split(' ')

export function age(at: number, now: number): string {
  const minutes = Math.floor((now - at) / 60_000)
  const date = new Date(at)

  if (minutes < 1) return 'now'
  if (minutes < 60) return `${minutes}m`
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)}h`
  if (minutes < 7 * 24 * 60) return DAYS[date.getDay()] ?? ''

  return `${MONTHS[date.getMonth()]} ${date.getDate()}`
}

export function columnsFor(width: number): number {
  return Math.min(5, Math.max(1, Math.floor(width / 24)))
}

export function shorten(title: string, room: number): string {
  const line = title.replace(/\s+/g, ' ')

  return line.length <= room ? line : `${line.slice(0, Math.max(1, room - 1))}…`
}
