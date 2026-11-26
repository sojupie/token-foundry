import { expect, test as base } from '@playwright/test';

declare global { interface Window { foundryRuntimeError?: (message: string) => Promise<void> } }

/** Interaction assertions alone must not certify a page that logged an uncaught exception. */
export const test = base.extend<{ runtimeChecks: void }>({
  runtimeChecks: [async ({ context }, use) => {
    const errors = new Set<string>();
    context.on('page', page => page.on('console', message => {
      if (message.type() === 'error' && /Cannot update a component|Maximum update depth exceeded|Rendered (?:more|fewer) hooks/u.test(message.text())) errors.add(message.text());
    }));
    await context.exposeFunction('foundryRuntimeError', (message: string) => { errors.add(message); });
    await context.addInitScript(() => {
      const report = console.error.bind(console);
      console.error = (...values: unknown[]) => {
        if (typeof values[0] === 'string' && /Cannot update a component|Maximum update depth exceeded|Rendered (?:more|fewer) hooks/u.test(values[0])) {
          void window.foundryRuntimeError?.(values.map(String).join(' ') + '\n' + (new Error('React runtime warning').stack ?? ''));
        }
        report(...values);
      };
      window.addEventListener('error', event => {
        void window.foundryRuntimeError?.(event.error instanceof Error ? event.error.stack ?? event.message : event.message);
      }, true);
      window.addEventListener('unhandledrejection', (event: PromiseRejectionEvent) => {
        const reason: unknown = event.reason;
        void window.foundryRuntimeError?.(reason instanceof Error ? reason.stack ?? reason.message : String(reason));
      });
    });
    await use();
    expect([...errors], 'Uncaught browser errors').toEqual([]);
  }, { auto: true }],
});
