/**
 * Playwright Global Singleton Manager
 *
 * Manages Playwright instances at the event loop level to prevent
 * duplicate instantiation and ensure proper resource cleanup.
 *
 * This is important because:
 * 1. Playwright instances are heavy and should be reused
 * 2. Multiple instances can cause port conflicts
 * 3. Proper cleanup prevents resource leaks
 */

import { createLogger } from '../logging-config.js';

const logger = createLogger('browser_use.playwright_manager');

// Global registry of Playwright instances keyed by event loop/process
const playwrightInstances = new Map<string, any>();
const instanceRefCounts = new Map<string, number>();

// Track cleanup handlers
const cleanupHandlers = new Set<() => Promise<void>>();

/**
 * Get or create a Playwright instance for the current event loop
 * Uses singleton pattern to prevent duplicate instances
 */
export async function getPlaywrightInstance(
  options: {
    browserType?: 'chromium' | 'firefox' | 'webkit';
    forceNew?: boolean;
  } = {}
): Promise<any> {
  const { browserType = 'chromium', forceNew = false } = options;

  // Use process ID as key for singleton (Node.js is single event loop per process)
  const instanceKey = `${process.pid}-${browserType}`;

  // Return existing instance if available and not forcing new
  if (!forceNew && playwrightInstances.has(instanceKey)) {
    const instance = playwrightInstances.get(instanceKey);
    // Increment reference count
    instanceRefCounts.set(
      instanceKey,
      (instanceRefCounts.get(instanceKey) || 0) + 1
    );
    logger.debug(
      `Reusing Playwright ${browserType} instance (refs: ${instanceRefCounts.get(instanceKey)})`
    );
    return instance;
  }

  // Create new instance
  logger.info(`Creating new Playwright ${browserType} instance`);

  try {
    const playwright = await import('playwright');
    const instance = playwright[browserType];

    // Store instance
    playwrightInstances.set(instanceKey, instance);
    instanceRefCounts.set(instanceKey, 1);

    logger.debug(`Playwright ${browserType} instance created successfully`);
    return instance;
  } catch (error) {
    logger.error(
      `Failed to create Playwright instance: ${(error as Error).message}`
    );
    throw error;
  }
}

/**
 * Release a Playwright instance reference
 * Decrements reference count and cleans up if no more references
 */
export async function releasePlaywrightInstance(
  browserType: 'chromium' | 'firefox' | 'webkit' = 'chromium'
): Promise<void> {
  const instanceKey = `${process.pid}-${browserType}`;

  if (!playwrightInstances.has(instanceKey)) {
    logger.warning(
      `Attempted to release non-existent Playwright instance: ${instanceKey}`
    );
    return;
  }

  // Decrement reference count
  const currentRefs = instanceRefCounts.get(instanceKey) || 0;
  const newRefs = Math.max(0, currentRefs - 1);
  instanceRefCounts.set(instanceKey, newRefs);

  logger.debug(
    `Released Playwright ${browserType} instance reference (refs: ${newRefs})`
  );

  // If no more references, we could clean up, but Playwright itself doesn't need cleanup
  // The actual browser instances are cleaned up separately
  if (newRefs === 0) {
    logger.debug(
      `No more references to Playwright ${browserType} instance, keeping for reuse`
    );
    // We keep the instance for potential reuse rather than deleting it
  }
}

/**
 * Force cleanup of all Playwright instances
 * Should be called on process exit
 */
export async function cleanupAllPlaywrightInstances(): Promise<void> {
  logger.info(`Cleaning up ${playwrightInstances.size} Playwright instances`);

  // Execute all registered cleanup handlers
  const cleanupPromises = Array.from(cleanupHandlers).map((handler) =>
    handler().catch((error) => {
      logger.error(`Cleanup handler failed: ${(error as Error).message}`);
    })
  );

  await Promise.all(cleanupPromises);

  // Clear registries
  playwrightInstances.clear();
  instanceRefCounts.clear();
  cleanupHandlers.clear();

  logger.info('All Playwright instances cleaned up');
}

/**
 * Register a cleanup handler to be called on shutdown
 */
export function registerCleanupHandler(handler: () => Promise<void>): void {
  cleanupHandlers.add(handler);
}

/**
 * Unregister a cleanup handler
 */
export function unregisterCleanupHandler(handler: () => Promise<void>): void {
  cleanupHandlers.delete(handler);
}

/**
 * Get statistics about Playwright instances
 */
export function getPlaywrightStats(): {
  totalInstances: number;
  instances: Array<{ key: string; refs: number }>;
} {
  return {
    totalInstances: playwrightInstances.size,
    instances: Array.from(playwrightInstances.keys()).map((key) => ({
      key,
      refs: instanceRefCounts.get(key) || 0,
    })),
  };
}
