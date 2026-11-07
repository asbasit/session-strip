import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Dot, Row } from '../types'
import {
  FOUND,
  age,
  columnsFor,
  fold,
  matches,
  parseList,
  shorten,
  timeOf,
} from './logic'
import type { Raw } from './logic'

const SERVER = 'ccd_session_mgmt'
const LIMITS = [2000, 500, 100, 20]
const LOOKUPS = 40
const STORED_ROWS = 200

const rows = atom({ plugin: 'session-strip', key: 'rows' } as const, [] as Row[])
const now = atom({ plugin: 'session-strip', key: 'now' } as const, 0)
const query = atom({ plugin: 'session-strip', key: 'query' } as const, '')
const isHidden = atom({ plugin: 'session-strip', key: 'isHidden' } as const, false)
const isOff = atom({ plugin: 'session-strip', key: 'isOff' } as const, false)

const GLYPH: Record<Dot, string> = { working: '◐', new: '●', seen: '○' }

async function callText(
  $: EngineInterface,
  tool: string,
  args: Record<string, unknown>,
): Promise<string> {
  const result = await $.mcp.call(SERVER, tool, args)
  if (result.isError) throw new Error(`${tool} failed`)

  return (result.content ?? [])
    .map(block => (block.type === 'text' ? block.text : ''))
    .join('')
}

async function listSessions($: EngineInterface): Promise<Raw[]> {
  for (const limit of LIMITS) {
    const parsed = parseList(await callText($, 'list_sessions', { limit }))
    if (parsed) return parsed
  }
  throw new Error('list_sessions could not be read')
}

async function detail(
  $: EngineInterface,
  id: string,
): Promise<{ sessionId?: string; scheduledTaskId?: string }> {
  return JSON.parse(await callText($, 'get_session', { session_id: id }))
}

// list_sessions leaves out scheduledTaskId, so each session is asked once,
// and the answer kept: a session never changes which kind it is.
async function scheduledIds(
  $: EngineInterface,
  raws: readonly Raw[],
): Promise<Set<string>> {
  const known = ((await $.store.get('kinds')) ?? {}) as Record<string, boolean>
  const unknown = raws
    .filter(raw => known[raw.sessionId] === undefined)
    .slice(0, LOOKUPS)

  for (let i = 0; i < unknown.length; i += 8) {
    await Promise.all(
      unknown.slice(i, i + 8).map(async raw => {
        const found = await detail($, raw.sessionId).catch(() => undefined)
        if (found) known[raw.sessionId] = Boolean(found.scheduledTaskId)
      }),
    )
  }
  if (unknown.length > 0) await $.store.set('kinds', known)

  return new Set(
    raws
      .filter(raw => raw.scheduledTaskId || known[raw.sessionId])
      .map(raw => raw.sessionId),
  )
}

async function dotsFor(
  $: EngineInterface,
  raws: readonly Raw[],
  since: number,
): Promise<Map<string, Dot>> {
  const dots = new Map<string, Dot>()

  await Promise.all(
    raws.map(async raw => {
      const id = raw.sessionId
      if (raw.isRunning || raw.starting) return void dots.set(id, 'working')
      if (timeOf(raw) <= since) return void dots.set(id, 'seen')

      const marks = await Promise.all(
        ['typed', 'seen', 'opened'].map(kind => $.store.get(`${kind}/${id}`)),
      )
      const last = Math.max(since, ...marks.map(mark => Number(mark ?? 0)))
      dots.set(id, timeOf(raw) > last ? 'new' : 'seen')
    }),
  )

  return dots
}

async function openSession($: EngineInterface, row: Row): Promise<void> {
  if (!row.link) return void $.ui.toast('This session has no link to open.')

  const isWindows = (await $.env.get('OS')) === 'Windows_NT'
  const argv = isWindows
    ? ['cmd', '/c', 'start', '', row.link]
    : ['open', row.link]
  const { exitCode } = await $.process.run(argv)
  if (exitCode !== 0) $.ui.toast(`Could not open ${row.title}.`)
}

let self: string | undefined
let typedAt: number | undefined
let seenAt = 0
let isRefreshing = false
let timers: { cancel: () => void }[] = []

async function stop($: EngineInterface): Promise<void> {
  timers.forEach(timer => timer.cancel())
  timers = []
  await update($, isOff, () => true)
}

async function flushTyped($: EngineInterface): Promise<void> {
  if (self === undefined || typedAt === undefined) return
  await $.store.set(`typed/${self}`, typedAt)
  typedAt = undefined
}

async function refresh($: EngineInterface): Promise<void> {
  if (isRefreshing || (await read($, isOff))) return
  isRefreshing = true

  try {
    if (self === undefined) {
      const found = await detail($, 'self')
      if (found.scheduledTaskId) return await stop($)
      self = found.sessionId
    }
    await flushTyped($)

    const time = await $.clock.now()
    const since = Number((await $.store.get('since')) ?? time)
    await $.store.set('since', since)

    const listed = (await listSessions($)).filter(
      raw => raw.sessionId !== self && !raw.isArchived,
    )
    const scheduled = await scheduledIds($, listed)
    const raws = listed.filter(raw => !scheduled.has(raw.sessionId))
    const dots = await dotsFor($, raws, since)
    const next = fold(raws, raw => dots.get(raw.sessionId) ?? 'seen')

    await update($, rows, () => next)
    await update($, now, () => time)
    await $.store.set('list', next.slice(0, STORED_ROWS))
  } catch (error) {
    // Not connected yet, most often: the next tick tries again.
    $.ui.log(`session-strip: ${String(error)}`, { to: 'debug' })
  } finally {
    isRefreshing = false
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)

    if ((await $.env.get('CLAUDE_CODE_SESSION_ATTENDED')) === '0') {
      await update($, isOff, () => true)
      return started
    }

    const stored = (await $.store.get('list')) as Row[] | undefined
    if (Array.isArray(stored)) await update($, rows, () => stored)
    await update($, isHidden, () => false)
    if ((await $.store.get('hidden')) === true) {
      await update($, isHidden, () => true)
    }
    const time = await $.clock.now()
    await update($, now, () => time)

    timers = [0, 3_000, 15_000].map(ms =>
      $.clock.after(ms, () => void refresh($)),
    )
    timers.push($.clock.every(60_000, () => void refresh($)))

    return started
  })

  on('prompt.submit', async ($, e, next) => {
    if (!e.isMeta && !(await read($, isOff))) {
      typedAt = await $.clock.now()
      await flushTyped($)
    }

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    void refresh($)

    return result
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (await read($, isOff)) return next(e)

    // Being drawn is being on screen: the app draws the session in view.
    const time = await $.clock.now()
    if (self !== undefined && time - seenAt >= 5_000) {
      seenAt = time
      void $.store.set(`seen/${self}`, time).catch(() => undefined)
    }

    const all = await read($, rows)
    if (e.props.hasSurvey || all.length === 0) return next(e)
    if (e.surface !== 'terminal' && e.surface !== 'desktop') return next(e)

    const { Box, Button, Input, Text } = $.ui.resolve(e)
    const newCount = all.filter(row => row.dot === 'new').length
    const heading = `Recent · ${newCount} new`

    const setHidden = async (value: boolean) => {
      await update($, isHidden, () => value)
      await $.store.set('hidden', value)
    }

    if (await read($, isHidden)) {
      return (
        <Box flexDirection="row" columnGap={1}>
          <Text dimColor size="caption">{heading}</Text>
          <Button key="show" plain onPress={() => setHidden(false)}>
            <Text dimColor size="caption">show</Text>
          </Button>
        </Box>
      )
    }

    const searched = await read($, query)
    const found = matches(all, searched)
    const visible = found.slice(0, FOUND)
    const moment = (await read($, now)) || time
    const open = (row: Row) => async () => {
      await $.store.set(`opened/${row.id}`, await $.clock.now())
      await update($, rows, held =>
        (held ?? []).map(item =>
          item.id === row.id && item.dot === 'new'
            ? { ...item, dot: 'seen' as Dot }
            : item,
        ),
      )
      await openSession($, row)
    }

    const columns = columnsFor(e.props.bodyColumns)
    const cellWidth = Math.floor(e.props.bodyColumns / columns)
    const lines: Row[][] = []
    for (let i = 0; i < visible.length; i += columns) {
      lines.push(visible.slice(i, i + columns))
    }

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" columnGap={1} alignItems="center">
          <Text dimColor size="caption">{heading}</Text>
          <Box flexGrow={1}>
            <Input
              key="search"
              placeholder="Search names"
              value={searched}
              onInput={value => update($, query, () => value)}
              onSubmit={() => {
                const first = found[0]
                return first ? open(first)() : undefined
              }}
            />
          </Box>
          <Button key="hide" plain onPress={() => setHidden(true)}>
            <Text dimColor size="caption">hide</Text>
          </Button>
        </Box>
        {lines.map(line => (
          <Box key={line[0]?.id} flexDirection="row">
            {line.map(row => {
              const when = age(row.at, moment)
              const room = cellWidth - when.length - 4

              return (
                <Box
                  key={`cell-${row.id}`}
                  width={`${Math.floor(100 / columns)}%`}
                  flexDirection="row"
                  justifyContent="space-between"
                  paddingRight={1}
                >
                  <Button key={row.id} plain onPress={open(row)}>
                    <Text size="caption" dimColor={row.dot === 'seen'}>
                      {GLYPH[row.dot]} {shorten(row.title, room)}
                    </Text>
                  </Button>
                  <Text dimColor size="caption">{when}</Text>
                </Box>
              )
            })}
          </Box>
        ))}
        {visible.length === 0 ? (
          <Text dimColor size="caption">No session has that name.</Text>
        ) : null}
        {found.length > visible.length ? (
          <Text dimColor size="caption">
            {found.length - visible.length} more match
          </Text>
        ) : null}
      </Box>
    )
  })
}
