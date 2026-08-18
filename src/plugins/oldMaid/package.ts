import { CardInstance, GameManifestV1, GamePackage } from '../../types/contracts';
import { makePackageDescriptor } from '../gamePackageHost';

function buildOldMaidCards(): CardInstance[] {
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
      });
    }
  }
  return cards;
}

/**
 * v0.10 physical-table package. Pair validity and turn order are intentionally NOT
 * mechanical authorization conditions. A Rule Advisor may flag false pair claims or
 * recommend the next target, but Core only enforces real-card ownership/randomness.
 */
export const OLD_MAID_GAME_MANIFEST = {
  schema: 'mental-deck-game/v1',
  game: { id: 'mental_deck.game.old_maid', name: 'Old Maid', version: '0.10.0' },
  players: { min: 2, max: 6 },
  deck: { cards: buildOldMaidCards(), deck_id: 'old_maid_51', version: '0.10.0' },
  zones: [
    {
      id: 'hand:{player}',
      name: '{player_name} Hand',
      owner: '{player}',
      ordering: 'UNORDERED',
      visibility: 'OWNER_ONLY',
      controller_policy: 'OWNER',
    },
    {
      id: 'discarded_pairs',
      name: 'Discarded pair claims',
      owner: 'shared',
      ordering: 'UNORDERED',
      visibility: 'PUBLIC',
      controller_policy: 'SHARED',
    },
  ],
  // DEAL_ALL_ROUND_ROBIN is a physical setup primitive discovered while implementing
  // variable-player Old Maid. It deals every opaque card without rule-level logic.
  setup: [{ op: 'DEAL_ALL_ROUND_ROBIN', to: 'hand:{player}' }],
  mechanicalActions: [
    {
      id: 'discard_claim',
      parameters: { cards: { type: 'CARD_REF_LIST', min: 2, max: 2 } },
      steps: [{
        op: 'MOVE_REVEAL_PUBLIC',
        from: 'hand:{actor}',
        source_access: 'CONTROLLED',
        to: 'discarded_pairs',
        selection: { type: 'BY_HANDLE', param: 'cards' },
        reveal: 'PUBLIC',
      }],
    },
    {
      id: 'draw_random_from_player',
      parameters: { target_player_id: { type: 'ROSTER_PLAYER_ID' } },
      steps: [{
        op: 'RANDOM_MOVE',
        from: 'hand:{target_player_id}',
        source_access: 'BLIND_RANDOM',
        to: 'hand:{actor}',
        selection: { type: 'RANDOM', count: 1 },
        reveal: 'OWNER',
      }],
    },
  ],
  gameEvents: [{ id: 'end_turn', parameters: {} }],
  modules: {
    rules: './ruleAdvisor.ts',
    client: './clientRules.ts',
    ui: './uiAdapter.tsx',
  },
} as unknown as GameManifestV1;

export async function buildOldMaidGamePackage(): Promise<GamePackage> {
  return {
    descriptor: await makePackageDescriptor(OLD_MAID_GAME_MANIFEST),
    manifest: OLD_MAID_GAME_MANIFEST,
  };
}
