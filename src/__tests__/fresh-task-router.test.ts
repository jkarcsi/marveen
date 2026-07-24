import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockGetPendingMessages = vi.fn()
const mockSendPrompt = vi.fn()
const mockRestart = vi.fn()
const mockWriteActive = vi.fn()
let activeTaskId: string | null = null

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}))

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  MAIN_AGENT_ID: 'marveen',
  SUBAGENT_TELEGRAM_WAKE_ENABLED: false,
}))

vi.mock('../db.js', () => ({
  getPendingMessages: (toAgent?: string) => toAgent ? [] : mockGetPendingMessages(),
  markMessageDelivered: vi.fn(() => true),
  markMessageDone: vi.fn(() => true),
  markMessageFailed: vi.fn(() => true),
  markPendingFederatedFailed: vi.fn(() => true),
  setMessageResult: vi.fn(),
  createAgentMessage: vi.fn(),
}))

vi.mock('../web/agent-config.js', () => ({
  readAgentRemoteHost: () => null,
  readAgentRuntime: () => 'claude-tui',
  readAgentSessionPolicy: () => 'fresh-per-task',
  readAgentVoiceConfig: () => ({ responseMode: 'text' }),
}))

vi.mock('../web/agent-process.js', () => ({
  agentSessionName: (name: string) => `agent-${name}`,
  isSessionReadyForPrompt: vi.fn(async () => true),
  clearStaleParkedInput: vi.fn(async () => false),
  startAgentProcess: vi.fn(() => ({ ok: true })),
  restartAgentProcess: (...args: unknown[]) => mockRestart(...args),
  sendPromptToSession: (...args: unknown[]) => mockSendPrompt(...args),
  sessionExistsOnHost: vi.fn(() => true),
}))

vi.mock('../web/fresh-task-policy.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../web/fresh-task-policy.js')>()
  return {
    ...actual,
    readActiveAgentTask: () => activeTaskId
      ? { taskId: activeTaskId, sourceMessageId: 1, fromAgent: 'marveen', goal: '', startedAt: '' }
      : null,
    writeActiveAgentTask: (...args: unknown[]) => mockWriteActive(...args),
  }
})

vi.mock('../web/voice-directive.js', () => ({
  resolveAgentChannelStateDir: () => '/tmp/none',
}))

vi.mock('../web/voice-modality.js', () => ({
  setLastInboundModality: vi.fn(),
}))

vi.mock('../web/main-agent.js', () => ({
  MAIN_CHANNELS_SESSION: 'marveen-channels',
}))

vi.mock('../web/agent-message-wrap.js', () => ({
  classifyAgentMessage: () => ({ category: 'trusted-peer', safeFrom: 'marveen' }),
  wrapAgentMessageForDelivery: () => ({ prefix: '', wrapped: 'wrapped' }),
}))

vi.mock('../web/telegram-inbox-wake.js', () => ({
  maybeWakeSubAgentsForTelegram: vi.fn(),
}))

import { runMessageRouterTick } from '../web/message-router.js'

function pending(taskId: string) {
  return [{
    id: 10,
    from_agent: 'marveen',
    to_agent: 'sage',
    content: 'Review this',
    task_id: taskId,
    origin_note: null,
    status: 'pending',
    result: null,
    created_at: Math.floor(Date.now() / 1000),
    delivered_at: null,
    completed_at: null,
  }]
}

describe('message router fresh-per-task boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockRestart.mockReturnValue({ ok: true })
  })

  it('restarts fresh and defers injection when the task id changes', async () => {
    activeTaskId = 'card:a'
    mockGetPendingMessages.mockReturnValue(pending('card:b'))

    await runMessageRouterTick()

    expect(mockRestart).toHaveBeenCalledWith('sage', { fresh: true })
    expect(mockWriteActive).toHaveBeenCalledWith('sage', expect.objectContaining({ taskId: 'card:b' }))
    expect(mockSendPrompt).not.toHaveBeenCalled()
  })

  it('keeps the live session and injects directly for the same task id', async () => {
    activeTaskId = 'card:a'
    mockGetPendingMessages.mockReturnValue(pending('card:a'))

    await runMessageRouterTick()

    expect(mockRestart).not.toHaveBeenCalled()
    expect(mockWriteActive).not.toHaveBeenCalled()
    expect(mockSendPrompt).toHaveBeenCalledWith('agent-sage', 'wrapped', null)
  })
})
