import { expect, test } from 'claude-code/testing'

const TASKS = [
  { id: '1', subject: 'Write schema', status: 'in_progress', blockedBy: [] },
  { id: '2', subject: 'Write endpoint', status: 'pending', blockedBy: ['1'] },
  { id: '3', subject: 'Docs', status: 'completed', blockedBy: [] },
]

test('draws a blocked task under its blocker', async ($, on) => {
  on('tool.call', { tool: 'TaskList' }, () => ({ result: { tasks: TASKS } }))
  on('tool.call', { tool: 'TaskCreate' }, () => ({ result: { task: { id: '3', subject: 'Docs' } } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  await $.tool.call({ tool: 'TaskCreate', subject: 'Docs', description: 'x' })

  const ui = await $.ui.mount({
    plugin: 'work-graph',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'work-graph',
    props: {
      title: 'Work',
      isFocused: true,
      bodyColumns: 80,
      placement: 'dock',
      scroll: { offset: 0, bodyRows: 40 },
      view: {},
    },
  })
  expect(await ui.find({ type: 'Text', text: /#2 Write endpoint/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /blocked/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /1 running/ })).toBeDefined()
  await ui.unmount()
})

const PORCELAIN = [
  'worktree /r/main\nHEAD a\nbranch refs/heads/main',
  'worktree /r/wt/feature\nHEAD b\nbranch refs/heads/feature',
  'worktree /r/wt/old\nHEAD c\ndetached',
].join('\n\n')

test('draws agents as cards under the main session, hides clean detached trees', async ($, on) => {
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('agent.list', () => ({
    value: [
      { id: 'a1', name: 'scraper', description: 'x', type: 'acme:researcher', status: 'running' },
      { id: 'a2', name: 'analyst', description: 'x', type: 'acme:researcher', status: 'idle' },
    ],
  }))
  on('process.run', ($, e) => {
    const isList = e.argv.includes('list')
    const isFeature = e.argv.includes('/r/wt/feature')
    return { value: { exitCode: 0, stdout: isList ? PORCELAIN : isFeature ? ' M a.ts\n' : '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('tool.call', { tool: 'TaskList' }, () => ({ result: { tasks: [] } }))
  await $.command.run({
    command: 'work',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 160 },
  })

  const ui = await $.ui.mount({
    plugin: 'work-graph',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'work-graph',
    props: {
      title: 'Work',
      isFocused: true,
      bodyColumns: 80,
      placement: 'dock',
      scroll: { offset: 0, bodyRows: 40 },
      view: {},
    },
  })
  expect(await ui.find({ type: 'Text', text: /scraper/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /analyst/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Main session/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^researcher · acme$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /╭.*┴.*╮/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /\+ 1 more, detached and clean/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /wt\/old/ })).toBeUndefined()
  await ui.unmount()
})

test('counts an agent tool calls, edited files and the PR it opened', async ($, on) => {
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('agent.list', () => ({
    value: [{ id: 'a1', name: 'coder', description: 'Build the page', type: 'general-purpose', status: 'running' }],
  }))
  on('tool.call', { tool: 'Edit' }, () => ({ result: { ok: true } }))
  on('tool.call', { tool: 'Bash' }, () => ({
    result: { stdout: '' },
    text: 'https://github.com/acme/web/pull/42\n',
  }))
  on('tool.call', { tool: 'Agent' }, () => ({ result: { agentId: 'a1' } }))

  await $.tool.call({ tool: 'Agent', prompt: 'go', description: 'Build the page' })
  // Raised as if from inside agent a1's loop.
  const edit = { tool: 'Edit' as const, agentId: 'a1', file_path: '/r/a.ts', old_string: 'a', new_string: 'b' }
  const bash = { tool: 'Bash' as const, agentId: 'a1', command: 'gh pr create --fill' }
  await $.tool.call(edit)
  await $.tool.call(bash)

  const ui = await $.ui.mount({
    plugin: 'work-graph',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'work-graph',
    props: {
      title: 'Work',
      isFocused: true,
      bodyColumns: 110,
      placement: 'dock',
      scroll: { offset: 0, bodyRows: 60 },
      view: {},
    },
  })
  expect(await ui.find({ type: 'Text', text: /2 tools · 1 files/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /PR #42/ })).toBeDefined()
  await ui.unmount()
})
