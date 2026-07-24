import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveAgentSessionPolicy } from '../web/agent-config.js'
import {
  decideTaskBoundary,
  handoffFileName,
  persistTaskHandoffInDir,
  taskIdForMessage,
  validateTaskHandoff,
} from '../web/fresh-task-policy.js'

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('fresh-per-task session boundaries', () => {
  it('keeps legacy continue behavior when sessionPolicy is absent or invalid', () => {
    expect(resolveAgentSessionPolicy('{}')).toBe('continue')
    expect(resolveAgentSessionPolicy('{"sessionPolicy":"unknown"}')).toBe('continue')
    expect(resolveAgentSessionPolicy('not-json')).toBe('continue')
    expect(decideTaskBoundary('continue', 'task-a', 'task-b')).toBe('legacy')
  })

  it('continues only the same connected task and starts fresh for a different id', () => {
    expect(decideTaskBoundary('fresh-per-task', 'card:123', 'card:123')).toBe('continue')
    expect(decideTaskBoundary('fresh-per-task', 'card:123', 'card:456')).toBe('fresh')
    expect(decideTaskBoundary('fresh-per-task', null, 'card:123')).toBe('fresh')
  })

  it('treats unlabelled legacy messages as separate top-level tasks', () => {
    expect(taskIdForMessage(41, null)).toBe('message:41')
    expect(taskIdForMessage(42, undefined)).toBe('message:42')
    expect(taskIdForMessage(42, ' card:abc ')).toBe('card:abc')
  })
})

describe('durable task handoff', () => {
  const handoff = {
    goal: 'Review the fleet boundary design',
    decisions: ['Keep task identity on the message bus'],
    files: ['/repo/src/web/fresh-task-policy.ts'],
    openQuestions: ['Should old handoffs be archived?'],
    nextStep: 'Have Marveen decide whether to implement the reviewed plan',
  }

  it('validates all owner-required handoff fields', () => {
    expect(validateTaskHandoff(handoff)).toEqual({ ok: true, handoff })
    expect(validateTaskHandoff({ ...handoff, goal: '' })).toEqual({
      ok: false,
      error: 'handoff.goal is required',
    })
    expect(validateTaskHandoff({ ...handoff, files: 'not-an-array' })).toEqual({
      ok: false,
      error: 'handoff.files must be a string array',
    })
  })

  it('persists a path-safe JSON handoff outside conversation state', () => {
    const baseDir = mkdtempSync(join(tmpdir(), 'marveen-fresh-task-'))
    tempDirs.push(baseDir)
    const taskId = 'kanban:../../CARD 123'
    const path = persistTaskHandoffInDir(baseDir, taskId, 77, handoff)

    expect(path).toBe(join(baseDir, 'handoffs', handoffFileName(taskId)))
    expect(path.startsWith(join(baseDir, 'handoffs') + '/')).toBe(true)
    const stored = JSON.parse(readFileSync(path, 'utf-8'))
    expect(stored).toMatchObject({
      taskId,
      sourceMessageId: 77,
      ...handoff,
    })
    expect(stored.closedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })
})
