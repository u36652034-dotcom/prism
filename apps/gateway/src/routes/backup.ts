/**
 * Backup & Restore API Routes
 * - GET /api/backup/export - Download all providers as JSON
 * - POST /api/backup/import - Import providers from JSON
 * - GET /api/backup/health - Check provider health status
 */

import { Hono } from 'hono';
import { GatewayContext } from '../types';
import { BackupService } from '../services/backup.service';
import { FallbackService } from '../services/fallback.service';
import { getDb } from '../db';

const backup = new Hono<GatewayContext>();

/**
 * GET /api/backup/export
 * Export all upstream providers with credentials as JSON
 * Response: base64-encoded backup file
 */
backup.get('/export', async (c) => {
  try {
    const backupService = new BackupService(getDb(c.env.DB));
    const backupData = await backupService.exportProviders();

    // Return as downloadable file
    const jsonStr = JSON.stringify(backupData, null, 2);
    return c.json(
      {
        success: true,
        message: `Exported ${backupData.providerCount} providers`,
        backup: backupData,
      },
      200
    );
  } catch (err: any) {
    return c.json({ error: err.message || 'Export failed' }, 500);
  }
});

/**
 * GET /api/backup/export-download
 * Export as base64-encoded file for browser download
 */
backup.get('/export-download', async (c) => {
  try {
    const backupService = new BackupService(getDb(c.env.DB));
    const base64Data = await backupService.exportAsBase64();
    const timestamp = new Date().toISOString().slice(0, 10);

    return new Response(base64Data, {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Content-Disposition': `attachment; filename="prism-backup-${timestamp}.json.b64"`,
      },
    });
  } catch (err: any) {
    return c.json({ error: err.message || 'Export failed' }, 500);
  }
});

/**
 * POST /api/backup/import
 * Import providers from backup JSON
 * Body: { backup: BackupExport, overwrite?: boolean, skipDuplicates?: boolean }\n */\nbackup.post('/import', async (c) => {\n  try {\n    const body = await c.req.json();\n    const { backup: backupData, overwrite = false, skipDuplicates = true } = body;\n\n    if (!backupData || typeof backupData !== 'object') {\n      return c.json({ error: 'Invalid backup data format' }, 400);\n    }\n\n    const backupService = new BackupService(getDb(c.env.DB));\n    const result = await backupService.importProviders(backupData, {\n      overwrite,\n      skipDuplicates,\n    });\n\n    return c.json(result, result.success ? 200 : 400);\n  } catch (err: any) {\n    return c.json({ error: err.message || 'Import failed' }, 500);\n  }\n});\n\n/**\n * POST /api/backup/import-base64\n * Import providers from base64-encoded backup file\n * Body: { backupBase64: string, overwrite?: boolean }\n */\nbackup.post('/import-base64', async (c) => {\n  try {\n    const body = await c.req.json();\n    const { backupBase64, overwrite = false } = body;\n\n    if (!backupBase64 || typeof backupBase64 !== 'string') {\n      return c.json({ error: 'Invalid backup data format' }, 400);\n    }\n\n    const backupService = new BackupService(getDb(c.env.DB));\n    const backupData = backupService.decodeBackupFile(backupBase64);\n    const result = await backupService.importProviders(backupData, {\n      overwrite,\n      skipDuplicates: true,\n    });\n\n    return c.json(result, result.success ? 200 : 400);\n  } catch (err: any) {\n    return c.json({ error: err.message || 'Import failed' }, 500);\n  }\n});\n\n/**\n * GET /api/backup/health\n * Get health status of all providers and fallback chain\n */\nbackup.get('/health', async (c) => {\n  try {\n    const fallbackService = new FallbackService(getDb(c.env.DB));\n    const healthStatus = fallbackService.getAllHealthStatus();\n\n    return c.json({\n      success: true,\n      timestamp: new Date().toISOString(),\n      providers: healthStatus.map((h) => ({\n        id: h.id,\n        name: h.name,\n        status: h.status,\n        failures: h.failures,\n        lastFailure: h.lastFailure ? new Date(h.lastFailure).toISOString() : null,\n        cooldownUntil: h.cooldownUntil ? new Date(h.cooldownUntil).toISOString() : null,\n        failureReason: h.failureReason,\n      })),\n    });\n  } catch (err: any) {\n    return c.json({ error: err.message || 'Health check failed' }, 500);\n  }\n});\n\n/**\n * POST /api/backup/reset-health\n * Reset all provider health status (admin only)\n */\nbackup.post('/reset-health', async (c) => {\n  try {\n    const fallbackService = new FallbackService(getDb(c.env.DB));\n    fallbackService.resetAllHealth();\n\n    return c.json({\n      success: true,\n      message: 'All provider health status reset',\n    });\n  } catch (err: any) {\n    return c.json({ error: err.message || 'Reset failed' }, 500);\n  }\n});\n\nexport default backup;\n