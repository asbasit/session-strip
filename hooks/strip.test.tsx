import { expect, mock, test } from 'claude-code/testing'

const NOW = Date.parse('2026-11-07T12:00:00Z')
const iso = (ago: number) => new Date(NOW - ago * 60_000).toISOString()
const raw = (i: number, extra = {}) => ({
  sessionId: `local_${i}`,
  title: `Session ${i}`,
  isRunning: false,
  lastActivityAt: iso(i * 10),
  link: `claude://x/${i}`,
  ...extra,
})

const band = (bodyColumns: number) =>
  ({
    plugin: 'session-strip',
    component: 'AbovePrompt',
    requestId: 'band',
    props: {
      hasSurvey: false,
      isWorking: false,
      maxRows: 12,
      bodyColumns,
      scroll: { offset: 0, bodyRows: 11 },
      view: {},
    },
  }) as const

type Setup = {
  list: unknown[]
  scheduled?: string[]
  self?: Record<string, unknown>
  failFirst?: number
  ends?: string
}

function engine(on: any, setup: Setup) {
  const calls = { open: [] as string[][], lists: 0, limits: [] as number[] }
  let failures = setup.failFirst ?? 0

  on('session.start', (_: unknown, e: any) => ({ cwd: e.cwd }))
  on('env.get', () => ({ value: undefined }))
  on('process.run', (_: unknown, e: any) => {
    calls.open.push([...e.argv])
    return { value: { exitCode: 0, stdout: '', stderr: '' } }
  })
  on('mcp.call', (_: unknown, e: any) => {
    if (failures > 0) {
      failures -= 1
      return { value: { content: [{ type: 'text', text: 'no' }], isError: true } }
    }
    const text = (t: string) => ({ value: { content: [{ type: 'text', text: t }] } })
    if (e.tool === 'list_sessions') {
      calls.lists += 1
      calls.limits.push(e.args.limit)
      return text(JSON.stringify(setup.list) + (setup.ends ?? ''))
    }
    const id = e.args.session_id
    if (id === 'self') {
      return text(JSON.stringify({ sessionId: 'local_me', ...setup.self }))
    }
    const scheduledTaskId = setup.scheduled?.includes(id) ? 't1' : undefined
    return text(JSON.stringify({ sessionId: id, scheduledTaskId }))
  })

  return calls
}

const start = (surface: 'desktop' | 'terminal' = 'desktop') => ({
  cwd: '/',
  surface,
  isInteractive: true,
})

test('at each width: 12 sessions, grid sized, ages right', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on)
  const raws = Array.from({ length: 15 }, (_, i) => raw(i + 1))
  engine(on, { list: raws })
  await $.session.start(start())
  await clock.advance(1)

  for (const surface of ['terminal', 'desktop'] as const) {
    for (const width of [160, 100, 50, 20]) {
      const ui = await $.ui.mount({ ...band(width), surface })
      expect(await ui.find({ key: 'local_12' })).toBeDefined()
      expect(await ui.find({ key: 'local_13' })).toBeUndefined()
      expect((await ui.find({ type: 'Text', text: /^10m$/ }))?.text).toBe('10m')
      await ui.unmount()
    }
  }
})

test('a late session list is retried and never given up', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on)
  const calls = engine(on, { list: [raw(1)], failFirst: 3 })
  await $.session.start(start())
  await clock.advance(1) // fails at 0 s
  expect(calls.lists).toBe(0)
  await clock.advance(3_000) // fails at 3 s
  await clock.advance(12_000) // fails at 15 s
  expect(calls.lists).toBe(0)
  await clock.advance(60_000) // the first minute's tick works
  expect(calls.lists).toBe(1)

  const ui = await $.ui.mount({ ...band(120), surface: 'desktop' })
  expect(await ui.find({ key: 'local_1' })).toBeDefined()
  await ui.unmount()
})

test('the last known list is drawn before the list connects', async ($, on) => {
  mock.clock(on, { now: NOW })
  mock.store(on, {
    list: [{ id: 'local_7', title: 'Kept', at: NOW, dot: 'seen', link: 'x' }],
  })
  engine(on, { list: [], failFirst: 99 })
  await $.session.start(start())

  const ui = await $.ui.mount({ ...band(120), surface: 'desktop' })
  expect(await ui.find({ key: 'local_7' })).toBeDefined()
  await ui.unmount()
})

test('search reads names across every session', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on)
  const raws = Array.from({ length: 40 }, (_, i) => raw(i + 1))
  engine(on, { list: raws })
  await $.session.start(start())
  await clock.advance(1)

  const ui = await $.ui.mount({ ...band(120), surface: 'desktop' })
  await ui.input({ key: 'search', text: 'session 37', kind: 'change' })
  expect(await ui.find({ key: 'local_37' })).toBeDefined()
  expect(await ui.find({ key: 'local_1' })).toBeUndefined()
  await ui.input({ key: 'search', text: 'nothing', kind: 'change' })
  expect(await ui.find({ type: 'Text', text: /No session/ })).toBeDefined()
  await ui.unmount()
})

test('scheduled runs hide, side chats fold, ● leads', async ($, on) => {
  const clock = mock.clock(on, { now: NOW - 3_600_000 })
  mock.store(on, {
    since: NOW - 7_200_000,
    'typed/local_2': NOW,
  })
  engine(on, {
    list: [
      raw(1, { lastActivityAt: iso(0), startedBy: 'local_3' }),
      raw(2, { isRunning: true }),
      raw(3),
      raw(4, { lastActivityAt: iso(1) }),
    ],
    scheduled: ['local_4'],
  })
  await $.session.start(start())
  await clock.advance(1)

  const ui = await $.ui.mount({ ...band(120), surface: 'desktop' })
  expect(await ui.find({ key: 'local_1' })).toBeUndefined()
  expect(await ui.find({ key: 'local_4' })).toBeUndefined()
  expect((await ui.find({ type: 'Text', text: /Session 3/ }))?.text).toMatch(/^●/)
  expect((await ui.find({ type: 'Text', text: /Session 2/ }))?.text).toMatch(/^◐/)
  expect(await ui.find({ type: 'Text', text: /1 new/ })).toBeDefined()
  await ui.unmount()
})

test('a click opens the link and clears the dot', async ($, on) => {
  const clock = mock.clock(on, { now: NOW - 3_600_000 })
  mock.store(on, { since: NOW - 7_200_000 })
  const calls = engine(on, { list: [raw(1)] })
  await $.session.start(start())
  await clock.advance(1)

  const ui = await $.ui.mount({ ...band(120), surface: 'desktop' })
  await ui.press({ key: 'local_1' })
  expect(calls.open).toEqual([['open', 'claude://x/1']])
  expect((await ui.find({ type: 'Text', text: /Session 1/ }))?.text).toMatch(/^○/)
  await ui.unmount()
})

test('hide collapses and is remembered', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on)
  engine(on, { list: [raw(1)] })
  await $.session.start(start())
  await clock.advance(1)

  const ui = await $.ui.mount({ ...band(120), surface: 'desktop' })
  await ui.press({ key: 'hide' })
  expect(await ui.find({ key: 'local_1' })).toBeUndefined()
  await ui.unmount()

  await $.session.start(start())
  const again = await $.ui.mount({ ...band(120), surface: 'desktop' })
  expect(await again.find({ key: 'local_1' })).toBeUndefined()
  await again.press({ key: 'show' })
  expect(await again.find({ key: 'local_1' })).toBeDefined()
  await again.unmount()
})

test('a list cut by a trailing line still parses', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on)
  const calls = engine(on, { list: [raw(1)], ends: '\n\nShowing 1 of 9.' })
  await $.session.start(start())
  await clock.advance(1)

  expect(calls.limits).toEqual([2000])
})

test('a scheduled run does nothing', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on, {
    list: [{ id: 'local_7', title: 'Kept', at: NOW, dot: 'seen', link: 'x' }],
  })
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  const calls = engine(on, { list: [raw(1)], self: { scheduledTaskId: 't' } })
  await $.session.start(start())
  await clock.advance(1)
  await clock.advance(120_000)

  expect(calls.lists).toBe(0)
  const ui = await $.ui.mount({ ...band(120), surface: 'desktop' })
  expect(await ui.find({ key: 'hide' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /engine/ })).toBeDefined()
  await ui.unmount()
})
