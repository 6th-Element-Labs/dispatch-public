/** Detect suspended timers without changing the Mac's power settings. */
export class ResumeClock {
  #last: number
  constructor(now = Date.now(), readonly gapMs = 30_000) { this.#last = now }
  observe(now = Date.now()): boolean {
    const resumed = now - this.#last > this.gapMs || now < this.#last
    this.#last = now
    return resumed
  }
}
