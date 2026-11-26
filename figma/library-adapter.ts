export interface LibraryResult { components: number; variants: number; pages: string[]; collections?: number; styles?: number }
export interface LibraryAdapter {
  name: string;
  required?: readonly string[];
  numberScale?: (path: string) => 1 | 100;
  build: (variables: ReadonlyMap<string, Variable>) => Promise<LibraryResult>;
}
// Brand-specific component mappings belong to the source design system, not the generic bridge.
export const libraryAdapter: LibraryAdapter | undefined = undefined;
