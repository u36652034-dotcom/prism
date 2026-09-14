/**
 * FallbackService: Automatic provider fallback chain
 * - Maintains fallback order for each model
 * - Tracks provider health (failures, cooldowns)
 * - Routes requests through fallback chain on errors
 * - Auto-recovers failed providers
 */

import { Database } from '../db';
import { upstreamConfigs } from '../db/schema';
import { like, sql } from 'drizzle-orm';

export interface ProviderHealth {
  id: string;
  name: string;
  status: 'healthy' | 'cooldown' | 'disabled';
  failures: number;
  lastFailure?: number;
  cooldownUntil?: number;
  failureReason?: string;
}

export interface FallbackChain {
  model: string;
  chain: Array<{
    id: string;
    name: string;
    priority: number; // Lower = higher priority
  }>;
}

export class FallbackService {
  // In-memory health tracking (persisted per Worker warm-up)
  private healthMap: Map<string, ProviderHealth> = new Map();
  private readonly COOLDOWN_DURATION_MS = 5 * 60 * 1000; // 5 minutes
  private readonly MAX_COOLDOWN_ATTEMPTS = 3;

  constructor(private db: Database) {}

  /**
   * Get all upstream providers that support a specific model
   * Returns in priority order (first = preferred)
   */
  async getProviderChainForModel(modelName: string): Promise<ProviderHealth[]> {
    const configs = await this.db
      .select()
      .from(upstreamConfigs)
      .where(like(upstreamConfigs.available_models, `%"${modelName}"%`));

    const chain: ProviderHealth[] = configs.map((config: any) => {
      const id = config.id;
      const existingHealth = this.healthMap.get(id);

      // Check if cooldown has expired
      if (
        existingHealth?.status === 'cooldown' &&
        existingHealth.cooldownUntil &&
        Date.now() > existingHealth.cooldownUntil
      ) {
        // Recover from cooldown
        existingHealth.status = 'healthy';
        existingHealth.failures = 0;
        existingHealth.cooldownUntil = undefined;
      }

      return (
        existingHealth || {
          id,
          name: config.name,
          status: 'healthy',
          failures: 0,
        }
      );
    });

    // Sort by status priority: healthy first, then cooldown, then disabled
    return chain.sort((a, b) => {
      const statusPriority: Record<string, number> = {
        healthy: 0,
        cooldown: 1,
        disabled: 2,
      };
      return statusPriority[a.status] - statusPriority[b.status];
    });
  }

  /**
   * Mark provider failure and update cooldown
   * - 401/403: Permanently disable
   * - 429: Cooldown with progressive backoff
   * - 5xx: Cooldown with progressive backoff
   */
  recordProviderFailure(
    providerId: string,
    providerName: string,
    statusCode: number,
    errorMessage?: string
  ): void {
    let health = this.healthMap.get(providerId);

    if (!health) {
      health = {
        id: providerId,
        name: providerName,
        status: 'healthy',
        failures: 0,
      };
    }

    health.failures += 1;
    health.lastFailure = Date.now();
    health.failureReason = errorMessage || `HTTP ${statusCode}`;

    if (statusCode === 401 || statusCode === 403) {
      // Permanently disable on auth errors
      health.status = 'disabled';
      console.warn(
        `[Fallback] Provider ${providerName} (${providerId}) DISABLED: Auth error ${statusCode}`
      );
    } else if (statusCode === 429 || statusCode >= 500) {
      // Cooldown on rate-limit or server errors
      health.status = 'cooldown';
      // Progressive backoff: 5min, 10min, 30min
      const backoffMultiplier = Math.min(health.failures - 1, 2); // Cap at 2 (30min max)
      const cooldownMs = this.COOLDOWN_DURATION_MS * Math.pow(2, backoffMultiplier);
      health.cooldownUntil = Date.now() + cooldownMs;
      console.warn(
        `[Fallback] Provider ${providerName} (${providerId}) in COOLDOWN for ${cooldownMs / 1000 / 60}min: HTTP ${statusCode}`
      );
    }

    this.healthMap.set(providerId, health);
  }

  /**
   * Mark provider success and recover from cooldown
   */
  recordProviderSuccess(providerId: string): void {
    const health = this.healthMap.get(providerId);
    if (health) {
      health.status = 'healthy';
      health.failures = 0;
      health.cooldownUntil = undefined;
      health.lastFailure = undefined;
      this.healthMap.set(providerId, health);
    }
  }

  /**
   * Get provider health status
   */
  getProviderHealth(providerId: string): ProviderHealth | undefined {
    return this.healthMap.get(providerId);
  }

  /**
   * Get health status of all providers
   */
  getAllHealthStatus(): ProviderHealth[] {
    return Array.from(this.healthMap.values());
  }

  /**
   * Check if error is retryable
   * - 401/403: Not retryable (auth error)
   * - 4xx: Not retryable (client error)
   * - 429: Retryable (rate limit)
   * - 5xx: Retryable (server error)
   */
  isErrorRetryable(statusCode: number): boolean {
    if (statusCode === 401 || statusCode === 403) return false; // Auth errors not retryable
    if (statusCode >= 400 && statusCode < 500 && statusCode !== 429) return false; // Other client errors not retryable
    return true; // 429 and 5xx are retryable
  }

  /**
   * Clear all health data (useful for testing or reset)
   */
  resetAllHealth(): void {
    this.healthMap.clear();
  }
}
