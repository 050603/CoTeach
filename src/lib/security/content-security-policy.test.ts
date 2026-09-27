import { describe, expect, it } from 'vitest';
import { contentSecurityPolicy, requestCspOrigin } from './content-security-policy';

describe('sandbox runtime connection policy', () => {
  it.each(['http://127.0.0.1:3000', 'http://192.168.1.10:3000', 'https://school.example', 'https://[::1]:8443'])('permits only the concrete current origin %s alongside self', (origin) => {
    const csp = contentSecurityPolicy(origin, false);
    const connection = csp.split('; ').find((directive) => directive.startsWith('connect-src'));
    expect(connection).toBe(`connect-src 'self' data: wss: ${origin}`);
    expect(csp).toContain("script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'");
    expect(csp).not.toContain("'unsafe-eval'");
    expect(connection).not.toContain('*');
    expect(connection?.split(' ')).not.toContain('https:');
  });

  it('uses the forwarded protocol with the actual Host behind the reverse proxy', () => {
    expect(requestCspOrigin('http://127.0.0.1:3000/teacher', 'school.example', 'https')).toBe('https://school.example');
    expect(requestCspOrigin('http://127.0.0.1:3000/', '[::1]:8080', null)).toBe('http://[::1]:8080');
  });

  it.each(['school.example; script-src *', 'school.example/path', 'user@school.example', '*.school.example', 'school.example?x=1'])('rejects an authority that could add or alter CSP sources: %s', (host) => {
    expect(requestCspOrigin('https://school.example/', host, 'https')).toBeUndefined();
  });

  it('does not reflect unsupported protocols', () => {
    expect(requestCspOrigin('https://school.example/', 'school.example', 'data')).toBeUndefined();
  });
});
