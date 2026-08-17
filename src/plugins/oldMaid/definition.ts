/**
 * Mental Deck - Old Maid (抽乌龟 / 抽鬼牌) Plugin Definition.
 *
 * Uses a 51-card standard deck with Q♣ removed. Because three Queens remain and
 * pairs are matched by rank, the eventual unmatched Old Maid is whichever Queen is
 * left after legal Queen pairing — it is NOT a fixed Q♠ identity.
 */

import {
  CardInstance,
  DeckManifest,
  InitializationPlan,
  LockedRoster,
  PluginArtifactDescriptor,
  ZoneDefinition,
  ZoneManifest,
} from '../../types/contracts';
import { hashCanonical } from '../../crypto/cryptoProvider';

export const OLD_MAID_PLUGIN_DESCRIPTOR: PluginArtifactDescriptor = {
  plugin_id: 'mental_deck.plugin.old_maid',
  plugin_version: '0.9.0',
  plugin_package_hash: 'pkg_hash_old_maid_v090_prod_official',
  artifact_kinds: ['canonical_rules', 'client_rules', 'ui_adapter'],
  trust_status: 'product_shipped',
  name: 'Old Maid (抽乌龟)',
  description: 'Classic 51-card rank-pairing game. Q♣ is removed; the player left with the final unmatched Queen/card loses.',
};

export class OldMaidDefinitionBuilder {
  static async buildDeckManifest(): Promise<DeckManifest> {
    const suits: Array<'♠' | '♥' | '♦' | '♣'> = ['♠', '♥', '♦', '♣'];
    const ranks = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
    const cards: CardInstance[] = [];

    for (const suit of suits) {
      for (const rank of ranks) {
        if (suit === '♣' && rank === 'Q') continue;
        cards.push({
          card_instance_id: `card_${rank}_${suit}`,
          symbol: `${rank}${suit}`,
          suit,
          rank,
          name: `${rank} of ${suit}`,
          metadata: { removed_pair_mate_rank: rank === 'Q' },
        });
      }
    }

    if (cards.length !== 51) throw new Error(`Old Maid deck must contain 51 cards; generated ${cards.length}`);
    return {
      deck_id: 'old_maid_51_deck',
      version: '0.9.0',
      cards,
      deck_manifest_hash: await hashCanonical(cards),
    };
  }

  static async buildZoneManifest(roster: LockedRoster): Promise<ZoneManifest> {
    const zones: ZoneDefinition[] = [
      {
        zone_id: 'stock',
        name: 'Stock / Privacy Pool (摸牌区)',
        owner_player_id: null,
        ordering: 'ORDERED',
        default_visibility: 'HIDDEN_TO_ALL',
      },
      {
        zone_id: 'discarded_pairs',
        name: 'Discarded Pairs (已弃对子区)',
        owner_player_id: null,
        ordering: 'UNORDERED',
        default_visibility: 'PUBLIC',
      },
    ];
    for (const player of roster.players) {
      zones.push({
        zone_id: `zone_hand_${player.player_id}`,
        name: `${player.display_name}'s Hand`,
        owner_player_id: player.player_id,
        ordering: 'UNORDERED',
        default_visibility: 'OWNER_ONLY',
      });
    }
    return { zones, zone_manifest_hash: await hashCanonical(zones) };
  }

  static async buildInitializationPlan(roster: LockedRoster): Promise<InitializationPlan> {
    if (roster.players.length < 2) throw new Error('Old Maid requires at least two players');
    const steps = [];
    for (let i = 0; i < 51; i++) {
      const targetPlayer = roster.players[i % roster.players.length];
      steps.push({
        step_id: `deal_step_${i + 1}`,
        source_pool: 'privacy_pool' as const,
        destination_zone_id: `zone_hand_${targetPlayer.player_id}`,
        count: 1,
        selector: 'TOP' as const,
      });
    }
    return { steps, plan_hash: await hashCanonical(steps) };
  }

  static buildInitialGameExtension(roster: LockedRoster): Record<string, unknown> {
    if (roster.players.length < 2) throw new Error('Old Maid requires at least two players');
    return {
      game_name: 'Old Maid (抽乌龟)',
      current_player_index: 0,
      current_player_id: roster.players[0].player_id,
      turn_number: 1,
      phase: 'TURN_ACTIONS',
      draw_completed_this_turn: false,
      pairs_discarded_count: 0,
      active_players: roster.players.map(p => p.player_id),
      finished_players: [],
      loser_player_id: null,
      history: ['Game initialized and cards dealt.'],
    };
  }
}
