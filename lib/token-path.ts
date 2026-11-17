function resolveFile(owner: string, target: string) {
  if (!owner || target.startsWith('/') || /[\\:?#]/u.test(target)) {
    throw new Error('Only relative pointers to open token files can be resolved.');
  }
  const parts = owner.split('/').slice(0, -1);
  for (const part of target.split('/')) {
    const segment = decodeURIComponent(part);
    if (/[\\/:]/u.test(segment)) throw new Error('Only relative pointers to open token files can be resolved.');
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      if (!parts.length) throw new Error('Pointer leaves the open checkout.');
      parts.pop();
    } else parts.push(segment);
  }
  return parts.join('/');
}

export function tokenPointer(ref: string, owner: string): { file: string; parts: string[] } {
  const separator = ref.indexOf('#');
  if (separator < 0) throw new Error('Expected a JSON Pointer.');
  const resource = ref.slice(0, separator);
  const file = resource ? resolveFile(owner, resource) : owner;
  const fragment = decodeURIComponent(ref.slice(separator + 1));
  if (!fragment || fragment === '/') return { file, parts: [] };
  if (!fragment.startsWith('/') || /~(?![01])/u.test(fragment)) throw new Error('Invalid JSON Pointer: ' + ref);
  const parts = fragment.slice(1).split('/').map(part => part.replaceAll('~1', '/').replaceAll('~0', '~'));
  return { file, parts };
}

export function resolverPointer(ref: string, file: string) {
  const hash = ref.indexOf('#');
  const target = hash < 0 ? ref + '#' : ref[hash + 1] && ref[hash + 1] !== '/' && !/^%2f/iu.test(ref.slice(hash + 1)) ?
    ref.slice(0, hash + 1) + '/' + ref.slice(hash + 1) : ref;
  return tokenPointer(target, file);
}

function pointerEscape(part: string): string {
  return encodeURIComponent(part.replaceAll('~', '~0').replaceAll('/', '~1'));
}

export function serializeTokenPointer(from: string, file: string, parts: readonly string[]): string {
  const source = from.split('/').slice(0, -1);
  const destination = file.split('/');
  let shared = 0;
  if (from !== file) {
    while (shared < source.length && shared < destination.length - 1 && source[shared] === destination[shared]) shared++;
  }
  const resource = from === file ? '' : [...source.slice(shared).map(() => '..'), ...destination.slice(shared).map(encodeURIComponent)].join('/');
  return resource + '#' + (parts.length ? '/' + parts.map(pointerEscape).join('/') : '');
}
