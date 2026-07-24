/**
 * Owner-console direct chat identity.
 *
 * The dashboard Messages tab lets the operator chat DIRECTLY with a fleet agent
 * (e.g. the channel-less Sage/Sol). The composer sends as the reserved
 * OWNER_CONSOLE_ID -- not the live main agent -- so the recipient's reply is a
 * display-only sink (persisted, never injected into the channels session).
 * These tests lock the invariants that make that safe and coherent across the
 * server constant, the from-auth guard, the router sink, and the client copy.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { OWNER_CONSOLE_ID, MAIN_AGENT_ID } from '../config.js'
import { isKnownAgent } from '../web/agent-config.js'

const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..')
const REPO_ROOT = join(SRC_DIR, '..')

describe('owner-console chat identity', () => {
  it('is the reserved slug and distinct from the live main agent', () => {
    expect(OWNER_CONSOLE_ID).toBe('owner')
    expect(OWNER_CONSOLE_ID).not.toBe(MAIN_AGENT_ID)
  })

  it('is accepted by isKnownAgent so the /api/messages from-auth guard passes', () => {
    expect(isKnownAgent(OWNER_CONSOLE_ID)).toBe(true)
  })

  it('the client copy in web/app.js stays byte-identical to the server constant', () => {
    const src = readFileSync(join(REPO_ROOT, 'web/app.js'), 'utf-8')
    expect(src).toMatch(/const OWNER_CONSOLE_ID = 'owner'/)
    // The composer sends AS the owner-console id, never the live main agent.
    expect(src).toContain('const from = OWNER_CONSOLE_ID')
    // The operator's own bubbles render outgoing.
    expect(src).toMatch(/m\.from_agent === OWNER_CONSOLE_ID/)
  })

  it('the router source treats owner-console replies as a display-only sink', () => {
    const src = readFileSync(join(SRC_DIR, 'web/message-router.ts'), 'utf-8')
    expect(src).toMatch(/msg\.to_agent === OWNER_CONSOLE_ID/)
    // The sink marks delivered and continues -- never abandons or wakes.
    expect(src).toMatch(/OWNER_CONSOLE_ID[\s\S]{0,200}markMessageDelivered/)
  })

  it('is excluded from the sidebar peer list', () => {
    const src = readFileSync(join(SRC_DIR, 'db.ts'), 'utf-8')
    expect(src).toMatch(/CHAT_SYSTEM_AGENTS = \[[^\]]*OWNER_CONSOLE_ID/)
  })
})
