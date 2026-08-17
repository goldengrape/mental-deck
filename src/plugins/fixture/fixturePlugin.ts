/**
 * Mental Deck - Fixture Test Plugin (MDD-MOD-028, URD-ACC-015, TDD-TEST-016)
 *
 * 7-Card Micro Deck for pluggability testing and architecture invariant verification
 * without modifying Mental Deck Core.
 */

import {
  CardInstance,
  DeckManifest,
  InitializationPlan,
  LockedGameDefinition,
  LockedRoster,
  PluginArtifactDescriptor,
  ZoneDefinition,
  ZoneManifest,
} from '../../types/contracts';
import { hashCanonical } from '../../crypto/cryptoProvider';

export const FIXTURE_PLUGIN_DESCRIPTOR: PluginArtifactDescriptor = {
  plugin_id: 'mental_deck.plugin.fixture_7card',
  plugin_version: '0.8.0',
  plugin_package_hash: 'pkg_hash_fixture_7card_v080_test_official',
  artifact_kinds: ['canonical_rules', 'client_rules', 'ui_adapter'],
  trust_status: 'allowlisted',
  name: 'Fixture 7-Card Test Plugin',
  description: 'Minimal 7-card deck game used to verify multi-plugin pluggability without modifying Core.',
};

export class FixturePluginBuilder {
  static async buildDeckManifest(): Promise<DeckManifest> {
    const cards: CardInstance[] = [
      { card_instance_id: 'fix_1', symbol: '1⭐', name: 'Star 1', metadata: { value: 1 } },
      { card_instance_id: 'fix_2', symbol: '2⭐', name: 'Star 2', metadata: { value: 2 } },
      { card_instance_id: 'fix_3', symbol: '3⭐', name: 'Star 3', metadata: { value: 3 } },
      { card_instance_id: 'fix_4', symbol: '4⭐', name: 'Star 4', metadata: { value: 4 } },
      { card_instance_id: 'fix_5', symbol: '5⭐', name: 'Star 5', metadata: { value: 5 } },
      { card_instance_id: 'fix_6', symbol: '6⭐', name: 'Star 6', metadata: { value: 6 } },
      { card_instance_id: 'fix_7', symbol: '7⭐', name: 'Star 7 (Special)', metadata: { value: 7 } },
    ];
    const hash = await hashCanonical(cards);
    return {
      deck_id: 'fixture_7card_deck',
      version: '0.8.0',
      cards,
      deck_manifest_hash: hash,
    };
  }

  static async buildZoneManifest(roster: LockedRoster): Promise<ZoneManifest> {
    const zones: ZoneDefinition[] = [
      {
        zone_id: 'stock',
        name: 'Stock',
        ordering: 'ORDERED',
        default_visibility: 'HIDDEN_TO_ALL',
      },
      {
        zone_id: 'community',
        name: 'Community Area',
        ordering: 'UNORDERED',
        default_visibility: 'PUBLIC',
      },
    ];
    for (const p of roster.players) {
      zones.push({
        zone_id: `zone_hand_${p.player_id}`,
        name: `${p.display_name}'s Hand`,
        owner_player_id: p.player_id,
        ordering: 'UNORDERED',
        default_visibility: 'OWNER_ONLY',
      });
    }
    const hash = await hashCanonical(zones);
    return { zones, zone_manifest_hash: hash };
  }

  static async buildInitializationPlan(roster: LockedRoster): Promise<InitializationPlan> {
    const steps = [];
    // Deal 2 cards to each player, remaining to stock
    for (const p of roster.players) {
      steps.push({
        step_id: `deal_${p.player_id}`,
        source_pool: 'privacy_pool' as const,
        destination_zone_id: `zone_hand_${p.player_id}`,
        count: 2,
        selector: 'TOP' as const,
      });
    }
    const hash = await hashCanonical(steps);
    return { steps, plan_hash: hash };
  }
}
