/**
 * Router behavior for the owner-console display-only sink.
 *
 * A reply an agent addresses to OWNER_CONSOLE_ID (the operator's dashboard
 * chat) must be marked delivered and left for the Messages tab to render -- it
 * must NEVER enter the tmux-inject / abandon / handoff-failure machinery, and
 * must never wake the channels session.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockGetPendingMessages = vi.fn()
const mockSendPrompt = vi.fn()
const mockMarkDelivered = vi.fn((..._args: unknown[]) => true)
const mockSessionExists = vi.fn((..._args: unknown[]) => false)

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}))

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  MAIN_AGENT_ID: 'marveen',
  OWNER_CONSOLE_ID: 'owner',
  SUBAGENT_TELEGRAM_WAKE_ENABLED: false,
}))

vi.mock('../db.js', () => ({
  getPendingMessages: (toAgent?: string) => toAgent ? [] : mockGetPendingMessages(),
  markMessageDelivered: (...args: unknown[]) => mockMarkDelivered(...args),
  markMessageDone: vi.fn(() => true),
  markMessageFailed: vi.fn(() => true),
  markPendingFederatedFailed: vi.fn(() => true),
  setMessageResult: vi.fn(),
  createAgentMessage: vi.fn(),
}))

vi.mock('../web/agent-config.js', () => ({
  readAgentRemoteHost: () => null,
  readAgentRuntime: () => 'claude-tui',
  readAgentSessionPolicy: () => 'default',
  readAgentVoiceConfig: () => ({ responseMode: 'text' }),
}))

vi.mock('../web/agent-process.js', () => ({
  agentSessionName: (name: string) => `agent-${name}`,
  isSessionReadyForPrompt: vi.fn(async () => true),
  clearStaleParkedInput: vi.fn(async () => false),
  startAgentProcess: vi.fn(() => ({ ok: true })),
  restartAgentProcess: vi.fn(() => ({ ok: true })),
  sendPromptToSession: (...args: unknown[]) => mockSendPrompt(...args),
  sessionExistsOnHost: (...args: unknown[]) => mockSessionExists(...args),
}))

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
  classifyAgentMessage: () => ({ category: 'trusted-peer', safeFrom: 'sol' }),
  wrapAgentMessageForDelivery: () => ({ prefix: '', wrapped: 'wrapped' }),
}))

vi.mock('../web/telegram-inbox-wake.js', () => ({
  maybeWakeSubAgentsForTelegram: vi.fn(),
}))

import { runMessageRouterTick } from '../web/message-router.js'

function ownerReply(ageSeconds = 0) {
  return [{
    id: 42,
    from_agent: 'sol',
    to_agent: 'owner',
    content: 'Igen, itt vagyok.',
    task_id: null,
    origin_note: null,
    status: 'pending',
    result: null,
    created_at: Math.floor(Date.now() / 1000) - ageSeconds,
    delivered_at: null,
    completed_at: null,
  }]
}

describe('message router owner-console sink', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockMarkDelivered.mockReturnValue(true)
  })

  it('marks an owner-addressed reply delivered without any delivery attempt', async () => {
    mockGetPendingMessages.mockReturnValue(ownerReply())

    await runMessageRouterTick()

    expect(mockMarkDelivered).toHaveBeenCalledWith(42)
    expect(mockSendPrompt).not.toHaveBeenCalled()
  })

  it('never probes an owner session (excluded from the presence pre-pass)', async () => {
    mockGetPendingMessages.mockReturnValue(ownerReply())

    await runMessageRouterTick()

    // sessionExistsOnHost is only called for real receivers; owner is not one.
    for (const call of mockSessionExists.mock.calls) {
      expect(call).not.toContain('agent-owner')
    }
  })

  it('does not abandon an aged owner reply (no handoff-failure churn)', async () => {
    // Well past any abandon window; a real sessionless agent would be abandoned.
    mockGetPendingMessages.mockReturnValue(ownerReply(6 * 60 * 60))

    await runMessageRouterTick()

    expect(mockMarkDelivered).toHaveBeenCalledWith(42)
    expect(mockSendPrompt).not.toHaveBeenCalled()
  })
})
