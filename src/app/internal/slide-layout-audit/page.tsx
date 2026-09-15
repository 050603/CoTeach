import type { Metadata } from 'next';
import { LayoutAuditClient } from './layout-audit-client';

export const metadata: Metadata = {
  title: 'Slide layout audit',
  robots: { index: false, follow: false },
};

/** Empty until the loopback-only Playwright auditor supplies a slide in memory. */
export default function SlideLayoutAuditPage() {
  return <LayoutAuditClient />;
}
