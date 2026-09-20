import type { RpcMessage } from './json-line-rpc.js'

/** Harness state survives changing the visible email; it does not drive turns. */
export class TaskActivity {
  readonly tasks = new Map<string, { threadId: string; status: string; turnId?: string; requests: RpcMessage[] }>()

  disconnected(): void {
    for (const task of this.tasks.values()) {
      if (!['Working', 'Needs attention'].includes(task.status)) continue
      task.status = 'Interrupted'; task.turnId = undefined; task.requests = []
    }
  }

  accept(message: RpcMessage): boolean {
    const p = message.params as { threadId?: string; requestId?: string | number; turn?: { id?: string; status?: string } } | undefined
    if (message.method === 'serverRequest/resolved') return this.resolve(p?.requestId)
    if (!p?.threadId) return false
    const task = this.tasks.get(p.threadId) ?? { threadId: p.threadId, status: 'Connected', requests: [] }
    if (message.id !== undefined && message.method) {
      task.requests = [...task.requests.filter(r => r.id !== message.id), message]
      task.status = 'Needs attention'
    } else if (message.method === 'turn/started') {
      task.turnId = p.turn?.id; task.status = 'Working'
    } else if (message.method === 'turn/completed') {
      task.turnId = undefined; task.requests = []
      task.status = p.turn?.status === 'failed' ? 'Failed' : p.turn?.status === 'interrupted' ? 'Interrupted' : 'Complete'
    } else return false
    this.tasks.set(p.threadId, task)
    return true
  }

  resolve(id: unknown): boolean {
    for (const task of this.tasks.values()) {
      if (!task.requests.some(r => r.id === id || String(r.id) === String(id))) continue
      task.requests = task.requests.filter(r => String(r.id) !== String(id))
      task.status = task.requests.length ? 'Needs attention' : task.turnId ? 'Working' : 'Connected'
      return true
    }
    return false
  }

  summary() { return [...this.tasks.values()].map(({ requests: _requests, ...task }) => task) }
}
