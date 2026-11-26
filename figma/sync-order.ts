export class ObsoleteSync extends Error {}
export class StaleWorkspace extends Error { constructor(message = 'A newer workspace update is already available. Your current values are retained.') { super(message); } }

/** A connection lifetime owns its requests, including work waiting on the controller. */
export class SyncOrder {
  private generation = 0;
  private readonly versions = new Map<string, number>();
  current() { return this.generation; }
  begin() { return ++this.generation; }
  active(generation: number) { return generation === this.generation; }
  assert(generation: number) { if (!this.active(generation)) throw new ObsoleteSync(); }
  accept(generation: number, identity?: { id: string; version?: number }) {
    this.assert(generation);
    if (!identity) return;
    const previous = this.versions.get(identity.id);
    if (previous !== undefined && (identity.version === undefined || identity.version < previous)) throw new StaleWorkspace();
    if (identity.version !== undefined) this.versions.set(identity.id, identity.version);
  }
}
