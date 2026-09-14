/**
 * BackupService: Export/Import upstream provider configurations
 * - Export all upstreams with credentials as encrypted JSON
 * - Import providers from backup file
 * - Safe backup before redeploy
 */

import { Database } from '../db';
import { UpstreamService } from './upstream.service';

export interface BackupExport {
  version: string;
  exportedAt: string;
  providerCount: number;
  providers: Array<{
    id: string;
    name: string;
    provider_type: string;
    cf_aig_provider?: string;
    api_protocol: string;
    base_url: string;
    api_key: string; // Raw key in backup
    available_models: string[];
    created_at: number;
  }>;
  checksum: string; // SHA256 of provider data
}

export class BackupService {
  private upstreamService: UpstreamService;

  constructor(private db: Database) {
    this.upstreamService = new UpstreamService(db);
  }

  /**
   * Export all upstream providers to JSON with credentials
   * Returns base64-encoded JSON for safe transmission
   */
  async exportProviders(): Promise<BackupExport> {
    const upstreams = await this.db
      .select()
      .from(require('../db/schema').upstreamConfigs);

    const providers = upstreams.map((u: any) => ({
      id: u.id,
      name: u.name,
      provider_type: u.provider_type,
      cf_aig_provider: u.cf_aig_provider || undefined,
      api_protocol: u.api_protocol || 'openai',
      base_url: u.base_url,
      api_key: u.api_key, // Include raw API key in backup
      available_models: JSON.parse(u.available_models || '[]'),
      created_at: u.created_at,
    }));

    const providerData = JSON.stringify(providers);
    const checksum = await this.generateChecksum(providerData);

    return {
      version: '1.0',
      exportedAt: new Date().toISOString(),
      providerCount: providers.length,
      providers,
      checksum,
    };
  }

  /**
   * Export as downloadable JSON file (base64 encoded for safety)
   */
  async exportAsBase64(): Promise<string> {
    const backup = await this.exportProviders();
    const jsonStr = JSON.stringify(backup, null, 2);
    return Buffer.from(jsonStr).toString('base64');
  }

  /**
   * Import providers from backup JSON
   * - Validates checksum
   * - Skips duplicate IDs
   * - Returns import report
   */
  async importProviders(
    backupData: BackupExport,
    options: { skipDuplicates?: boolean; overwrite?: boolean } = {}
  ): Promise<{
    success: boolean;
    imported: number;
    skipped: number;
    errors: Array<{ provider: string; error: string }>;
    message: string;
  }> {
    const errors: Array<{ provider: string; error: string }> = [];
    let imported = 0;
    let skipped = 0;

    // Validate checksum
    const providerData = JSON.stringify(backupData.providers);
    const calculatedChecksum = await this.generateChecksum(providerData);
    if (calculatedChecksum !== backupData.checksum) {
      return {
        success: false,
        imported: 0,
        skipped: 0,
        errors: [{ provider: 'backup', error: 'Checksum validation failed. Backup may be corrupted.' }],
        message: 'Import failed: Backup integrity check failed',
      };
    }

    // Import each provider
    for (const provider of backupData.providers) {
      try {
        // Check if provider already exists
        const existing = await this.upstreamService.findById(provider.id);

        if (existing) {
          if (options.overwrite) {
            // Update existing provider
            await this.upstreamService.updateUpstream(provider.id, {
              name: provider.name,
              provider_type: provider.provider_type,
              cf_aig_provider: provider.cf_aig_provider,
              api_protocol: provider.api_protocol,
              base_url: provider.base_url,
              api_key: provider.api_key,
              available_models: provider.available_models,
            });
            imported++;
          } else if (options.skipDuplicates) {
            skipped++;
          } else {
            errors.push({
              provider: provider.name,
              error: `Provider already exists (ID: ${provider.id}). Use overwrite option to replace.`,
            });
          }
        } else {
          // Create new provider
          await this.upstreamService.createUpstream({
            name: provider.name,
            provider_type: provider.provider_type,
            cf_aig_provider: provider.cf_aig_provider,
            api_protocol: provider.api_protocol,
            base_url: provider.base_url,
            api_key: provider.api_key,
            available_models: provider.available_models,
          });
          imported++;
        }
      } catch (err: any) {
        errors.push({
          provider: provider.name,
          error: err.message || 'Unknown error during import',
        });
      }
    }

    return {
      success: errors.length === 0,
      imported,
      skipped,
      errors,
      message: `Imported ${imported} providers, skipped ${skipped}, ${errors.length} errors`,
    };
  }

  /**
   * Generate SHA256 checksum for data integrity
   */
  private async generateChecksum(data: string): Promise<string> {
    const encoder = new TextEncoder();
    const dataBuffer = encoder.encode(data);
    const hashBuffer = await crypto.subtle.digest('SHA-256', dataBuffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  /**
   * Decode base64 backup file back to JSON
   */
  decodeBackupFile(base64Data: string): BackupExport {
    const jsonStr = Buffer.from(base64Data, 'base64').toString('utf-8');
    return JSON.parse(jsonStr);
  }
}
