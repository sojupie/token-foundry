import { useEffect, useMemo, useState } from 'react';
import { resolveResolver } from '../../lib/resolver.ts';
import type { ResolverModel, ResolverResolution } from '../../lib/resolver.ts';
import { errorMessage } from '../../lib/json.ts';
import { resolveVariantInWorker } from './workspace-review.ts';

const resolutions = new WeakMap<ResolverModel, Map<string, ResolverResolution>>();
type Inputs = Readonly<Record<string, string>>;

function store(model: ResolverModel, key: string, value: ResolverResolution) {
  let cache = resolutions.get(model);
  if (!cache) {
    cache = new Map();
    resolutions.set(model, cache);
  }
  if (cache.size >= 4) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, value);
  return value;
}

export function useVariantResolution(model: ResolverModel | undefined, inputs: Inputs, offThread: boolean) {
  const key = useMemo(() => JSON.stringify(Object.entries(inputs).toSorted(([a], [b]) => a.localeCompare(b))), [inputs]);
  const [result, setResult] = useState<{ model: ResolverModel; key: string; error?: string; value?: ResolverResolution }>();
  const cached = model && resolutions.get(model)?.get(key);
  const local = useMemo(() => model && !offThread ?
    resolutions.get(model)?.get(key) ?? store(model, key, resolveResolver(model, inputs)) : undefined, [model, key, inputs, offThread]);
  const matching = result?.model === model && result?.key === key ? result : undefined;
  const ready = local ?? cached ?? matching?.value;
  const pending = !!model && offThread && !ready && !matching?.error;

  useEffect(() => {
    if (!pending || !model) return undefined;
    const controller = new AbortController();
    const target = model;
    async function resolve() {
      try {
        const value = await resolveVariantInWorker(target, inputs, controller.signal);
        if (controller.signal.aborted) return;
        store(target, key, value);
        setResult({ model: target, key, value });
      } catch (failure) {
        if (!controller.signal.aborted) setResult({ model: target, key, error: errorMessage(failure) });
      }
    }
    void resolve();
    return () => controller.abort();
  }, [pending, model, inputs, key]);

  return { value: ready ?? (pending && result?.model === model ? result?.value : undefined), pending, error: matching?.error };
}
