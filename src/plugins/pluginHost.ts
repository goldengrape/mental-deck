/**
 * Mental Deck - Pinned Plugin Artifact Host (MDD-MOD-001, URD-ARCH-003, URD-ARCH-010)
 *
 * Implements:
 * 1. Allowlisted and product-shipped plugin registry.
 * 2. Strict verification of plugin_id, plugin_version, and plugin_package_hash.
 * 3. Prevents execution of untrusted or unallowlisted plugins.
 */

import { PluginArtifactDescriptor } from '../types/contracts';

export class PinnedPluginArtifactHost {
  private static allowlist: Map<string, PluginArtifactDescriptor> = new Map();

  static registerAllowlistedPlugin(descriptor: PluginArtifactDescriptor): void {
    const key = `${descriptor.plugin_id}@${descriptor.plugin_version}`;
    this.allowlist.set(key, descriptor);
  }

  static resolvePlugin(pluginId: string, version: string, packageHash: string): PluginArtifactDescriptor {
    const key = `${pluginId}@${version}`;
    const descriptor = this.allowlist.get(key);
    if (!descriptor) {
      throw new Error(`Plugin ${key} is not in the allowlist of product-shipped or verified plugins (URD-ARCH-010).`);
    }
    if (descriptor.plugin_package_hash !== packageHash) {
      throw new Error(`Plugin package hash mismatch for ${key}. Expected ${descriptor.plugin_package_hash}, got ${packageHash}`);
    }
    if (descriptor.trust_status === 'untrusted') {
      throw new Error(`Plugin ${key} has trust_status 'untrusted' and cannot be executed.`);
    }
    return descriptor;
  }

  static listAvailablePlugins(): PluginArtifactDescriptor[] {
    return Array.from(this.allowlist.values());
  }
}
