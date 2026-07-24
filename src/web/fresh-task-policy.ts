import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { agentDir, type AgentSessionPolicy } from './agent-config.js'
import { atomicWriteFileSync } from './atomic-write.js'

export interface ActiveAgentTask {
  taskId: string
  sourceMessageId: number
  fromAgent: string
  goal: string
  startedAt: string
}

export interface TaskHandoff {
  goal: string
  decisions: string[]
  files: string[]
  openQuestions: string[]
  nextStep: string
}

export type TaskBoundaryDecision = 'legacy' | 'continue' | 'fresh'

const ACTIVE_TASK_FILE = '.active-task.json'
const HANDOFF_DIR = 'handoffs'
const MAX_TASK_ID_LENGTH = 200

export function normalizeTaskId(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > MAX_TASK_ID_LENGTH || /[\u0000-\u001f\u007f]/.test(trimmed)) return null
  return trimmed
}

/**
 * Missing task ids are intentionally unique per message. This keeps old
 * callers safe: every unlabelled delegation is treated as an independent task
 * rather than accidentally inheriting a previous Fable conversation.
 */
export function taskIdForMessage(messageId: number, explicitTaskId: string | null | undefined): string {
  return normalizeTaskId(explicitTaskId) ?? `message:${messageId}`
}

export function decideTaskBoundary(
  policy: AgentSessionPolicy,
  activeTaskId: string | null,
  incomingTaskId: string,
): TaskBoundaryDecision {
  if (policy !== 'fresh-per-task') return 'legacy'
  return activeTaskId === incomingTaskId ? 'continue' : 'fresh'
}

function activeTaskPath(name: string): string {
  return join(agentDir(name), ACTIVE_TASK_FILE)
}

export function readActiveAgentTask(name: string): ActiveAgentTask | null {
  try {
    const parsed = JSON.parse(readFileSync(activeTaskPath(name), 'utf-8')) as Partial<ActiveAgentTask>
    const taskId = normalizeTaskId(parsed.taskId)
    if (!taskId || typeof parsed.sourceMessageId !== 'number' || typeof parsed.fromAgent !== 'string') return null
    return {
      taskId,
      sourceMessageId: parsed.sourceMessageId,
      fromAgent: parsed.fromAgent,
      goal: typeof parsed.goal === 'string' ? parsed.goal : '',
      startedAt: typeof parsed.startedAt === 'string' ? parsed.startedAt : '',
    }
  } catch {
    return null
  }
}

export function writeActiveAgentTask(name: string, task: Omit<ActiveAgentTask, 'startedAt'>): ActiveAgentTask {
  const stored: ActiveAgentTask = { ...task, startedAt: new Date().toISOString() }
  atomicWriteFileSync(activeTaskPath(name), JSON.stringify(stored, null, 2) + '\n')
  return stored
}

export function clearActiveAgentTask(name: string, expectedTaskId?: string): boolean {
  const path = activeTaskPath(name)
  if (!existsSync(path)) return false
  if (expectedTaskId) {
    const active = readActiveAgentTask(name)
    if (active?.taskId !== expectedTaskId) return false
  }
  try {
    unlinkSync(path)
    return true
  } catch {
    return false
  }
}

function stringList(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) return null
  return value.map((item) => item.trim()).filter(Boolean)
}

export function validateTaskHandoff(value: unknown): { ok: true; handoff: TaskHandoff } | { ok: false; error: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, error: 'handoff must be an object' }
  }
  const raw = value as Record<string, unknown>
  const goal = typeof raw.goal === 'string' ? raw.goal.trim() : ''
  const decisions = stringList(raw.decisions)
  const files = stringList(raw.files)
  const openQuestions = stringList(raw.openQuestions)
  const nextStep = typeof raw.nextStep === 'string' ? raw.nextStep.trim() : ''
  if (!goal) return { ok: false, error: 'handoff.goal is required' }
  if (!decisions) return { ok: false, error: 'handoff.decisions must be a string array' }
  if (!files) return { ok: false, error: 'handoff.files must be a string array' }
  if (!openQuestions) return { ok: false, error: 'handoff.openQuestions must be a string array' }
  if (!nextStep) return { ok: false, error: 'handoff.nextStep is required' }
  return { ok: true, handoff: { goal, decisions, files, openQuestions, nextStep } }
}

export function handoffFileName(taskId: string): string {
  const slug = taskId.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'task'
  const digest = createHash('sha256').update(taskId).digest('hex').slice(0, 12)
  return `${slug}-${digest}.json`
}

export function persistTaskHandoff(
  name: string,
  taskId: string,
  sourceMessageId: number,
  handoff: TaskHandoff,
): string {
  return persistTaskHandoffInDir(agentDir(name), taskId, sourceMessageId, handoff)
}

export function persistTaskHandoffInDir(
  baseDir: string,
  taskId: string,
  sourceMessageId: number,
  handoff: TaskHandoff,
): string {
  const dir = join(baseDir, HANDOFF_DIR)
  mkdirSync(dir, { recursive: true })
  const path = join(dir, handoffFileName(taskId))
  atomicWriteFileSync(path, JSON.stringify({
    taskId,
    sourceMessageId,
    closedAt: new Date().toISOString(),
    ...handoff,
  }, null, 2) + '\n')
  return path
}

export function formatTaskHandoff(handoff: TaskHandoff, path: string): string {
  const list = (items: string[]) => items.length ? items.map((item) => `- ${item}`).join('\n') : '- none'
  return [
    `Goal: ${handoff.goal}`,
    'Decisions:',
    list(handoff.decisions),
    'Files:',
    list(handoff.files),
    'Open questions:',
    list(handoff.openQuestions),
    `Next possible step: ${handoff.nextStep}`,
    `Durable handoff: ${path}`,
  ].join('\n')
}
