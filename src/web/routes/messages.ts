import {
  createAgentMessage, getPendingMessages, listAgentMessages,
  getAgentConversation, getAgentConversationThreads,
  getKanbanSeqByIdPrefix,
  markMessageDone, markMessageFailed, getAgentMessage,
  type AgentMessage,
} from '../../db.js'
import { logger } from '../../logger.js'
import { COORDINATOR_AGENT_ID } from '../../channel-coordinator/ingest.js'
import { sanitizeAgentIdent } from '../../prompt-safety.js'
import { isKnownAgent, readAgentSessionPolicy } from '../agent-config.js'
import { isAgentRunning, stopAgentProcess } from '../agent-process.js'
import { removeDesiredAgent } from '../agent-desired-state.js'
import { readBody, json } from '../http-helpers.js'
import { normalizeKanbanRefs } from '../kanban-ref-normalize.js'
import { parseQualifiedId, formatQualifiedId } from '../federation/address.js'
import { getFederationConfig } from '../federation/config.js'
import {
  clearActiveAgentTask,
  formatTaskHandoff,
  normalizeTaskId,
  persistTaskHandoff,
  readActiveAgentTask,
  taskIdForMessage,
  validateTaskHandoff,
  type TaskHandoff,
} from '../fresh-task-policy.js'
import type { RouteContext } from './types.js'

export async function tryHandleMessages(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method, url } = ctx

  if (path === '/api/messages' && method === 'POST') {
    const body = await readBody(req)
    const { from, to, content, origin_note, task_id } = JSON.parse(body.toString()) as
      { from: string; to: string; content: string; origin_note?: string; task_id?: string }
    if (!from?.trim() || !to?.trim() || !content?.trim()) {
      json(res, { error: 'from, to, and content are required' }, 400)
      return true
    }
    // Security: the channel-coordinator id grants channel-inbound delivery
    // (verbatim <channel> + reply-expected framing) in the message-router. The
    // ONLY legitimate writer of that id is the in-process coordinator, which
    // inserts directly into the DB -- it never POSTs here. The dashboard token
    // is readable by every sub-agent, so without this guard any sub-agent could
    // forge a reply-expected message addressed at the main agent. Reject it.
    //
    // CRITICAL: normalize with the EXACT function the router matches on
    // (sanitizeAgentIdent), NOT from.trim(). The router does
    // CHANNEL_COORDINATOR_AGENTS.has(sanitizeAgentIdent(from)), and
    // sanitizeAgentIdent STRIPS [^a-zA-Z0-9_-] rather than trimming. A bypass
    // like from="@telegram-coordinator" / "telegram-coordinator." survives
    // .trim() (!= the constant) yet sanitizes to "telegram-coordinator" in the
    // router -> channel-inbound with an attacker-controlled body. Matching the
    // router's normalization here closes that asymmetry.
    if (sanitizeAgentIdent(from) === COORDINATOR_AGENT_ID) {
      logger.warn({ from: from.trim(), to: to.trim() }, 'Rejected /api/messages POST forging channel-coordinator id')
      json(res, { error: 'from is reserved for the in-process channel coordinator' }, 403)
      return true
    }
    // Federation spoof guard: a slash-qualified from ("teodor/teodor") is the
    // provenance mark of a REMOTE sender and may only ever be written by the
    // token-authenticated /api/federation/inbox. Accepting it here would let
    // any dashboard-token holder (i.e. every local sub-agent) impersonate a
    // federation peer toward another local agent.
    if (from.includes('/')) {
      logger.warn({ from: from.trim(), to: to.trim() }, 'Rejected /api/messages POST with qualified from (federation impersonation guard)')
      json(res, { error: 'from must be a local agent id without "/" -- federated senders are only accepted via /api/federation/inbox' }, 403)
      return true
    }
    // From-authentication: accept messages only from registered fleet agents.
    // The shared Bearer token is readable by any sub-agent, so without this
    // check any process with the token could inject messages as an arbitrary
    // sender ("from": "zack" from an external attacker who obtained the token).
    // Server-side validation: the `from` claim must match a known agent on the
    // filesystem (agents/<id>/ directory, or MAIN_AGENT_ID). This is not
    // impersonation-proof between fleet agents (they share the same token) but
    // it closes the "unknown sender" injection path without per-agent secrets.
    if (!isKnownAgent(sanitizeAgentIdent(from))) {
      logger.warn({ from: from.trim(), to: to.trim() }, 'Rejected /api/messages POST from unregistered agent')
      json(res, { error: `unknown agent '${from.trim()}' -- from must be a registered fleet agent id` }, 403)
      return true
    }
    // Qualified to ("peer/agent"): validate at creation time so the sender
    // gets an actionable error NOW instead of a silent 1h abandon. Local
    // (slash-free) recipients are untouched.
    let storedTo = to.trim()
    if (storedTo.includes('/')) {
      const target = parseQualifiedId(storedTo)
      if (!target) {
        json(res, { error: 'Invalid federated address in to (expected "<system>/<agent>")' }, 400)
        return true
      }
      const cfg = getFederationConfig()
      if (!cfg.enabled) {
        json(res, { error: 'Federation is disabled on this system' }, 400)
        return true
      }
      // System ids are case-insensitive (stored lowercase in the config).
      // Normalize the STORED prefix too: the per-peer purge SQL and the
      // bridge's peer lookup key on it, and thread grouping in the UI should
      // not split 'Teodor/x' from 'teodor/x'. The agent segment is the
      // PEER's namespace -- leave its case alone.
      const targetSystem = target.system.toLowerCase()
      if (targetSystem === cfg.systemId) {
        json(res, { error: `'${target.system}' is this system -- address the agent locally as '${target.agent}'` }, 400)
        return true
      }
      if (!cfg.peers.some((p) => p.id === targetSystem)) {
        json(res, { error: `Unknown federation peer '${target.system}'` }, 400)
        return true
      }
      storedTo = formatQualifiedId(targetSystem, target.agent)
    } else if (storedTo.includes(':')) {
      // A colon-form 'to' ("federation:teodor:teodor", copied from an
      // <untrusted source> attribute) is NOT a valid address: it has no '/',
      // so it would be treated as a LOCAL recipient, never match a session,
      // and silently sit pending until the 1h abandon window. Reject it now
      // with the correct form. Safe: sanitizeAgentIdent strips ':', so no
      // legitimate local agent id can contain one, and the channel
      // coordinator inserts directly into the DB, bypassing this endpoint.
      json(res, { error: 'Invalid recipient: use "<system>/<agent>" (slash) for a federated address, not the "federation:x:y" source form' }, 400)
      return true
    }
    // Code-side enforcement of the kanban-ref convention: rewrite any
    // `#<hex8>` token that maps to a real kanban_cards row into its
    // human-facing `#<seq>` form before persistence, so the dashboard and
    // every downstream consumer sees the canonical reference even when a
    // sub-agent forgets the CLAUDE.md rule (#75 Cuzcoo dispatch).
    const normalizedContent = normalizeKanbanRefs(content.trim(), getKanbanSeqByIdPrefix)
    // Card 06f062e4: optional attributability tag, self-declared like `from`
    // itself -- capped short so it stays a label, not a second content field.
    const trimmedOriginNote = origin_note?.trim().slice(0, 120) || null
    const normalizedTaskId = task_id === undefined ? null : normalizeTaskId(task_id)
    if (task_id !== undefined && !normalizedTaskId) {
      json(res, { error: 'task_id must be a non-empty string of at most 200 characters without control characters' }, 400)
      return true
    }
    const msg = createAgentMessage(from.trim(), storedTo, normalizedContent, trimmedOriginNote, normalizedTaskId)
    logger.info({
      id: msg.id,
      from: msg.from_agent,
      to: msg.to_agent,
      originNote: msg.origin_note,
      taskId: msg.task_id,
    }, 'Agent message created')
    json(res, msg)
    return true
  }

  // Sidebar threads: one row per conversation peer (system agents excluded),
  // each with its count + most-recent message, recency computed per-peer.
  if (path === '/api/messages/threads' && method === 'GET') {
    json(res, getAgentConversationThreads())
    return true
  }

  if (path === '/api/messages' && method === 'GET') {
    const agent = url.searchParams.get('agent') || ''
    const status = url.searchParams.get('status') || ''
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 200)
    const beforeRaw = url.searchParams.get('before')
    const before = beforeRaw !== null ? parseInt(beforeRaw, 10) : undefined

    let messages: AgentMessage[]
    if (status === 'pending' && agent) {
      messages = getPendingMessages(agent)
    } else if (status === 'pending') {
      messages = getPendingMessages()
    } else if (agent) {
      // SQL-filtered to THIS agent's last N (+ before-cursor pagination), not
      // global-last-N-then-JS-filter which starved rarely-active threads.
      messages = getAgentConversation(agent, limit, Number.isFinite(before as number) ? before : undefined)
    } else {
      messages = listAgentMessages(limit)
    }

    json(res, messages)
    return true
  }

  const msgUpdateMatch = path.match(/^\/api\/messages\/(\d+)$/)
  if (msgUpdateMatch && method === 'PUT') {
    const id = parseInt(msgUpdateMatch[1], 10)
    const body = await readBody(req)
    const {
      status: newStatus,
      result,
      task_complete: taskComplete,
      handoff: rawHandoff,
    } = JSON.parse(body.toString()) as {
      status: string
      result?: string
      task_complete?: boolean
      handoff?: unknown
    }

    const existing = getAgentMessage(id)
    let completedTaskId: string | null = null
    let completedHandoff: TaskHandoff | null = null
    let handoffPath: string | null = null
    if (taskComplete === true && existing && readAgentSessionPolicy(existing.to_agent) === 'fresh-per-task') {
      completedTaskId = taskIdForMessage(existing.id, existing.task_id)
      const active = readActiveAgentTask(existing.to_agent)
      if (!active || active.taskId !== completedTaskId) {
        json(res, {
          error: `Cannot close task '${completedTaskId}': it is not the active task for ${existing.to_agent}`,
        }, 409)
        return true
      }
      const validation = validateTaskHandoff(rawHandoff)
      if (!validation.ok) {
        json(res, { error: validation.error }, 400)
        return true
      }
      completedHandoff = validation.handoff
      // Persist before changing DB status or stopping the session: a close can
      // never succeed without its durable handoff already on disk.
      handoffPath = persistTaskHandoff(
        existing.to_agent,
        completedTaskId,
        existing.id,
        completedHandoff,
      )
    }

    let ok = false
    if (newStatus === 'done') ok = markMessageDone(id, result)
    else if (newStatus === 'failed') ok = markMessageFailed(id, result)

    if (ok) {
      // Notify the delegator: create a reverse message from executor → delegator so
      // they learn the result without polling. Use a sentinel prefix to break
      // ping-pong chains (the delegator might write back, which would trigger
      // markMessageDone on this notification; we skip creating ANOTHER notification
      // when the original content is already a completion report).
      const done = getAgentMessage(id)
      if (done && done.from_agent !== done.to_agent && !done.content.startsWith('[Eredmény]')) {
        const summary = completedHandoff && handoffPath
          ? `${result ? result.slice(0, 500) : '(nincs eredmény)'}\n\n[Durable handoff]\n${formatTaskHandoff(completedHandoff, handoffPath)}`
          : result ? result.slice(0, 500) : '(nincs eredmény)'
        createAgentMessage(
          done.to_agent,
          done.from_agent,
          `[Eredmény] msg_id:${id} status:${newStatus}\n\n${summary}`,
          null,
          done.task_id,
        )
      }
      if (completedTaskId && done) {
        clearActiveAgentTask(done.to_agent, completedTaskId)
        // A fresh-per-task consultant is near-zero-idle by design. Clear any
        // dashboard desired-state bit before stopping so the reconciler cannot
        // immediately resurrect it with an empty session.
        removeDesiredAgent(done.to_agent)
        if (isAgentRunning(done.to_agent)) {
          const stopped = stopAgentProcess(done.to_agent)
          if (!stopped.ok) {
            logger.warn(
              { agent: done.to_agent, taskId: completedTaskId, error: stopped.error },
              'fresh-per-task: handoff persisted and sent, but stopping the session failed',
            )
          }
        }
      }
      json(res, { ok: true }); return true
    }
    json(res, { error: 'Message not found or invalid status' }, 404)
    return true
  }

  return false
}
