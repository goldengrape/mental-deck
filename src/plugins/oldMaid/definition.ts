/**
 * Mental Deck - Old Maid (抽乌龟 / 抽鬼牌) Plugin Definition (URD-GAME-OM-001 to 004)
 *
 * 51 Cards (Standard 52 minus Queen of Clubs Q♣).
 * Queen of Spades Q♠ is the lone unmatched Old Maid!
 */

import {
  CardInstance,
  DeckManifest,
  InitializationPlan,
  LockedRoster,
  PluginArtifactDescriptor,
  PublicGameConfig,
  ZoneDefinition,
  ZoneManifest,
} from '../../types/contracts';
import { hashCanonical, sha256 } from '../../crypto/cryptoProvider';

export const OLD_MAID_PLUGIN_DESCRIPTOR: PluginArtifactDescriptor = {
  plugin_id: 'mental_deck.plugin.old_maid',
  plugin_version: '0.8.0',
  plugin_package_hash: 'pkg_hash_old_maid_v080_prod_official',
  artifact_kinds: ['canonical_rules', 'client_rules', 'ui_adapter'],
  trust_status: 'product_shipped',
  name: 'Old Maid (抽乌龟)',
  description: 'Classic 51-card pairing and deduction game. Pair matching ranks to discard. The player left with the Queen of Spades loses!',
};

export class OldMaidDefinitionBuilder {
  /**
   * Generates the 51-card deck manifest
   */
  static async buildDeckManifest(): Promise<DeckManifest> {
    const suits: Array<'♠' | '♥' | '♦' | '♣'> = ['♠', '♥', '♦', '♣'];
    const ranks = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
    const cards: CardInstance[] = [];

    for (const suit of suits) {
      for (const rank of ranks) {
        // Remove Queen of Clubs (Q♣) to leave Queen of Spades (Q♠) as the unmatched Old Maid
        if (suit === '♣' && rank === 'Q') continue;

        const id = `card_${rank}_${suit}`;
        const isOldMaid = suit === '♠' && rank === 'Q';
        cards.push({
          card_instance_id: id,
          symbol: `${rank}${suit}`,
          suit,
          rank,
          name: isOldMaid ? 'Queen of Spades (Old Maid 乌龟)' : `${rank} of ${suit}`,
          metadata: { is_old_maid: isOldMaid },
        });
      }
    }

    if (cards.length !== 51) {
      throw new Error(`Old Maid deck must have exactly 51 cards. Generated ${cards.length}`);
    }

    const deckHash = await hashCanonical(cards);
    return {
      deck_id: 'old_maid_51_deck',
      version: '0.8.0',
      cards,
      deck_manifest_hash: deckHash,
    };
  }

  /**
   * Generates Zone Manifest based on locked roster
   */
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

    const zoneHash = await hashCanonical(zones);
    return {
      zones,
      zone_manifest_hash: zoneHash,
    };
  }

  /**
   * Generates identity-independent Initialization Plan
   * Deals 51 cards round-robin to all players
   */
  static async buildInitializationPlan(roster: LockedRoster): Promise<InitializationPlan> {
    const playerCount = roster.players.length;
    const totalCards = 51;
    const steps = [];

    // Deal 1 card at a time in round robin TOP order
    for (let i = 0; i < totalCards; i++) {
      const targetPlayer = roster.players[i % playerCount];
      steps.push({
        step_id: `deal_step_${i + 1}`,
        source_pool: 'privacy_pool' as const,
        destination_zone_id: `zone_hand_${targetPlayer.player_id}`,
        count: 1,
        selector: 'TOP' as const,
      });
    }

    const planHash = await hashCanonical(steps);
    return {
      steps,
      plan_hash: planHash,
    };
  }

  /**
   * Initial Game Extension for Old Maid
   */
  static buildInitialGameExtension(roster: LockedRoster): Record<string, unknown> {
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
