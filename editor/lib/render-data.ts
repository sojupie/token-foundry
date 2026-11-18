import { useMemo } from 'react';

/** A shared data snapshot passed by identity across React render boundaries. */
export class RenderData<T> {
  #value: T;

  constructor(value: T) {
    this.#value = value;
  }

  get value(): T {
    return this.#value;
  }

  get [Symbol.toStringTag]() {
    return 'RenderData';
  }
}

export function useRenderData<T>(value: T): RenderData<T> {
  return useMemo(() => new RenderData(value), [value]);
}
