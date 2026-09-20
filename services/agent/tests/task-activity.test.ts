import { expect, it } from 'vitest'
import { TaskActivity } from '../src/task-activity.js'

it('marks disconnected work interrupted instead of blocking service updates forever', () => {
  const activity = new TaskActivity()
  activity.accept({ method: 'turn/started', params: { threadId: 'a', turn: { id: 'turn-a' } } })
  activity.disconnected()
  expect(activity.tasks.get('a')).toMatchObject({ status: 'Interrupted', requests: [] })
  expect(activity.tasks.get('a')?.turnId).toBeUndefined()
})

it('retains independent running turns and approvals without a UI subscriber', () => {
  const activity = new TaskActivity()
  activity.accept({ method: 'turn/started', params: { threadId: 'a', turn: { id: 'turn-a' } } })
  activity.accept({ method: 'turn/started', params: { threadId: 'b', turn: { id: 'turn-b' } } })
  activity.accept({ id: 0, method: 'item/tool/requestApproval', params: { threadId: 'a' } })
  expect(activity.tasks.get('a')).toMatchObject({ status: 'Needs attention', turnId: 'turn-a', requests: [{ id: 0 }] })
  expect(activity.tasks.get('b')).toMatchObject({ status: 'Working', turnId: 'turn-b' })
  activity.resolve(0)
  expect(activity.tasks.get('a')).toMatchObject({ status: 'Working', requests: [] })
  activity.accept({ method: 'turn/completed', params: { threadId: 'b', turn: { status: 'completed' } } })
  expect(activity.tasks.get('b')).toMatchObject({ status: 'Complete', requests: [] })
  expect(activity.tasks.get('a')?.turnId).toBe('turn-a')
})
