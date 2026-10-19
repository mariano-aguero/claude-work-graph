import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderChildren } from 'claude-code'

import type { Agent, AgentStats, PullRequest, SessionInfo, Task, Worktree } from '../types'

const PANE = 'work-graph'
const TITLE = 'Work'
const POLL_MS = 4000
const PR_POLL_MS = 60_000
// Width asked for the dock beside a fullscreen transcript; the person's drag wins.
const OPEN = { id: PANE, title: TITLE, columns: 110 }
const CARD_MIN = 34
const GAP = 1
const MAX_TREES = 8
const MAX_FILES = 50
const MAIN = 'main'

const tasks = atom({ plugin: 'work-graph', key: 'tasks' } as const, [])
const agents = atom({ plugin: 'work-graph', key: 'agents' } as const, [])
const worktrees = atom({ plugin: 'work-graph', key: 'worktrees' } as const, [])
const stats = atom({ plugin: 'work-graph', key: 'stats' } as const, {})
const session = atom({ plugin: 'work-graph', key: 'session' } as const, {})

const TASK_TOOLS = new Set(['TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet'])
const EMPTY_STATS: AgentStats = {
  turns: 0,
  tools: 0,
  inputTokens: 0,
  outputTokens: 0,
  costUsd: 0,
  contextTokens: 0,
  totalMs: 0,
  files: [],
}

// Dollars per million tokens: input, output, cache read. Cache writes bill at
// 1.25x input. The first entry whose key the model id contains wins.
const PRICES: [string, number, number, number][] = [
  ['fable', 10, 50, 0.25],
  ['mythos', 10, 50, 0.25],
  ['opus-5-5', 4, 20, 0.2],
  ['opus', 5, 25, 0.5],
  ['sonnet-5', 2, 10, 0.2],
  ['sonnet', 3, 15, 0.3],
  ['haiku-5', 0.1, 0.5, 0.01],
  ['haiku', 1, 5, 0.1],
]

type Usage = {
  model: string
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}

function costOf(usage: Usage) {
  const price = PRICES.find(([key]) => usage.model.includes(key))
  if (!price) return 0
  const [, input, output, cacheRead] = price
  const dollars =
    usage.input_tokens * input +
    usage.output_tokens * output +
    usage.cache_read_input_tokens * cacheRead +
    usage.cache_creation_input_tokens * input * 1.25
  return dollars / 1_000_000
}

function bumpStats($: EngineInterface, key: string, fn: (s: AgentStats) => AgentStats) {
  return update($, stats, all => ({ ...all, [key]: fn(all[key] ?? EMPTY_STATS) }))
}

async function refreshTasks($: EngineInterface) {
  const ran = await $.tool.call({ tool: 'TaskList' })
  const list = (ran.result as { tasks?: Task[] } | undefined)?.tasks
  if (list) await update($, tasks, () => list)
}

async function refreshWorktrees($: EngineInterface) {
  const { exitCode, stdout } = await $.process.run(['git', 'worktree', 'list', '--porcelain'])
  if (exitCode !== 0) return

  const prs = new Map((await read($, worktrees)).map(t => [t.branch, t.pr]))
  const found: Worktree[] = []
  for (const block of stdout.trim().split('\n\n')) {
    const path = block.match(/^worktree (.+)$/m)?.[1]
    if (!path) continue
    const branch = block.match(/^branch refs\/heads\/(.+)$/m)?.[1] ?? 'detached'
    const status = await $.process.run(['git', '-C', path, 'status', '--porcelain'])
    const dirty = status.stdout.split('\n').filter(Boolean).length
    found.push({ path, branch, dirty, pr: prs.get(branch) })
  }
  await update($, worktrees, () => found)
}

type GhPr = {
  headRefName: string
  number: number
  url: string
  state: string
  isDraft: boolean
  statusCheckRollup: { conclusion?: string; status?: string; state?: string }[]
}

function checksOf(rollup: GhPr['statusCheckRollup']): PullRequest['checks'] {
  if (rollup.length === 0) return 'none'
  const outcomes = rollup.map(c => (c.conclusion || c.state || c.status || '').toUpperCase())
  if (outcomes.some(o => ['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT'].includes(o))) return 'failing'
  if (outcomes.some(o => ['', 'PENDING', 'IN_PROGRESS', 'QUEUED', 'EXPECTED'].includes(o))) return 'pending'
  return 'passing'
}

async function refreshPullRequests($: EngineInterface) {
  const fields = 'headRefName,number,url,state,isDraft,statusCheckRollup'
  const argv = ['gh', 'pr', 'list', '--author', '@me', '--state', 'all', '--limit', '100', '--json', fields]
  // gh may be missing or signed out; the pane then shows worktrees without PRs.
  const ran = await $.process.run(argv, { timeoutMs: 20_000 }).catch((error: unknown) => {
    $.ui.log(`work-graph: gh pr list failed: ${String(error)}`, { to: 'debug' })
    return undefined
  })
  if (ran?.exitCode !== 0) return

  // gh lists newest first, so the first PR seen for a branch is the current one.
  const byBranch = new Map<string, PullRequest>()
  for (const pr of JSON.parse(ran.stdout) as GhPr[]) {
    if (byBranch.has(pr.headRefName)) continue
    byBranch.set(pr.headRefName, {
      number: pr.number,
      url: pr.url,
      state: pr.state,
      isDraft: pr.isDraft,
      checks: checksOf(pr.statusCheckRollup ?? []),
    })
  }
  await update($, worktrees, list => list.map(t => ({ ...t, pr: byBranch.get(t.branch) })))
}

async function refreshSession($: EngineInterface) {
  const { cost, context } = await $.session.usage()
  const info: SessionInfo = {
    costUsd: cost?.usd,
    contextPercent: context.percent,
    contextTokens: context.tokens,
  }
  await update($, session, () => info)
}

// Branches are only known for agents whose Agent call returned with a worktree.
const agentBranches = new Map<string, string>()

async function refreshAgents($: EngineInterface) {
  const list = await $.agent.list()
  const mapped: Agent[] = list.map(a => ({
    id: a.id,
    name: a.name ?? a.description,
    description: a.description,
    type: a.type,
    status: a.status,
    parentId: a.parentId,
    branch: agentBranches.get(a.id),
  }))
  await update($, agents, () => mapped)
}

function refreshAll($: EngineInterface) {
  return Promise.allSettled([
    refreshTasks($),
    refreshAgents($),
    refreshWorktrees($).then(() => refreshPullRequests($)),
    refreshSession($),
  ])
}

function toolLabel(e: { tool: string } & Record<string, unknown>) {
  const target = e.file_path ?? e.command ?? e.pattern ?? e.description ?? e.url
  if (typeof target !== 'string') return e.tool
  return `${e.tool} ${target.split('\n')[0]!.replace(/^.*\//, '')}`
}

function isBlocked(task: Task, byId: Map<string, Task>) {
  return task.status === 'pending' && task.blockedBy.some(id => byId.get(id)?.status !== 'completed')
}

type Badge = { text: string; color: string; isQuiet: boolean }

const AGENT_BADGE: Record<string, Badge> = {
  running: { text: '◐ Running', color: 'suggestion', isQuiet: false },
  pending: { text: '◌ Starting', color: 'suggestion', isQuiet: false },
  waiting: { text: '◷ Needs you', color: 'warning', isQuiet: false },
  idle: { text: '○ Idle', color: 'subtle', isQuiet: true },
  completed: { text: '✓ Done', color: 'success', isQuiet: true },
  failed: { text: '✗ Failed', color: 'error', isQuiet: false },
  killed: { text: '◼ Stopped', color: 'error', isQuiet: true },
}

// An idle teammate is one whose turn ended; how it ended says whether it succeeded.
const TURN_BADGE: Record<string, Badge> = {
  answer: { text: '✓ Done', color: 'success', isQuiet: true },
  error: { text: '✗ Error', color: 'error', isQuiet: false },
  refusal: { text: '✗ Refused', color: 'error', isQuiet: false },
  aborted: { text: '◼ Stopped', color: 'subtle', isQuiet: true },
}

// Live agents first, then the ones that need the person, then the rest.
const AGENT_ORDER = ['running', 'pending', 'waiting', 'failed', 'idle', 'completed', 'killed']

function agentBadge(agent: Agent, s: AgentStats | undefined): Badge {
  if (agent.status === 'idle' && s?.lastReason) return TURN_BADGE[s.lastReason] ?? AGENT_BADGE.idle!
  return AGENT_BADGE[agent.status] ?? AGENT_BADGE.running!
}

function taskBadge(task: Task, byId: Map<string, Task>): Badge {
  if (task.status === 'completed') return { text: '✓ Done', color: 'success', isQuiet: true }
  if (task.status === 'in_progress') return { text: '◐ Running', color: 'suggestion', isQuiet: false }
  if (isBlocked(task, byId)) return { text: '⧗ Blocked', color: 'warning', isQuiet: false }
  return { text: '○ Ready', color: 'subtle', isQuiet: false }
}

function modelName(id: string | undefined) {
  const match = id?.match(/claude-([a-z]+)-(\d+)(?:-(\d+))?/)
  if (!match) return id
  const [, family, major, minor] = match
  return `${family![0]!.toUpperCase()}${family!.slice(1)} ${major}${minor ? `.${minor}` : ''}`
}

function tokens(n: number) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1000) return `${Math.round(n / 1000)}k`
  return String(n)
}

function duration(ms: number) {
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`
}

function money(usd: number) {
  return usd < 10 ? `$${usd.toFixed(2)}` : `$${Math.round(usd)}`
}

function prLabel(pr: PullRequest) {
  const state = pr.isDraft ? 'draft' : pr.state.toLowerCase()
  const checks = { passing: ' ✓', failing: ' ✗', pending: ' ●', none: '' }[pr.checks]
  return `#${pr.number} ${state}${checks}`
}

function prColor(pr: PullRequest) {
  if (pr.checks === 'failing') return 'error'
  if (pr.state === 'MERGED') return 'merged'
  if (pr.state === 'CLOSED' || pr.isDraft) return 'subtle'
  return pr.checks === 'pending' ? 'warning' : 'success'
}

// The line joining a parent card to a row of cards below it, as in an org chart:
// ╭───────┬───┴───┬───────╮ with a drop at each card's center.
function connector(cards: number, cardWidth: number) {
  const width = cards * cardWidth + (cards - 1) * GAP
  const centers = Array.from({ length: cards }, (_, i) => i * (cardWidth + GAP) + Math.floor(cardWidth / 2))
  const first = centers[0]!
  const last = centers[centers.length - 1]!
  const root = Math.floor(width / 2)
  if (cards === 1) return ' '.repeat(first) + '│'

  let line = ''
  for (let x = 0; x <= last; x++) {
    const isDrop = centers.includes(x)
    if (x < first) line += ' '
    else if (x === root) line += isDrop ? '┼' : '┴'
    else if (x === first) line += '╭'
    else if (x === last) line += '╮'
    else line += isDrop ? '┬' : '─'
  }
  return line
}

function relative(path: string, root: string) {
  return path.startsWith(root) ? path.slice(root.length) || '.' : path
}

// The directory every path shares, with a trailing slash, so rows show what differs.
function commonDir(paths: string[]) {
  if (paths.length === 0) return ''
  const parts = paths.map(p => p.split('/').slice(0, -1))
  const first = parts[0]!
  let n = 0
  while (n < first.length && parts.every(p => p[n] === first[n])) n++
  return first.slice(0, n).join('/') + '/'
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({
      name: 'work',
      description: 'Show agents, tasks with their blockers, worktrees and PRs in a pane',
    })
    void refreshAll($).then(() => $.ui.open(OPEN))
    $.clock.every(POLL_MS, () => {
      void refreshAgents($)
      void refreshWorktrees($)
      void refreshSession($)
    })
    $.clock.every(PR_POLL_MS, () => void refreshPullRequests($))

    return started
  })

  on('command.run', { command: 'work' }, async $ => {
    await refreshAll($)
    const opened = await $.ui.open(OPEN)

    return { text: opened.isPlaced ? 'Work pane opened.' : `Work pane waiting: ${opened.reason}` }
  })

  on('turn.step', async function* ($, e, next) {
    const step = yield* next(e)
    const usage = step.usage
    if (usage) {
      const context = usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens
      await bumpStats($, e.agentId ?? MAIN, s => ({
        ...s,
        model: usage.model,
        inputTokens: s.inputTokens + context,
        outputTokens: s.outputTokens + usage.output_tokens,
        costUsd: s.costUsd + costOf(usage),
        contextTokens: context,
      }))
    }

    return step
  })

  on('turn.complete', async ($, e, next) => {
    await bumpStats($, e.agentId ?? MAIN, s => ({
      ...s,
      turns: s.turns + 1,
      totalMs: s.totalMs + e.durationMs,
      lastReason: e.reason,
      lastAnswer: e.answer.trim().split('\n')[0]?.slice(0, 200),
      currentTool: undefined,
    }))

    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const key = e.agentId ?? MAIN
    await bumpStats($, key, s => ({ ...s, currentTool: toolLabel(e) }))
    const ran = await next(e)

    const file = e.tool === 'Edit' || e.tool === 'Write' ? e.file_path : undefined
    const pr = e.tool === 'Bash' && e.command.includes('gh pr create')
      ? ran.text?.match(/https:\/\/github\.com\/\S+\/pull\/\d+/)?.[0]
      : undefined
    await bumpStats($, key, s => ({
      ...s,
      tools: s.tools + 1,
      currentTool: undefined,
      files: file && !s.files.includes(file) ? [...s.files, file].slice(-MAX_FILES) : s.files,
      prUrl: pr ?? s.prUrl,
    }))
    if (pr) void refreshPullRequests($)

    if (TASK_TOOLS.has(e.tool)) {
      await refreshTasks($)
      void $.ui.open(OPEN)
    }
    if (e.tool === 'Agent') {
      const result = ran.result as { agentId?: string; worktreeBranch?: string } | undefined
      if (result?.agentId && result.worktreeBranch) agentBranches.set(result.agentId, result.worktreeBranch)
      void refreshAgents($)
    }

    return ran
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const taskList = await read($, tasks)
    const agentList = await read($, agents)
    const treeList = await read($, worktrees)
    const allStats = await read($, stats)
    const sessionInfo = await read($, session)

    const perRow = Math.max(1, Math.floor((e.props.bodyColumns + GAP) / (CARD_MIN + GAP)))
    const cardWidth = Math.floor((e.props.bodyColumns - (perRow - 1) * GAP) / perRow)

    type Line = { text: string; color?: string }

    const card = (key: string, title: string, badge: Badge, lines: Line[], width: number): RenderChildren => (
      <Box
        key={key}
        width={width}
        flexDirection="column"
        borderStyle="round"
        borderColor={badge.isQuiet ? 'subtle' : badge.color}
        paddingX={1}
      >
        <Box justifyContent="space-between">
          <Box flexShrink={1}>
            <Text bold dimColor={badge.isQuiet} wrap="truncate-end">
              {title}
            </Text>
          </Box>
          <Box flexShrink={0}>
            <Text color={badge.color}> {badge.text}</Text>
          </Box>
        </Box>
        {lines.map(line => (
          <Text color={line.color} dimColor={!line.color} wrap="truncate-end">
            {line.text}
          </Text>
        ))}
      </Box>
    )

    // A parent card centered over its children, joined by connector lines.
    const chart = (root: RenderChildren, columns: RenderChildren[]): RenderChildren => {
      const rows: RenderChildren[][] = []
      for (let i = 0; i < columns.length; i += perRow) rows.push(columns.slice(i, i + perRow))
      const firstCount = rows[0]?.length ?? 0
      return (
        <Box flexDirection="column">
          <Box justifyContent="center">{root}</Box>
          {firstCount > 0 && <Text color="suggestion">{connector(firstCount, cardWidth)}</Text>}
          {rows.map(row => (
            <Box flexDirection="row" columnGap={GAP} alignItems="flex-start">
              {row}
            </Box>
          ))}
        </Box>
      )
    }

    const metrics = (s: AgentStats | undefined): Line[] => {
      if (!s) return []
      // A teammate in its own process reports tool calls here but no usage.
      const total = s.inputTokens + s.outputTokens
      const parts = [
        s.costUsd > 0 && money(s.costUsd),
        total > 0 && `${tokens(total)} tok`,
        s.contextTokens > 0 && `ctx ${tokens(s.contextTokens)}`,
        s.totalMs > 0 && duration(s.totalMs),
        s.tools > 0 && `${s.tools} tools`,
        s.files.length > 0 && `${s.files.length} files`,
      ].filter(Boolean)
      return parts.length > 0 ? [{ text: parts.join(' · ') }] : []
    }

    const activity = (s: AgentStats | undefined, isLive: boolean): Line[] => {
      if (s?.currentTool) return [{ text: `▸ ${s.currentTool}`, color: 'suggestion' }]
      if (!isLive && s?.lastAnswer) return [{ text: s.lastAnswer }]
      return []
    }

    const byStatus = (a: Agent, b: Agent) => AGENT_ORDER.indexOf(a.status) - AGENT_ORDER.indexOf(b.status)

    const agentLines = (agent: Agent, s: AgentStats | undefined): Line[] => {
      const lines: Line[] = [
        { text: [modelName(s?.model), agent.type.replace(/^.*:/, '')].filter(Boolean).join(' · ') },
      ]
      if (agent.description !== agent.name) lines.push({ text: agent.description })
      lines.push(...activity(s, agent.status === 'running'), ...metrics(s))
      if (agent.branch) lines.push({ text: `⑂ ${agent.branch}` })
      if (s?.prUrl) lines.push({ text: `⇡ PR ${s.prUrl.replace(/^.*\/pull\//, '#')}`, color: 'success' })
      return lines
    }

    const agentColumn = (agent: Agent): RenderChildren => {
      const kids = agentList.filter(a => a.parentId === agent.id).sort(byStatus)
      const s = allStats[agent.id]
      return (
        <Box key={`a${agent.id}`} flexDirection="column" width={cardWidth}>
          {card(`c${agent.id}`, agent.name, agentBadge(agent, s), agentLines(agent, s), cardWidth)}
          {kids.map(kid => (
            <Box flexDirection="row">
              <Text color="suggestion">╰─</Text>
              {card(`c${kid.id}`, kid.name, agentBadge(kid, allStats[kid.id]), agentLines(kid, allStats[kid.id]), cardWidth - 2)}
            </Box>
          ))}
        </Box>
      )
    }

    const known = new Set(agentList.map(a => a.id))
    const topAgents = agentList.filter(a => !a.parentId || !known.has(a.parentId)).sort(byStatus)
    const running = agentList.filter(a => a.status === 'running' || a.status === 'pending').length
    const waiting = agentList.filter(a => a.status === 'waiting').length

    const mainStats = allStats[MAIN]
    const mainTree = treeList[0]
    const mainLines: Line[] = [{ text: modelName(mainStats?.model) ?? 'this session' }]
    mainLines.push(...activity(mainStats, true))
    const sessionParts = [
      sessionInfo.costUsd !== undefined && `${money(sessionInfo.costUsd)} session`,
      sessionInfo.contextTokens !== undefined &&
        `ctx ${tokens(sessionInfo.contextTokens)}${sessionInfo.contextPercent !== undefined ? ` (${sessionInfo.contextPercent}%)` : ''}`,
      mainStats && `${mainStats.tools} tools`,
    ].filter(Boolean)
    if (sessionParts.length > 0) mainLines.push({ text: sessionParts.join(' · ') })
    if (mainTree) mainLines.push({ text: `⑂ ${mainTree.branch}` })
    if (mainTree?.pr) mainLines.push({ text: `⇡ PR ${prLabel(mainTree.pr)}`, color: prColor(mainTree.pr) })

    // The session's own ledger counts its subagents; the estimate is the fallback.
    const totalCost = sessionInfo.costUsd ?? Object.values(allStats).reduce((sum, s) => sum + s.costUsd, 0)

    const byId = new Map(taskList.map(t => [t.id, t]))
    const blockerOf = (task: Task) => task.blockedBy.find(id => byId.has(id))
    // A task with several blockers hangs under the first one that exists.
    const taskColumn = (task: Task): RenderChildren => {
      const dependents = taskList.filter(t => blockerOf(t) === task.id)
      const extra = task.blockedBy.filter(id => id !== blockerOf(task) && byId.has(id))
      const lines: Line[] = [{ text: task.owner ?? 'unassigned' }]
      if (extra.length > 0) lines.push({ text: `also waits on #${extra.join(', #')}` })
      return (
        <Box key={`t${task.id}`} flexDirection="column" width={cardWidth}>
          {card(`k${task.id}`, `#${task.id} ${task.subject}`, taskBadge(task, byId), lines, cardWidth)}
          {dependents.map(dep => (
            <Box flexDirection="row">
              <Text color="warning">╰─</Text>
              {taskColumn(dep)}
            </Box>
          ))}
        </Box>
      )
    }
    const rootTasks = taskList.filter(t => !blockerOf(t))
    const tasksRunning = taskList.filter(t => t.status === 'in_progress').length
    const tasksBlocked = taskList.filter(t => isBlocked(t, byId)).length
    const tasksDone = taskList.filter(t => t.status === 'completed').length

    const shownTrees = treeList
      .filter(t => t.dirty > 0 || t.branch !== 'detached')
      .sort((a, b) => b.dirty - a.dirty || Number(Boolean(b.pr)) - Number(Boolean(a.pr)))
      .slice(0, MAX_TREES)
    const dirtyTrees = treeList.filter(t => t.dirty > 0).length
    const openPrs = treeList.filter(t => t.pr?.state === 'OPEN').length
    const root = commonDir(treeList.map(t => t.path))
    const branchWidth = Math.min(30, Math.max(0, ...shownTrees.map(t => t.branch.length)))
    const prWidth = Math.max(0, ...shownTrees.map(t => (t.pr ? prLabel(t.pr).length : 0)))

    const header = (title: string, chips: [string, string][]): RenderChildren => (
      <Box justifyContent="space-between">
        <Text bold>
          <Text color="claude">✦</Text> {title}
        </Text>
        <Text>
          {chips.map(([text, color], i) => (
            <Text color={color}>
              {i > 0 ? '   ' : ''}
              {text}
            </Text>
          ))}
        </Text>
      </Box>
    )

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          {header('Agents', [
            [`${agentList.length} agents`, 'subtle'],
            [`${running} running`, 'suggestion'],
            ...(waiting > 0 ? [[`${waiting} needs you`, 'warning'] as [string, string]] : []),
            [`~${money(totalCost)}`, 'text'],
          ])}
          {chart(
            card('main', 'Main session', running > 0 ? AGENT_BADGE.running! : AGENT_BADGE.idle!, mainLines, cardWidth),
            topAgents.map(agentColumn),
          )}
        </Box>

        {taskList.length > 0 && (
          <Box flexDirection="column">
            {header('Tasks', [
              [`${tasksDone}/${taskList.length} done`, 'subtle'],
              [`${tasksRunning} running`, 'suggestion'],
              [`${tasksBlocked} blocked`, 'warning'],
            ])}
            <Box flexDirection="row" flexWrap="wrap" columnGap={GAP} alignItems="flex-start">
              {rootTasks.map(taskColumn)}
            </Box>
          </Box>
        )}

        <Box flexDirection="column">
          {header('Worktrees', [
            [`${treeList.length} total`, 'subtle'],
            [`${dirtyTrees} with changes`, dirtyTrees > 0 ? 'warning' : 'success'],
            [`${openPrs} open PRs`, 'suggestion'],
          ])}
          <Box flexDirection="column" borderStyle="round" borderColor="subtle" paddingX={1}>
            {shownTrees.map(tree => (
              <Text key={tree.path} wrap="truncate-end">
                <Text color={tree.dirty > 0 ? 'warning' : 'success'}>
                  {tree.dirty > 0 ? `● ${String(tree.dirty).padStart(2)}` : '○   '}
                </Text>{' '}
                <Text color={tree.branch === 'detached' ? 'subtle' : 'text'}>{tree.branch.padEnd(branchWidth)}</Text>
                {prWidth > 0 && (
                  <Text color={tree.pr ? prColor(tree.pr) : 'subtle'}>
                    {'  '}
                    {(tree.pr ? prLabel(tree.pr) : '').padEnd(prWidth)}
                  </Text>
                )}
                <Text dimColor>  {relative(tree.path, root)}</Text>
              </Text>
            ))}
            {treeList.length > shownTrees.length && (
              <Text dimColor>+ {treeList.length - shownTrees.length} more, detached and clean</Text>
            )}
          </Box>
        </Box>
      </Box>
    )
  })
}
