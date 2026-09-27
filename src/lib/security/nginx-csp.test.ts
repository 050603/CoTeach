// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('gateway Content Security Policy ownership', () => {
  it.each(['openpbl.conf.template', 'openpbl-http.conf.template'])('preserves the application runtime policy in %s', (name) => {
    const template = readFileSync(`deploy/nginx/${name}`, 'utf8');
    expect(template).not.toMatch(/^\s*proxy_hide_header\s+Content-Security-Policy\s*;/mi);
    // A second restrictive source list intersects the upstream policy and can
    // silently disable a runtime even when the application permits it.
    const edgePolicies = [...template.matchAll(/^\s*add_header\s+Content-Security-Policy\s+"([^"]*)"\s+always;/gmi)].map((match) => match[1]);
    expect(edgePolicies).toEqual(name === 'openpbl.conf.template' ? ['upgrade-insecure-requests'] : []);
    expect(template).toContain('proxy_set_header Host $host;');
    expect(template).toContain(`proxy_set_header X-Forwarded-Proto ${name === 'openpbl.conf.template' ? 'https' : 'http'};`);
  });
});
