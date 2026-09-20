import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { checksums, formatChecksums } from './write-sha256sums.mjs'

describe('release checksums', () => {
  it('hashes and sorts artifact basenames', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'dispatch-checksums-'))
    try {
      const b = resolve(directory, 'b.tar.gz')
      const a = resolve(directory, 'a.dmg')
      await writeFile(b, 'b')
      await writeFile(a, 'a')
      const records = await checksums([b, a])
      assert.deepEqual(records.map(record => record.name), ['a.dmg', 'b.tar.gz'])
      assert.match(
        formatChecksums(records),
        /^[a-f0-9]{64}  a\.dmg\n[a-f0-9]{64}  b\.tar\.gz\n$/,
      )
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('rejects missing artifacts and duplicate basenames', async () => {
    await assert.rejects(checksums(['/tmp/dispatch-missing.dmg']), /ENOENT/)
    await assert.rejects(
      checksums(['/tmp/one/Dispatch.dmg', '/tmp/two/Dispatch.dmg']),
      /duplicate artifact basename/,
    )
  })
})
