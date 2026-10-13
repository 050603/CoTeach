// Reasoning models need time to complete both generation and review. Keep the
// transport and database lease alive long enough to receive the durable result.
export const COLLABORATION_EXECUTION_TIMEOUT_MS = 110_000;
export const COLLABORATION_BROWSER_TIMEOUT_MS = 120_000;
export const COLLABORATION_REQUEST_LEASE_MS = 125_000;
