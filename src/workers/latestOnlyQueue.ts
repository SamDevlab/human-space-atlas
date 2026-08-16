export class LatestOnlyQueue<T> {
  private running = false
  private pending: T | null = null

  get activeCount(): number { return this.running ? 1 : 0 }
  get pendingCount(): number { return this.pending === null ? 0 : 1 }

  submit(value: T): T | null {
    if (this.running) {
      this.pending = value
      return null
    }
    this.running = true
    return value
  }

  complete(): T | null {
    const next = this.pending
    this.pending = null
    if (next === null) {
      this.running = false
      return null
    }
    return next
  }

  clear(): void {
    this.running = false
    this.pending = null
  }
}
