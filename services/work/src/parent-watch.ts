import { Readable } from 'node:stream'

/** Native services stop when their owning app disappears; standalone runs are unchanged. */
export function watchParent(owner: string | undefined, close: () => void, input: Readable = process.stdin, probe: (pid: number) => boolean = parentAlive): () => void {
  const pid = Number(owner)
  if (!Number.isSafeInteger(pid) || pid <= 1) return () => {}
  let stopped = false
  const stop = () => {
    if (stopped) return
    stopped = true; clearInterval(timer); input.off('end', stop)
    process.stderr.write('Dispatch parent exited; stopping owned service.\n')
    close()
  }
  const timer = setInterval(() => { if (!probe(pid)) stop() }, 500)
  timer.unref()
  input.once('end', stop); input.resume()
  if (!probe(pid)) stop()
  return () => { stopped = true; clearInterval(timer); input.off('end', stop); input.pause() }
}
function parentAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH' }
}
