import type { AgentInfo, FoundElement, On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const PANE_PROPS = {
  title: 'Agent Hub',
  isFocused: false,
  bodyColumns: 80,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 20 },
  view: {},
} as const

// The engine beneath the plugin: a roster the test sets, and turn events
// that end at the test's own bottom.
function engine(on: On) {
  const roster: { list: AgentInfo[] } = { list: [] }
  on('agent.list', () => ({ value: roster.list }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('session.measure', (_$, e) => ({ changed: e.changed ?? [] }))
  const clock = mock.clock(on, { now: 1_000_000 })

  return { roster, clock }
}

// The innermost Text showing `text`: `find` matches by inclusion and so
// returns the row before the run of it that carries the style.
async function leaf(ui: { findAll: (query: { type: string; text: string }) => Promise<FoundElement[]> }, text: string) {
  const found = await ui.findAll({ type: 'Text', text })

  return found.find(one => !one.children.some(child => typeof child === 'object' && child !== null && JSON.stringify(child).includes(text)))
}

// The session's start as the engine raises it before any prompt: the pane's
// tick, which moves the clock it draws and reads the shells' logs, runs from
// there. Its hooks go in with the test's own; the returned call starts it.
function starts(on: On) {
  on('command.register', () => ({ value: undefined }) as never)
  on('ui.open', () => ({ value: undefined }) as never)
  on('session.start', (_$, e) => ({ cwd: e.cwd }))

  return ($: { session: { start: (e: never) => Promise<unknown> } }) =>
    $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true } as never)
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`the pane follows a subagent from start to end (${surface})`, async ($, on) => {
    const { roster, clock } = engine(on)
    const ui = await $.ui.mount({
      plugin: 'agent-hub',
      surface,
      component: 'Pane',
      requestId: 'agent-hub',
      props: PANE_PROPS,
    })
    expect(await ui.find({ type: 'Text', text: 'Subagents: 0 running · 0 done' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '█▙▟█▐█▗▄▖█▛▀ █▛██▌ ▐█   ▐█▀█▌█▌▐█▐█▀█▖' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '▝▜█████▛▘' })).toBeDefined()

    roster.list = [{ id: 'a1', type: 'Explore', description: 'map the routes', status: 'running' }]
    await $.turn.start({ text: 'Find the routes', turnId: 't1', agentId: 'a1' })
    await clock.settle()
    expect(await ui.find({ type: 'Text', text: 'Explore' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '1 running · 0 done' })).toBeDefined()

    await clock.advance(42_000)
    roster.list = [{ id: 'a1', type: 'Explore', description: 'map the routes', status: 'completed' }]
    await $.turn.complete({ answer: 'done', durationMs: 42_000, isAborted: false, turnId: 't1', agentId: 'a1', reason: 'answer' })
    await clock.settle()
    expect(await ui.find({ type: 'Text', text: '0 running · 1 done' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '0 tools · done' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '0:42' })).toBeDefined()

    await ui.unmount()
  })
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`an agent's tool calls show under it with their status (${surface})`, async ($, on) => {
    const { roster, clock } = engine(on)
    let release = () => {}
    on('tool.call', async (_$, e) => {
      if (String(e.tool) === 'Grep') await new Promise<void>(resolve => (release = resolve))

      return String(e.tool) === 'Bash'
        ? { result: {}, text: 'Error: Cannot find module vitest', isError: true }
        : { result: {}, text: 'ok' }
    })
    const ui = await $.ui.mount({
      plugin: 'agent-hub',
      surface,
      component: 'Pane',
      requestId: 'agent-hub',
      props: PANE_PROPS,
    })
    roster.list = [{ id: 'a1', type: 'Explore', description: 'map the routes', status: 'running' }]
    await $.turn.start({ text: 'Find the routes', turnId: 't1', agentId: 'a1' })

    // A subagent's call carries its loop's id, which a plugin's own call never sets.
    const call = (args: object) => $.tool.call({ ...args, agentId: 'a1' } as never)
    await call({ tool: 'Bash', command: 'npm test -- route' })
    const grep = call({ tool: 'Grep', pattern: 'navigate(' })
    await clock.settle()

    expect(await ui.find({ type: 'Text', text: 'Cannot find module vitest' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '"navigate("' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '2 tools · 1 error' })).toBeDefined()

    release()
    await grep
    await clock.settle()
    const grepLine = await ui.find({ type: 'Text', text: 'Grep' })
    expect(grepLine?.props.dimColor).toBe(true)

    await ui.unmount()
  })
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`enter on a card opens its steps by turn, b goes back (${surface})`, async ($, on) => {
    const { roster, clock } = engine(on)
    on('tool.call', (_$, e) =>
      String(e.tool) === 'Bash'
        ? { result: {}, text: 'Error: Cannot find module vitest', isError: true }
        : { result: {}, text: 'ok' },
    )
    roster.list = [
      { id: 'a1', type: 'Explore', description: 'map the routes', status: 'running' },
      { id: 'c1', type: 'general-purpose', description: 'write the tests', status: 'running', parentId: 'a1' },
    ]
    await $.turn.start({ text: 'Find where routes are defined', turnId: 't1', agentId: 'a1' })
    await $.tool.call({ tool: 'Glob', pattern: 'src/**/route*.ts', agentId: 'a1' } as never)
    await $.tool.call({ tool: 'Bash', command: 'npm test', agentId: 'a1' } as never)
    await $.turn.start({ text: 'Write the tests', turnId: 'tc', agentId: 'c1' })
    await clock.settle()
    const ui = await $.ui.mount({
      plugin: 'agent-hub',
      surface,
      component: 'Pane',
      requestId: 'agent-hub',
      props: PANE_PROPS,
    })

    await ui.press({ key: 'open:a1' })
    expect(await ui.find({ key: 'back' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Find where routes are defined' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^Turn 1 · running/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'src/**/route*.ts' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '└ Error: Cannot find module vitest' })).toBeDefined()

    await ui.press({ key: 'child:c1' })
    expect(await ui.find({ type: 'Text', text: 'Write the tests' })).toBeDefined()
    expect(await ui.find({ key: 'child:c1' })).toBeUndefined()

    await ui.press({ key: 'back' })
    expect(await ui.find({ key: 'open:a1' })).toBeDefined()
    expect(await ui.find({ key: 'open:c1' })).toBeDefined()

    await ui.unmount()
  })
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`an agent's plan and tokens show on its card and in detail (${surface})`, async ($, on) => {
    const { roster, clock } = engine(on)
    on('tool.call', () => ({ result: {}, text: 'ok' }))
    roster.list = [{ id: 'a1', type: 'Explore', description: 'map the routes', status: 'running' }]
    await $.turn.start({ text: 'Find the routes', turnId: 't1', agentId: 'a1' })
    await $.tool.call({
      tool: 'TodoWrite',
      todos: [
        { content: 'Find route files', status: 'completed', activeForm: 'Finding route files' },
        { content: 'Read the callers', status: 'in_progress', activeForm: 'Reading the callers' },
      ],
      agentId: 'a1',
    } as never)
    await clock.settle()
    const ui = await $.ui.mount({
      plugin: 'agent-hub',
      surface,
      component: 'Pane',
      requestId: 'agent-hub',
      props: PANE_PROPS,
    })
    expect(await ui.find({ type: 'Text', text: '1 tool · ☑ 1/2' })).toBeDefined()

    await ui.press({ key: 'open:a1' })
    expect(await ui.find({ type: 'Text', text: 'Read the callers' })).toBeDefined()
    expect((await leaf(ui, 'Read the callers'))?.props.bold).toBe(true)

    await ui.press({ key: 'back' })
    await $.turn.complete({
      answer: 'done',
      durationMs: 5000,
      isAborted: false,
      turnId: 't1',
      agentId: 'a1',
      reason: 'answer',
      usage: {
        input_tokens: 2000,
        output_tokens: 1100,
        cache_read_input_tokens: 10_000,
        cache_creation_input_tokens: 300,
        model: 'claude-sonnet-5-5',
      },
    })
    await clock.settle()
    expect(await ui.find({ type: 'Text', text: '13k tok' })).toBeDefined()

    await ui.press({ key: 'open:a1' })
    expect(await ui.find({ type: 'Text', text: /12k in \(\s*10k cached\) · 1\.1k out · claude-sonnet-5-5/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Read the callers' })).toBeDefined()

    await ui.unmount()
  })
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`v puts the agent's transcript in the main view and back (${surface})`, async ($, on) => {
    const { roster, clock } = engine(on)
    const asked: { agentId?: string }[] = []
    on('ui.view', (_$, e) => {
      asked.push(e)

      return { value: {} }
    })
    roster.list = [{ id: 'a1', type: 'Explore', description: 'map the routes', status: 'running' }]
    await $.turn.start({ text: 'Find the routes', turnId: 't1', agentId: 'a1' })
    await clock.settle()
    const mount = (view: { agentId?: string }) =>
      $.ui.mount({ plugin: 'agent-hub', surface, component: 'Pane', requestId: 'agent-hub', props: { ...PANE_PROPS, view } })

    const ui = await mount({})
    await ui.press({ key: 'open:a1' })
    expect((await ui.find({ key: 'view' }))?.props.label).toBe('view transcript')
    await ui.press({ key: 'view' })
    expect(asked).toEqual([{ agentId: 'a1' }])
    await ui.unmount()

    // The main view now shows the agent. The pane, still on its detail, offers the way back.
    const viewing = await mount({ agentId: 'a1' })
    expect((await viewing.find({ key: 'view' }))?.props.label).toBe('main conversation')
    expect(await viewing.find({ type: 'Text', text: 'what you type now goes to it' })).toBeDefined()
    await viewing.press({ key: 'view' })
    expect(asked).toEqual([{ agentId: 'a1' }, {}])

    // The list says whose transcript is up, with its own way back.
    await viewing.press({ key: 'back' })
    expect(await viewing.find({ type: 'Text', text: "Viewing Explore's transcript" })).toBeDefined()
    await viewing.press({ key: 'main' })
    expect(asked).toEqual([{ agentId: 'a1' }, {}, {}])
    await viewing.unmount()
  })
}

test('a view the engine refuses says why in a toast', async ($, on) => {
  const { roster, clock } = engine(on)
  const toasts: string[] = []
  on('ui.view', () => ({ value: { deny: 'no agent holds the id' } }))
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)

    return { value: undefined }
  })
  roster.list = [{ id: 'a1', type: 'Explore', description: 'map the routes', status: 'running' }]
  await $.turn.start({ text: 'go', turnId: 't1', agentId: 'a1' })
  await clock.settle()
  const ui = await $.ui.mount({
    plugin: 'agent-hub',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'agent-hub',
    props: PANE_PROPS,
  })
  await ui.press({ key: 'open:a1' })
  await ui.press({ key: 'view' })

  expect(toasts).toEqual(['Agent Hub: no agent holds the id'])
})

for (const surface of ['terminal', 'desktop'] as const) {
  test(`a message typed in the detail goes to the agent and the field empties (${surface})`, async ($, on) => {
    const { roster, clock } = engine(on)
    const sent: { to: string; text: string }[] = []
    on('session.send', (_$, e) => {
      sent.push({ to: e.to, text: e.text })

      return { isDelivered: true }
    })
    roster.list = [{ id: 'a1', type: 'Explore', description: 'map the routes', status: 'running' }]
    await $.turn.start({ text: 'go', turnId: 't1', agentId: 'a1' })
    await clock.settle()
    const ui = await $.ui.mount({ plugin: 'agent-hub', surface, component: 'Pane', requestId: 'agent-hub', props: PANE_PROPS })
    await ui.press({ key: 'open:a1' })

    await ui.input({ key: 'msg:0', text: '  also check src/text  ' })
    expect(sent).toEqual([{ to: 'a1', text: 'also check src/text' }])
    expect(await ui.find({ key: 'msg:0' })).toBeUndefined()
    expect(await ui.find({ key: 'msg:1' })).toBeDefined()

    await ui.input({ key: 'msg:1', text: '   ' })
    expect(sent).toHaveLength(1)

    await ui.unmount()
  })

  test(`stop asks once, then stops the agent's task (${surface})`, async ($, on) => {
    const { roster, clock } = engine(on)
    const stopped: unknown[] = []
    on('tool.call', (_$, e) => {
      if (String(e.tool) === 'TaskStop') stopped.push((e as { task_id?: string }).task_id)

      return { result: {}, text: 'ok' }
    })
    roster.list = [{ id: 'a1', type: 'Explore', description: 'map the routes', status: 'running' }]
    await $.turn.start({ text: 'go', turnId: 't1', agentId: 'a1' })
    await clock.settle()
    const ui = await $.ui.mount({ plugin: 'agent-hub', surface, component: 'Pane', requestId: 'agent-hub', props: PANE_PROPS })
    await ui.press({ key: 'open:a1' })

    await ui.press({ key: 'stop' })
    expect(stopped).toEqual([])
    expect((await ui.find({ key: 'stop' }))?.props.label).toBe('press s again to stop')

    // The question lapses after a few seconds.
    await clock.advance(3500)
    expect((await ui.find({ key: 'stop' }))?.props.label).toBe('stop agent')

    await ui.press({ key: 'stop' })
    await ui.press({ key: 'stop' })
    expect(stopped).toEqual(['a1'])

    await ui.unmount()
  })
}

test('a stop the engine refuses says why, and ended agents offer neither stop nor message', async ($, on) => {
  const { roster, clock } = engine(on)
  const toasts: string[] = []
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)

    return { value: undefined }
  })
  on('tool.call', () => ({ result: {}, text: 'No task found with ID: a1', isError: true }))
  roster.list = [
    { id: 'a1', type: 'Explore', description: 'map the routes', status: 'running' },
    { id: 'a2', type: 'Plan', description: 'design', status: 'completed' },
  ]
  await $.turn.start({ text: 'go', turnId: 't1', agentId: 'a1' })
  await clock.settle()
  const ui = await $.ui.mount({ plugin: 'agent-hub', surface: 'terminal', component: 'Pane', requestId: 'agent-hub', props: PANE_PROPS })
  await ui.press({ key: 'open:a1' })
  await ui.press({ key: 'stop' })
  await ui.press({ key: 'stop' })
  expect(toasts).toEqual(['Agent Hub: could not stop Explore: No task found with ID: a1'])

  await ui.press({ key: 'back' })
  await ui.press({ key: 'open:a2' })
  expect(await ui.find({ key: 'stop' })).toBeUndefined()
  expect(await ui.find({ key: 'msg:0' })).toBeUndefined()
})

for (const surface of ['terminal', 'desktop'] as const) {
  test(`a running agent lists its latest steps, a finished one folds; e toggles (${surface})`, async ($, on) => {
    const { roster, clock } = engine(on)
    on('tool.call', () => ({ result: {}, text: 'ok' }))
    roster.list = [
      { id: 'a1', type: 'Explore', description: 'map the routes', status: 'running' },
      { id: 'a2', type: 'Plan', description: 'design', status: 'running' },
    ]
    await $.turn.start({ text: 'go', turnId: 't1', agentId: 'a1' })
    await $.turn.start({ text: 'go', turnId: 't2', agentId: 'a2' })
    for (let i = 0; i < 11; i += 1) await $.tool.call({ tool: 'Read', file_path: `src/file${i}.ts`, agentId: 'a1' } as never)
    await $.tool.call({ tool: 'Read', file_path: 'docs/design.md', agentId: 'a2' } as never)
    roster.list = [
      { id: 'a1', type: 'Explore', description: 'map the routes', status: 'running' },
      { id: 'a2', type: 'Plan', description: 'design', status: 'completed' },
    ]
    await $.turn.complete({
      answer: 'done', durationMs: 9000, isAborted: false, turnId: 't2', agentId: 'a2', reason: 'answer',
      usage: { input_tokens: 4000, output_tokens: 1000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: 'claude-sonnet-5-5' },
    })
    await clock.settle()
    const ui = await $.ui.mount({ plugin: 'agent-hub', surface, component: 'Pane', requestId: 'agent-hub', props: PANE_PROPS })

    expect(await ui.find({ type: 'Text', text: ' · 12 tools · 5.0k tok' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'src/file10.ts' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'src/file8.ts' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'src/file7.ts' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: '… 8 earlier steps · enter: all' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'docs/design.md' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: '1 tool · done' })).toBeDefined()

    await ui.press({ key: 'expand' })
    expect(await ui.find({ type: 'Text', text: 'src/file8.ts' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: 'src/file10.ts' })).toBeDefined()
    expect((await ui.find({ key: 'expand' }))?.props.label).toBe('expand')

    await ui.unmount()
  })
}

test('tokens move with each model step, the session cost and stuck agents show', async ($, on) => {
  const { roster, clock } = engine(on)
  const start = starts(on)
  on('turn.step', async function* (_$, e) {
    return {
      turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn',
      usage: { input_tokens: 3000, output_tokens: 500, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: 'claude-sonnet-5-5' },
    } as never
  })
  roster.list = [{ id: 'a1', type: 'Explore', description: 'map the routes', status: 'running' }]
  await $.turn.start({ text: 'go', turnId: 't1', agentId: 'a1' })
  const steps = $.turn.step({ turnId: 't1', index: 0, model: 'claude-sonnet-5-5', messageCount: 1, agentId: 'a1' } as never)
  for await (const _chunk of steps as AsyncIterable<unknown>) {
    // the stream passes through untouched
  }
  await $.session.measure({ context: { window: 1_000_000 }, rateLimits: [], cost: { usd: 1.234 }, changed: ['cost'] } as never)
  await start($)
  await clock.settle()
  const ui = await $.ui.mount({ plugin: 'agent-hub', surface: 'terminal', component: 'Pane', requestId: 'agent-hub', props: PANE_PROPS })

  expect(await ui.find({ type: 'Text', text: '3.5k tok' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: ' · 3.5k tok · session $1.23' })).toBeDefined()

  await clock.advance(130_000)
  expect(await ui.find({ type: 'Text', text: '⚠ no tool call for 2:10' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: ' · ⚠ 1 may be stuck' })).toBeDefined()
})

test('the list keeps to the latest prompt’s agents; a slash command starts no task; a shows all', async ($, on) => {
  const { roster, clock } = engine(on)
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  const finish = async (id: string, turnId: string) => {
    await $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId, agentId: id, reason: 'answer' })
  }

  await $.prompt.submit({ text: 'survey the ui' } as never)
  roster.list = [{ id: 'old', type: 'Explore', description: 'survey the ui', status: 'running' }]
  await $.turn.start({ text: 'go', turnId: 't1', agentId: 'old' })
  roster.list = [{ id: 'old', type: 'Explore', description: 'survey the ui', status: 'completed' }]
  await finish('old', 't1')

  await $.prompt.submit({ text: 'now the game folder' } as never)
  roster.list = [
    { id: 'old', type: 'Explore', description: 'survey the ui', status: 'completed' },
    { id: 'new', type: 'Plan', description: 'read the game folder', status: 'running' },
  ]
  await $.turn.start({ text: 'go', turnId: 't2', agentId: 'new' })
  await $.prompt.submit({ text: '/agent-hub', command: { name: 'agent-hub', args: '' } } as never)
  await clock.settle()

  const ui = await $.ui.mount({ plugin: 'agent-hub', surface: 'terminal', component: 'Pane', requestId: 'agent-hub', props: PANE_PROPS })
  expect(await ui.find({ type: 'Text', text: 'Subagents: 1 running · 0 done' })).toBeDefined()
  expect(await ui.find({ key: 'open:new' })).toBeDefined()
  expect(await ui.find({ key: 'open:old' })).toBeUndefined()
  expect((await ui.find({ key: 'all' }))?.props.label).toBe('all (+1)')

  await ui.press({ key: 'all' })
  expect(await ui.find({ type: 'Text', text: 'All subagents: 1 running · 1 done' })).toBeDefined()
  expect(await ui.find({ key: 'open:old' })).toBeDefined()

  await ui.press({ key: 'all' })
  expect(await ui.find({ key: 'open:old' })).toBeUndefined()
})

test('a card is one Button holding the whole card, wrapped to a narrow pane', async ($, on) => {
  const { roster, clock } = engine(on)
  roster.list = [{ id: 'a1', type: 'general-purpose', description: 'Stuck check 2: loop then failures', status: 'running' }]
  await $.turn.start({ text: 'go', turnId: 't1', agentId: 'a1' })
  await clock.settle()
  const ui = await $.ui.mount({
    plugin: 'agent-hub',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'agent-hub',
    props: { ...PANE_PROPS, bodyColumns: 30 },
  })

  const button = await ui.find({ type: 'Button', key: 'open:a1' })
  expect(button?.text).toContain('general-purpose')
  expect(button?.text).toContain('Stuck check 2')
  expect(button?.text).toContain('╰')
  const top = (button?.text ?? '').split('\n')[0] ?? ''
  expect(top.startsWith('╭─ ● general-purpose ')).toBe(true)
  expect(top.endsWith(' 0:00 ─╮')).toBe(true)
  expect(button?.text).toContain('failures')
  expect(button?.text?.replace('starting…', '')).not.toContain('…')
  for (const cardLine of (button?.text ?? '').split('\n')) expect(cardLine.length).toBe(30)
})

test('the main conversation’s checklist shows as Tasks above Subagents', async ($, on) => {
  const { clock } = engine(on)
  let next = 0
  on('tool.call', (_$, e) =>
    String(e.tool) === 'TaskCreate'
      ? { result: { task: { id: String((next += 1)), subject: (e as { subject: string }).subject } }, text: 'ok' }
      : { result: { success: true }, text: 'ok' },
  )
  await $.tool.call({ tool: 'TaskCreate', subject: 'Plan the pane', description: '' } as never)
  await $.tool.call({ tool: 'TaskCreate', subject: 'Build it', description: '', activeForm: 'Building it' } as never)
  await $.tool.call({ tool: 'TaskUpdate', taskId: '1', status: 'completed' } as never)
  await $.tool.call({ tool: 'TaskUpdate', taskId: '2', status: 'in_progress' } as never)
  await clock.settle()
  const ui = await $.ui.mount({ plugin: 'agent-hub', surface: 'terminal', component: 'Pane', requestId: 'agent-hub', props: PANE_PROPS })

  expect(await ui.find({ type: 'Text', text: 'Tasks: 1 in progress · 1 done' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /✳ Building it…/ })).toBeDefined()
  expect((await leaf(ui, 'Build it'))?.props.bold).toBe(true)
  expect((await leaf(ui, 'Plan the pane'))?.props.strikethrough).toBe(true)
  expect(await ui.find({ type: 'Text', text: '✔' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '■' })).toBeDefined()

  await $.tool.call({ tool: 'TaskUpdate', taskId: '2', status: 'completed' } as never)
  await clock.settle()
  expect(await ui.find({ type: 'Text', text: 'Tasks: 2 done' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Plan the pane' })).toBeUndefined()
})

test('the main conversation’s calls are logged under the task in progress, folded when it is done', async ($, on) => {
  const { clock } = engine(on)
  let next = 0
  on('tool.call', (_$, e) =>
    String(e.tool) === 'TaskCreate'
      ? { result: { task: { id: String((next += 1)), subject: (e as { subject: string }).subject } }, text: 'ok' }
      : String(e.tool) === 'Bash'
        ? { result: {}, text: 'Error: tests failed', isError: true }
        : { result: { success: true }, text: 'ok' },
  )
  const call = (args: object) => $.tool.call(args as never)
  await call({ tool: 'Read', file_path: 'before.ts' })
  await call({ tool: 'TaskCreate', subject: 'Wire the pane', description: '' })
  await call({ tool: 'TaskUpdate', taskId: '1', status: 'in_progress' })
  await call({ tool: 'Read', file_path: 'src/route.ts' })
  await call({ tool: 'Bash', command: 'npm test' })
  await clock.settle()
  const ui = await $.ui.mount({ plugin: 'agent-hub', surface: 'terminal', component: 'Pane', requestId: 'agent-hub', props: PANE_PROPS })

  expect(await ui.find({ type: 'Text', text: 'src/route.ts' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'npm test — Error: tests failed' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'before.ts' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: 'Wire the pane' })).toBeDefined()

  await call({ tool: 'TaskCreate', subject: 'Next', description: '' })
  await call({ tool: 'TaskUpdate', taskId: '1', status: 'completed' })
  await clock.settle()
  expect(await ui.find({ type: 'Text', text: 'src/route.ts' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: '2 tools · 1 error' })).toBeDefined()
})

test('a subagent’s own checklist shows inside its card, in the Tasks style', async ($, on) => {
  const { roster, clock } = engine(on)
  on('tool.call', () => ({ result: {}, text: 'ok' }))
  roster.list = [{ id: 'a1', type: 'general-purpose', description: 'map the routes', status: 'running' }]
  await $.turn.start({ text: 'go', turnId: 't1', agentId: 'a1' })
  await $.tool.call({
    tool: 'TodoWrite',
    todos: [
      { content: 'Find route files', status: 'completed', activeForm: 'Finding route files' },
      { content: 'Read the callers', status: 'in_progress', activeForm: 'Reading the callers' },
      { content: 'Summarize', status: 'pending', activeForm: 'Summarizing' },
    ],
    agentId: 'a1',
  } as never)
  await clock.settle()
  const ui = await $.ui.mount({ plugin: 'agent-hub', surface: 'terminal', component: 'Pane', requestId: 'agent-hub', props: PANE_PROPS })

  const card = (await ui.find({ type: 'Button', key: 'open:a1' }))?.text ?? ''
  expect(card).toContain('Tasks: 1 in progress · 1 pending · 1 done')
  expect(card).toContain('✳ Reading the callers…')
  expect(card).toContain('⎿ ✔ Find route files')
  expect(card).toContain('■ Read the callers')
  expect(card).toContain('□ Summarize')
})

test('a subagent’s checklist written through the mod’s own tool shows in its card', async ($, on) => {
  const { roster, clock } = engine(on)
  roster.list = [{ id: 'a1', type: 'general-purpose', description: 'survey the world folder', status: 'running' }]
  await $.turn.start({ text: 'go', turnId: 't1', agentId: 'a1' })
  const ran = await $.tool.call({
    tool: 'mcp__agent-hub__checklist',
    todos: [
      { content: 'List the folder', status: 'completed' },
      { content: 'Read the layout file', status: 'in_progress', activeForm: 'Reading the layout file' },
    ],
    agentId: 'a1',
  } as never)
  expect(ran.text).toBe('Checklist saved (2 items); the person sees it in the Agent Hub pane.')
  await clock.settle()
  const ui = await $.ui.mount({ plugin: 'agent-hub', surface: 'terminal', component: 'Pane', requestId: 'agent-hub', props: PANE_PROPS })

  const card = (await ui.find({ type: 'Button', key: 'open:a1' }))?.text ?? ''
  expect(card).toContain('Tasks: 1 in progress · 1 done')
  expect(card).toContain('✳ Reading the layout file…')
})

test('an agent that ended with an item open shows it not done, none in progress', async ($, on) => {
  const { roster, clock } = engine(on)
  roster.list = [{ id: 'a1', type: 'Explore', description: 'list the exports', status: 'running' }]
  await $.turn.start({ text: 'go', turnId: 't1', agentId: 'a1' })
  await $.tool.call({
    tool: 'mcp__agent-hub__checklist',
    todos: [
      { content: 'Read the file', status: 'completed' },
      { content: 'Report back', status: 'in_progress', activeForm: 'Reporting back' },
    ],
    agentId: 'a1',
  } as never)
  roster.list = [{ id: 'a1', type: 'Explore', description: 'list the exports', status: 'completed' }]
  await $.turn.complete({ answer: 'done', durationMs: 1000, isAborted: false, turnId: 't1', agentId: 'a1', reason: 'answer' })
  await clock.settle()
  const ui = await $.ui.mount({ plugin: 'agent-hub', surface: 'terminal', component: 'Pane', requestId: 'agent-hub', props: PANE_PROPS })
  await ui.press({ key: 'open:a1' })

  expect(await ui.find({ type: 'Text', text: 'Tasks: 1 not done · 1 done' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /in progress/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /Reporting back/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: '□' })).toBeDefined()
})

test('the focus ring starts on the first card, not on a toggle', async ($, on) => {
  const { roster, clock } = engine(on)
  roster.list = [
    { id: 'a1', type: 'Explore', description: 'first', status: 'running' },
    { id: 'a2', type: 'Plan', description: 'second', status: 'running' },
  ]
  await $.turn.start({ text: 'go', turnId: 't1', agentId: 'a1' })
  await $.turn.start({ text: 'go', turnId: 't2', agentId: 'a2' })
  await clock.settle()
  const ui = await $.ui.mount({ plugin: 'agent-hub', surface: 'terminal', component: 'Pane', requestId: 'agent-hub', props: PANE_PROPS })

  const focused = (await ui.findAll({ type: 'Button' })).filter(one => one.props.autoFocus === true)
  expect(focused.map(one => one.key)).toEqual(['open:a1'])
})

test('in a card, the calls since an item began sit under it, aligned with the other items', async ($, on) => {
  const { roster, clock } = engine(on)
  on('tool.call', () => ({ result: {}, text: 'ok' }))
  roster.list = [{ id: 'a1', type: 'general-purpose', description: 'survey the text folder', status: 'running' }]
  await $.turn.start({ text: 'go', turnId: 't1', agentId: 'a1' })
  const checklist = (first: string, second: string) =>
    $.tool.call({
      tool: 'mcp__agent-hub__checklist',
      todos: [
        { content: 'List the text folder', status: first, activeForm: 'Listing the text folder' },
        { content: 'Read the map file', status: second, activeForm: 'Reading the map file' },
      ],
      agentId: 'a1',
    } as never)
  await checklist('in_progress', 'pending')
  await $.tool.call({ tool: 'Bash', command: 'ls src/text', agentId: 'a1' } as never)
  await clock.advance(1000)
  await checklist('completed', 'in_progress')
  await $.tool.call({ tool: 'Read', file_path: 'src/text/map.ts', agentId: 'a1' } as never)
  await clock.settle()
  const ui = await $.ui.mount({ plugin: 'agent-hub', surface: 'terminal', component: 'Pane', requestId: 'agent-hub', props: PANE_PROPS })

  const rows = ((await ui.find({ type: 'Button', key: 'open:a1' }))?.text ?? '').split('\n')
  const at = (needle: string) => rows.findIndex(one => one.includes(needle))
  expect(rows[at('✔ List the text folder')]).toContain('│ ⎿ ✔ List the text folder')
  expect(rows[at('■ Read the map file')]).toContain('│   ■ Read the map file')
  expect(at('src/text/map.ts')).toBe(at('■ Read the map file') + 1)
  expect(at('ls src/text')).toBe(-1)

  // Compact keeps the latest call, still under its item.
  await ui.press({ key: 'expand' })
  const compact = ((await ui.find({ type: 'Button', key: 'open:a1' }))?.text ?? '').split('\n')
  const where = (needle: string) => compact.findIndex(one => one.includes(needle))
  expect(where('src/text/map.ts')).toBe(where('■ Read the map file') + 1)
})

test('the context bar fills the pane width in proportion to the window', async ($, on) => {
  const { clock } = engine(on)
  await $.session.measure({ context: { tokens: 230_000, window: 1_000_000, percent: 23 }, rateLimits: [], changed: ['context'] } as never)
  await clock.settle()
  const ui = await $.ui.mount({ plugin: 'agent-hub', surface: 'terminal', component: 'Pane', requestId: 'agent-hub', props: PANE_PROPS })

  expect(await ui.find({ type: 'Text', text: 'Context: 23%' })).toBeDefined()
  expect((await ui.find({ type: 'Text', text: /^Context$/ }))?.props.color).toBe('claude')
  expect(await ui.find({ type: 'Text', text: ' · 230k / 1.0M tok' })).toBeDefined()
  // 23% of an 80-column pane: 18 solid orange cells, the rest shaded.
  expect((await ui.find({ type: 'Text', text: /^█{18}$/ }))?.props.color).toBe('claude')
  expect(await ui.find({ type: 'Text', text: '░'.repeat(62) })).toBeDefined()
})

test('the main conversation’s cache hit and countdown sit under the context bar', async ($, on) => {
  const { clock } = engine(on)
  const start = starts(on)
  on('turn.step', async function* (_$, e) {
    return {
      turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn',
      usage: { input_tokens: 800, output_tokens: 50, cache_read_input_tokens: 9000, cache_creation_input_tokens: 200, model: 'claude-sonnet-5-5' },
    } as never
  })
  // The countdown moves with the pane's tick, which session.start sets going.
  await start($)
  await $.session.measure({ context: { tokens: 230_000, window: 1_000_000, percent: 23 }, rateLimits: [], changed: ['context'] } as never)
  const ui = await $.ui.mount({ plugin: 'agent-hub', surface: 'terminal', component: 'Pane', requestId: 'agent-hub', props: PANE_PROPS })
  expect(await ui.find({ type: 'Text', text: /^Cache/ })).toBeUndefined()

  const steps = $.turn.step({ turnId: 't1', index: 0, model: 'claude-sonnet-5-5', messageCount: 1 } as never)
  for await (const _chunk of steps as AsyncIterable<unknown>) {
    // the stream passes through untouched
  }
  await clock.settle()
  await clock.advance(1_000)
  expect(await ui.find({ type: 'Text', text: 'Cache: 90% hit' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: ' · ↻ 4:59' })).toBeDefined()

  await clock.advance(300_000)
  expect(await ui.find({ type: 'Text', text: ' · expired' })).toBeDefined()
})

test('the rate-limit windows are drawn five hours first, names and reset marks in orange', async ($, on) => {
  const { clock } = engine(on)
  const resetsAt = (hours: number) => new Date(1_000_000 + hours * 3_600_000).toISOString()
  await $.session.measure({
    context: { tokens: 230_000, window: 1_000_000, percent: 23 },
    rateLimits: [
      { kind: 'seven_day', percentUsed: 85, resetsAt: resetsAt(72) },
      { kind: 'five_hour', percentUsed: 40, resetsAt: resetsAt(2) },
    ],
    changed: ['context', 'rateLimits'],
  } as never)
  await clock.settle()
  const ui = await $.ui.mount({ plugin: 'agent-hub', surface: 'terminal', component: 'Pane', requestId: 'agent-hub', props: PANE_PROPS })

  expect(await ui.find({ type: 'Text', text: /^5h 40% · ↻ \d\d:\d\d   7d 85% · ↻ [A-Z][a-z]{2} \d\d:\d\d$/ })).toBeDefined()
  expect((await ui.find({ type: 'Text', text: /^5h$/ }))?.props.color).toBe('claude')
  expect((await ui.find({ type: 'Text', text: /^   7d$/ }))?.props.color).toBe('claude')
  expect((await ui.find({ type: 'Text', text: /^↻$/ }))?.props.color).toBe('claude')
  // Figures only: a window nearly used up reads as any other.
  expect((await ui.find({ type: 'Text', text: /^85%$/ }))?.props).toEqual({ bold: true })
})

test('the windows share one line at the pane foot', async ($, on) => {
  const { clock } = engine(on)
  const resetsAt = (hours: number) => new Date(1_000_000 + hours * 3_600_000).toISOString()
  await $.session.measure({
    context: { tokens: 230_000, window: 1_000_000, percent: 23 },
    rateLimits: [
      { kind: 'five_hour', percentUsed: 40, resetsAt: resetsAt(2) },
      { kind: 'seven_day', percentUsed: 12, resetsAt: resetsAt(72) },
    ],
    changed: ['context', 'rateLimits'],
  } as never)
  await clock.settle()
  const ui = await $.ui.mount({ plugin: 'agent-hub', surface: 'terminal', component: 'Pane', requestId: 'agent-hub', props: PANE_PROPS })

  expect(await ui.find({ type: 'Text', text: /^Context: 23% · 230k \/ 1\.0M tok$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^5h 40% · ↻ \d\d:\d\d   7d 12% · ↻ [A-Z][a-z]{2} \d\d:\d\d$/ })).toBeDefined()
  // Below the subagents, at the foot.
  const texts = (await ui.findAll({ type: 'Text' })).map(found => found.text)
  expect(texts.findIndex(text => text.startsWith('5h '))).toBeGreaterThan(texts.findIndex(text => text.startsWith('Subagents')))
})

test('no rate-limit window, no figure for one', async ($, on) => {
  const { clock } = engine(on)
  await $.session.measure({ context: { tokens: 230_000, window: 1_000_000, percent: 23 }, rateLimits: [], changed: ['context'] } as never)
  await clock.settle()
  const ui = await $.ui.mount({ plugin: 'agent-hub', surface: 'terminal', component: 'Pane', requestId: 'agent-hub', props: PANE_PROPS })

  expect(await ui.find({ type: 'Text', text: 'Context: 23%' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /↻/ })).toBeUndefined()
})

test('the pane asks for room when it opens', async ($, on) => {
  engine(on)
  const opened: unknown[] = []
  on('ui.open', (_$, e) => {
    opened.push(e)

    return { value: { isPlaced: true } }
  })
  on('command.register', () => ({ value: { command: 'agent-hub' } }))
  await $.command.run({ command: 'agent-hub', args: '' } as never)

  expect(opened).toEqual([{ id: 'agent-hub', title: 'Agent Hub', focus: true, columns: 80, rows: 32 }])
})

test('the main loop’s own tool calls add nothing', async ($, on) => {
  const { clock } = engine(on)
  on('tool.call', () => ({ result: {}, text: 'ok' }))
  await $.tool.call({ tool: 'Read', file_path: 'README.md' } as never)
  await clock.settle()
  const ui = await $.ui.mount({
    plugin: 'agent-hub',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'agent-hub',
    props: PANE_PROPS,
  })

  expect(await ui.find({ type: 'Text', text: 'README.md' })).toBeUndefined()
})

test('the main loop’s own turns add no row', async ($, on) => {
  const { clock } = engine(on)
  await $.turn.start({ text: 'hi', turnId: 'm1' })
  await clock.settle()
  const ui = await $.ui.mount({
    plugin: 'agent-hub',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'agent-hub',
    props: PANE_PROPS,
  })

  expect(await ui.find({ type: 'Text', text: 'Subagents: 0 running · 0 done' })).toBeDefined()
})

// A tasks dir the engine writes command logs to, as a test sets it.
function tasksDir(on: On) {
  const dir = '/private/tmp/claude-501/-proj/sid/tasks'
  const files: Record<string, { text: string; mtimeMs: number }> = {}
  on('session.id', () => ({ value: 'sid' }))
  on('session.root', () => ({ value: '/proj' }))
  on('session.cwd', () => ({ value: '/proj' }))
  on('env.get', () => ({ value: undefined }))
  on('fs.list', (_$, e) =>
    e.path === '/private/tmp'
      ? { value: [{ name: 'claude-501', kind: 'dir', size: 0, mtimeMs: 0, isLink: false }] }
      : e.path === '/private/tmp/claude-501'
        ? { value: [{ name: '-proj', kind: 'dir', size: 0, mtimeMs: 0, isLink: false }] }
        : e.path === dir
          ? {
              value: Object.entries(files).map(([name, file]) => ({
                name,
                kind: 'file',
                size: file.text.length,
                mtimeMs: file.mtimeMs,
                isLink: false,
              })),
            }
          : { value: [] },
  )
  on('fs.exists', (_$, e) => ({ value: e.path === dir }))
  const named = (path: string) => files[path.slice(dir.length + 1)]
  on('fs.stat', (_$, e) => {
    const file = named(e.path)

    return file === undefined
      ? { deny: 'ENOENT' }
      : { value: { kind: 'file', size: file.text.length, mtimeMs: file.mtimeMs, isLink: false } }
  })
  on('fs.read', (_$, e) => {
    const file = named(e.path)

    return file === undefined ? { deny: 'ENOENT' } : { value: file.text }
  })

  return files
}

test("the main conversation's foreground commands are the transcript's, not a shell", async ($, on) => {
  const { clock } = engine(on)
  tasksDir(on)
  on('tool.call', () => ({ result: { stdout: 'clean', stderr: '', interrupted: false }, text: 'clean' }))
  const ui = await $.ui.mount({ plugin: 'agent-hub', surface: 'terminal', component: 'Pane', requestId: 'agent-hub', props: PANE_PROPS })

  await $.tool.call({ tool: 'Bash', command: 'git status', tool_use_id: 'u1' } as never)
  await clock.advance(2000)
  await clock.settle()
  expect(await ui.find({ type: 'Text', text: /^Shells/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: 'git status' })).toBeUndefined()

  await ui.unmount()
})

test('a command moved to the background mid-run becomes a shell, its log found in the tasks dir', async ($, on) => {
  const { clock } = engine(on)
  const files = tasksDir(on)
  const start = starts(on)
  on('tool.call', () => ({
    result: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'bbuild', backgroundedByUser: true },
    text: 'Command was manually backgrounded by user with ID: bbuild.',
  }))
  await start($)
  const ui = await $.ui.mount({ plugin: 'agent-hub', surface: 'terminal', component: 'Pane', requestId: 'agent-hub', props: PANE_PROPS })

  await $.tool.call({ tool: 'Bash', command: 'npm run build', description: 'Build the app', tool_use_id: 'u1' } as never)
  files['bbuild.output'] = { text: 'compiled\n\x1b[32m12 modules\x1b[0m\n', mtimeMs: 2_000_000 }
  await clock.advance(2000)
  await clock.settle()

  expect(await ui.find({ type: 'Text', text: /^Shells: 1 running · 0 done$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: ' Build the app' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'npm run build' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '12 modules' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^main · / })).toBeDefined()

  await ui.unmount()
})

test("a background shell runs until its log's exit line, under the agent that started it", async ($, on) => {
  const { roster, clock } = engine(on)
  const files = tasksDir(on)
  const start = starts(on)
  on('tool.call', () => ({
    result: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'bsrv' },
    text: 'Command running in background with ID: bsrv. Output is being written to: /private/tmp/claude-501/-proj/sid/tasks/bsrv.output',
  }))
  await start($)
  roster.list = [{ id: 'a1', type: 'Explore', description: 'serve it', status: 'running' }]
  await $.turn.start({ text: 'go', turnId: 't1', agentId: 'a1' })
  const ui = await $.ui.mount({ plugin: 'agent-hub', surface: 'terminal', component: 'Pane', requestId: 'agent-hub', props: PANE_PROPS })

  await $.tool.call({ tool: 'Bash', command: 'npm run dev', run_in_background: true, tool_use_id: 'u1', agentId: 'a1' } as never)
  files['bsrv.output'] = { text: 'ready on :3000\n', mtimeMs: 2_000_000 }
  await clock.advance(2000)
  await clock.settle()
  expect(await ui.find({ type: 'Text', text: 'ready on :3000' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^Explore · / })).toBeDefined()

  files['bsrv.output'] = { text: 'ready on :3000\nEADDRINUSE\n\n[exited with code 1]\n', mtimeMs: 2_001_000 }
  await clock.advance(2000)
  await clock.settle()
  expect(await ui.find({ type: 'Text', text: /^Shells: 0 running · 1 done$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /· exit 1$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'EADDRINUSE' })).toBeDefined()

  await ui.unmount()
})

test('no shell yet, no Shells group', async ($, on) => {
  engine(on)
  const ui = await $.ui.mount({ plugin: 'agent-hub', surface: 'terminal', component: 'Pane', requestId: 'agent-hub', props: PANE_PROPS })

  expect(await ui.find({ type: 'Text', text: /^Shells/ })).toBeUndefined()
  await ui.unmount()
})

// The toasts and notifications the pane raised, as the engine's own hooks hear them.
function heard(on: On) {
  const toasts: string[] = []
  const notes: { text: string; title?: string }[] = []
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)

    return { value: undefined } as never
  })
  on('ui.notify', (_$, e) => {
    notes.push({ text: e.text, title: e.title })

    return { value: { isSent: true, channel: 'kitty' } } as never
  })

  return { toasts, notes }
}

test('a running agent that may be stuck is toasted once', async ($, on) => {
  const { roster, clock } = engine(on)
  const start = starts(on)
  const { toasts, notes } = heard(on)
  roster.list = [{ id: 'a1', type: 'Explore', description: 'map the routes', status: 'running' }]
  await start($)
  await $.turn.start({ text: 'go', turnId: 't1', agentId: 'a1' })
  await clock.settle()

  await clock.advance(60_000)
  expect(toasts).toEqual([])

  await clock.advance(70_000)
  expect(toasts).toHaveLength(1)
  expect(toasts[0]).toMatch(/^Agent Hub: Explore may be stuck: no tool call for 2:0\d$/)

  await clock.advance(60_000)
  expect(toasts).toHaveLength(1)
  // Under the default, no notification.
  expect(notes).toEqual([])
})

test('the context passing 80% is toasted once', async ($, on) => {
  engine(on)
  const { toasts } = heard(on)
  const measure = (tokens: number) =>
    $.session.measure({ context: { tokens, window: 1_000_000 }, rateLimits: [], changed: ['context'] } as never)

  await measure(500_000)
  await measure(790_000)
  expect(toasts).toEqual([])
  await measure(820_000)
  await measure(900_000)
  expect(toasts).toEqual(['Agent Hub: context 82% full: compaction is near'])
})

test('under alerts: notify, a notification goes beside the toast', { options: { alerts: 'notify' } }, async ($, on) => {
  engine(on)
  const { toasts, notes } = heard(on)
  await $.session.measure({ context: { tokens: 850_000, window: 1_000_000 }, rateLimits: [], changed: ['context'] } as never)

  expect(toasts).toEqual(['Agent Hub: context 85% full: compaction is near'])
  expect(notes).toEqual([{ text: 'context 85% full: compaction is near', title: 'Agent Hub' }])
})

test('under alerts: off, nothing is said', { options: { alerts: 'off' } }, async ($, on) => {
  const { roster, clock } = engine(on)
  const start = starts(on)
  const { toasts, notes } = heard(on)
  roster.list = [{ id: 'a1', type: 'Explore', description: 'map the routes', status: 'running' }]
  await start($)
  await $.turn.start({ text: 'go', turnId: 't1', agentId: 'a1' })
  await $.session.measure({ context: { tokens: 850_000, window: 1_000_000 }, rateLimits: [], changed: ['context'] } as never)
  await clock.advance(200_000)

  expect(toasts).toEqual([])
  expect(notes).toEqual([])
})
