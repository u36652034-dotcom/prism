/**
 * Enhanced proxy with automatic fallback chain
 * Integrates FallbackService to retry failed requests across providers
 */

import { Env } from './types';
import { KeyService } from './services/key.service';
import { UpstreamService } from './services/upstream.service';
import { AuditLogService } from './services/audit.service';
import { SettingsService } from './services/settings.service';
import { FallbackService } from './services/fallback.service';
import { getDb } from './db';
import { ProviderFactory } from './providers';
import {
  anthropicToOpenAiPayload,
  openAiToAnthropicResponse,
  createOpenAiToAnthropicSseTransform,
} from './adapter';

export async function proxyAndAuditRequestWithFallback(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  params: {
    protocol: 'openai' | 'anthropic';
    upstreamPath: string;
    keyRecord: any;
    bodyJson: any;
  }
): Promise<Response> {
  const { protocol, upstreamPath, keyRecord, bodyJson } = params;
  const modelName = bodyJson.model;

  const db = getDb(env.DB);
  const upstreamService = new UpstreamService(db);
  const keyService = new KeyService(db);
  const auditService = new AuditLogService(db);
  const settingsService = new SettingsService(db);
  const fallbackService = new FallbackService(db);

  // Parse allowed_models array from keyRecord
  let allowedModelsArray: string[] = [];
  try {
    allowedModelsArray = typeof keyRecord.allowed_models === 'string'
      ? JSON.parse(keyRecord.allowed_models)
      : keyRecord.allowed_models || [];
  } catch {
    allowedModelsArray = [];
  }

  // Get fallback chain for this model
  const providerChain = await fallbackService.getProviderChainForModel(modelName);

  if (providerChain.length === 0) {
    return new Response(
      JSON.stringify({
        error: {
          message: `No upstream provider configured for model '${modelName}'. Please configure an upstream in the dashboard.`,
          type: 'no_upstream_configured',
        },
      }),
      { status: 502, headers: { 'Content-Type': 'application/json' } }
    );
  }

  let lastError: Response | null = null;
  const attemptsLog: Array<{ provider: string; status: number; error?: string }> = [];

  // Try each provider in fallback chain
  for (const providerHealth of providerChain) {
    // Skip disabled providers
    if (providerHealth.status === 'disabled') {
      attemptsLog.push({
        provider: providerHealth.name,
        status: 0,
        error: 'Provider disabled due to auth failures',
      });
      continue;
    }

    try {
      const upstreamConfig = await upstreamService.findById(providerHealth.id);
      if (!upstreamConfig) continue;

      const globalSettings = await settingsService.getAllSettings();
      const cfAccountId = globalSettings.cf_account_id || '';
      const cfGatewayId = globalSettings.cf_gateway_id || 'default';
      const cfApiToken = globalSettings.cf_api_token || '';

      // Prepare request for this provider
      const startTime = Date.now();
      const upstreamProtocol = upstreamConfig.api_protocol || 'openai';
      const isAnthropicToOpenAi = protocol === 'anthropic' && upstreamProtocol === 'openai';

      const forwardedPayload = isAnthropicToOpenAi
        ? anthropicToOpenAiPayload(bodyJson)
        : bodyJson;

      const effectiveUpstreamPath = isAnthropicToOpenAi ? '/v1/chat/completions' : upstreamPath;

      // Construct target URL
      let targetUrl = '';
      let providerCustomHeaders: Record<string, string> = {};
      let upstreamApiKey = upstreamConfig.api_key;

      if (upstreamConfig.provider_type === 'cf_workers_ai') {
        // Workers AI: Use env.AI binding
        if (env.AI) {
          try {
            const aiResult = await env.AI.run(modelName, bodyJson, {
              gateway: {
                id: cfGatewayId,
                skipCache: false,
              },
            });

            fallbackService.recordProviderSuccess(upstreamConfig.id);
            const durationMs = Date.now() - startTime;
            const responseStr = typeof aiResult === 'string' ? aiResult : JSON.stringify(aiResult);

            ctx.waitUntil(
              auditService.recordLog(
                {
                  logId: crypto.randomUUID(),
                  keyId: keyRecord.id,
                  protocol,
                  modelName,
                  bodyJson,
                  responseContent: responseStr,
                  promptTokens: 0,
                  completionTokens: 0,
                  durationMs,
                  candidateName: keyRecord.candidate_name,
                },
                (globalSettings.log_storage_engine as 'd1' | 'r2') || 'd1',
                env.LOG_BUCKET
              )
            );

            return new Response(responseStr, {
              headers: { 'Content-Type': 'application/json' },
            });
          } catch (err: any) {
            fallbackService.recordProviderFailure(
              upstreamConfig.id,
              upstreamConfig.name,
              500,
              err.message
            );
            attemptsLog.push({
              provider: upstreamConfig.name,
              status: 500,
              error: `Workers AI error: ${err.message}`,
            });
            continue; // Try next provider
          }
        }
      } else if (upstreamConfig.provider_type === 'cf_ai_gateway') {
        // Cloudflare AI Gateway
        const slug = upstreamConfig.cf_aig_provider || 'openai';
        const providerHandler = ProviderFactory.getHandler(slug);
        const requestBuilt = providerHandler.buildRequest({
          cfAccountId,
          cfGatewayId,
          cfApiToken,
          upstreamApiKey,
          effectiveUpstreamPath,
          customBaseUrl: upstreamConfig.base_url,
          incomingHeaders: request.headers,
        });

        targetUrl = requestBuilt.targetUrl;
        providerCustomHeaders = requestBuilt.headers;
      } else {
        // Custom endpoint
        const cleanBase = upstreamConfig.base_url.replace(/\/+$/, '');
        if (cleanBase.endsWith('/v1') && effectiveUpstreamPath.startsWith('/v1')) {
          targetUrl = `${cleanBase}${effectiveUpstreamPath.replace('/v1', '')}`;
        } else {
          targetUrl = `${cleanBase}${effectiveUpstreamPath}`;
        }
      }

      // Prepare headers
      const headers = new Headers(request.headers);
      headers.delete('host');
      headers.delete('authorization');
      headers.delete('x-api-key');

      if (upstreamConfig.provider_type === 'cf_ai_gateway') {
        Object.entries(providerCustomHeaders).forEach(([k, v]) => {
          headers.set(k, v);
        });
        if (cfApiToken) {
          headers.set('cf-aig-authorization', `Bearer ${cfApiToken}`);
        }
      } else {
        if (upstreamApiKey) {
          headers.set('Authorization', `Bearer ${upstreamApiKey}`);
        }
      }

      // Make request to upstream
      const upstreamResponse = await fetch(targetUrl, {
        method: request.method,
        headers,
        body: JSON.stringify(forwardedPayload),
      });

      // Check if response is successful
      if (upstreamResponse.ok || upstreamResponse.status === 200) {
        fallbackService.recordProviderSuccess(upstreamConfig.id);
        // Return successful response (handle streaming/non-streaming in original proxy.ts)
        return upstreamResponse;
      }

      // Check if error is retryable
      if (!fallbackService.isErrorRetryable(upstreamResponse.status)) {
        // Non-retryable error (auth, client error)
        fallbackService.recordProviderFailure(
          upstreamConfig.id,
          upstreamConfig.name,
          upstreamResponse.status
        );
        attemptsLog.push({
          provider: upstreamConfig.name,
          status: upstreamResponse.status,
          error: upstreamResponse.statusText,
        });
        lastError = upstreamResponse;
        // Continue to next provider only if it's a retryable error
        if (!fallbackService.isErrorRetryable(upstreamResponse.status)) {
          continue;
        }
      } else {
        // Retryable error (rate limit, server error)
        fallbackService.recordProviderFailure(
          upstreamConfig.id,
          upstreamConfig.name,
          upstreamResponse.status
        );
        attemptsLog.push({
          provider: upstreamConfig.name,
          status: upstreamResponse.status,
          error: upstreamResponse.statusText,
        });
        lastError = upstreamResponse;
        continue; // Try next provider
      }
    } catch (err: any) {
      // Network error
      const providerConfig = await upstreamService.findById(providerHealth.id);
      if (providerConfig) {
        fallbackService.recordProviderFailure(
          providerHealth.id,
          providerHealth.name,
          503,
          err.message
        );
        attemptsLog.push({
          provider: providerHealth.name,
          status: 503,
          error: `Network error: ${err.message}`,
        });
      }
      continue; // Try next provider
    }
  }

  // All providers failed
  const fallbackLog = `Attempted ${attemptsLog.length} providers: ${attemptsLog
    .map((a) => `${a.provider}(${a.status})`)
    .join(', ')}`;

  console.error(`[Fallback] All providers failed for model '${modelName}'. ${fallbackLog}`);

  return new Response(
    JSON.stringify({
      error: {
        message: `All upstream providers failed for model '${modelName}'`,
        type: 'all_upstreams_failed',
        attempts: attemptsLog,
      },
    }),
    { status: 503, headers: { 'Content-Type': 'application/json' } }
  );
}
