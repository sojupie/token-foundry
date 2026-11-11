export class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function fail(status: number, message: string): never {
  throw new HttpError(status, message);
}

const privateHeaders = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' };

export function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: privateHeaders });
}

export function redirect(location: string, cookies: string[] = []): Response {
  const headers = new Headers({ ...privateHeaders, Location: location });
  for (const entry of cookies) headers.append('Set-Cookie', entry);
  return new Response(null, { status: 303, headers });
}

export function cookie(name: string, value: string, maxAge: number): string {
  return name + '=' + value + '; Max-Age=' + maxAge + '; Path=/git; HttpOnly; Secure; SameSite=Lax';
}

export function readCookie(request: Request, name: string): string | undefined {
  return request.headers.get('Cookie')?.split(';').map((part) => part.trim()).find((part) => part.startsWith(name + '='))?.slice(name.length + 1);
}

export async function limitedText(message: Request | Response, maximum: number, status = 413): Promise<string> {
  if (Number(message.headers.get('Content-Length')) > maximum) fail(status, 'Token payload exceeds the size limit.');
  if (!message.body) return '';
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let text = '';
  let size = 0;
  for await (const chunk of message.body) {
    size += chunk.byteLength;
    if (size > maximum) fail(status, 'Token payload exceeds the size limit.');
    text += decoder.decode(chunk, { stream: true });
  }
  return text + decoder.decode();
}
