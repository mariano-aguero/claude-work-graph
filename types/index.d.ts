export type TaskStatus = 'pending' | 'in_progress' | 'completed'
export type Task = {
  id: string
  subject: string
  status: TaskStatus
  owner?: string
  blockedBy: string[]
}
export type Agent = {
  id: string
  name: string
  description: string
  type: string
  status: string
  parentId?: string
  branch?: string
}
export type PullRequest = {
  number: number
  url: string
  state: string
  isDraft: boolean
  checks: 'passing' | 'failing' | 'pending' | 'none'
}
export type Worktree = { path: string; branch: string; dirty: number; pr?: PullRequest }
// What one loop (the main session or one agent) has done since the mod loaded.
export type AgentStats = {
  model?: string
  turns: number
  tools: number
  inputTokens: number
  outputTokens: number
  costUsd: number
  contextTokens: number
  totalMs: number
  lastReason?: string
  lastAnswer?: string
  currentTool?: string
  files: string[]
  prUrl?: string
}
export type SessionInfo = { costUsd?: number; contextPercent?: number; contextTokens?: number }

declare module 'claude-code' {
  interface PluginState {
    'work-graph': {
      tasks: Task[]
      agents: Agent[]
      worktrees: Worktree[]
      stats: Record<string, AgentStats>
      session: SessionInfo
    }
  }
}
