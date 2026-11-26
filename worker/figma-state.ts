export { SharedWorkspaceStore, WorkspaceRegistry } from './workspace.ts';

// The state Worker has no public route. Only bound Workers reach its objects.
export default { fetch: () => new Response('Route not found.', { status: 404 }) };
