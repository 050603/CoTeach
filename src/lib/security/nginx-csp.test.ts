// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('gateway Content Security Policy ownership', () => {
  it.each(['deploy/nginx.conf', 'deploy/nginx/openpbl.conf.template', 'deploy/nginx/openpbl-http.conf.template'])('allows only the isolated resource player to use the application framing policy in %s', (path) => {
    const configuration = readFileSync(path, 'utf8');
    const framing = configuration.match(/map \$uri \$openpbl_frame_options \{([^}]+)\}/)?.[1];
    expect(framing).toBeDefined();
    expect(framing?.match(/default\s+"DENY";/)).toBeTruthy();
    // An empty edge value emits no conflicting header. Next owns SAMEORIGIN
    // for this exact route; all other responses retain the gateway's DENY.
    expect(framing?.match(/\/internal\/resource-player\s+"";/)).toBeTruthy();
    expect(framing?.trim().split('\n')).toHaveLength(2);
    expect(configuration).toContain('add_header X-Frame-Options $openpbl_frame_options always;');
    expect(configuration).not.toMatch(/proxy_hide_header\s+X-Frame-Options/);
    if (path === 'deploy/nginx.conf') {
      const ancestors = configuration.match(/map \$uri \$openpbl_frame_ancestors \{([^}]+)\}/)?.[1];
      expect(ancestors?.trim().split('\n')).toHaveLength(2);
      expect(ancestors).toContain('default "\'none\'";');
      expect(ancestors).toContain('/internal/resource-player "\'self\'";');
      expect(configuration).toContain('frame-ancestors $openpbl_frame_ancestors" always;');
    }
  });

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
