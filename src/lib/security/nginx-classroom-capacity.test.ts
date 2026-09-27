// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('campus classroom connection budgets', () => {
  it.each(['openpbl.conf.template', 'openpbl-http.conf.template'])('separates persistent sockets from concurrent HTTP requests in %s', name => {
    const template = readFileSync(`deploy/nginx/${name}`, 'utf8');
    const websocket = template.match(/location \/ws \{([\s\S]*?)\n    \}/)?.[1];
    expect(websocket).toContain('limit_conn per_ip_websocket 150;');
    expect(websocket).not.toContain('limit_conn per_ip_application');
    expect(template).toContain('limit_conn_zone $binary_remote_addr zone=per_ip_websocket:10m;');
    const ceiling = Number(template.match(/limit_conn per_ip_application (\d+);/)?.[1]);
    expect(ceiling).toBeGreaterThanOrEqual(42 * 20);
    expect(ceiling).toBeLessThanOrEqual(2048);
    expect(template).toContain('~^/(_next/static|brand)/ "";');
  });
});
