import { CardInstance, GameManifestV1, GamePackage } from '../../types/contracts';
import { makePackageDescriptor } from '../gamePackageHost';

function buildUno112Cards(): CardInstance[] {
  const colors = ['red', 'yellow', 'green', 'blue'] as const;
  const cards: CardInstance[] = [];
  for (const color of colors) {
    cards.push({
      card_instance_id: `${color}_0`,
      symbol: `${color}:0`,
      name: `${color} 0`,
      metadata: { color, value: '0', kind: 'NUMBER' },
    });
    for (let value = 1; value <= 9; value++) {
      for (const copy of ['a', 'b']) {
        cards.push({
          card_instance_id: `${color}_${value}_${copy}`,
          symbol: `${color}:${value}`,
          name: `${color} ${value}`,
          metadata: { color, value: String(value), kind: 'NUMBER' },
        });
      }
    }
    for (const action of ['skip', 'reverse', 'draw_two'] as const) {
      for (const copy of ['a', 'b']) {
        cards.push({
          card_instance_id: `${color}_${action}_${copy}`,
          symbol: `${color}:${action}`,
          name: `${color} ${action}`,
          metadata: { color, value: action, kind: 'ACTION' },
        });
      }
    }
  }
  for (let i = 0; i < 4; i++) {
    cards.push({
      card_instance_id: `wild_${i}`,
      symbol: 'WILD',
      name: 'Wild',
      metadata: { color: 'wild', value: 'wild', kind: 'WILD' },
    });
    cards.push({
      card_instance_id: `wild_draw_four_${i}`,
      symbol: 'WILD+4',
      name: 'Wild Draw Four',
      metadata: { color: 'wild', value: 'draw_four', kind: 'WILD' },
    });
  }
  // Four additional current-deck custom/wild slots keep the physical manifest at 112.
  for (let i = 0; i < 4; i++) {
    cards.push({
      card_instance_id: `custom_wild_${i}`,
      symbol: 'CUSTOM_WILD',
      name: 'Custom Wild',
      metadata: { color: 'wild', value: 'custom', kind: 'CUSTOM' },
    });
  }
  if (cards.length !== 112) throw new Error(`UNO reference deck expected 112 cards, generated ${cards.length}`);
  return cards;
}

/**
 * UNO reference package under the v0.10 physical-deck security model.
 * Color/value legality and Wild Draw Four eligibility are advisory game rules; Core
 * only guarantees that a player can play a real controlled card and cannot choose a
 * hidden draw result.
 */
export const UNO_GAME_MANIFEST: GameManifestV1 = {
  schema: 'mental-deck-game/v1',
  game: { id: 'mental_deck.game.uno', name: 'UNO', version: '0.10.0' },
  players: { min: 2, max: 10 },
  deck: { cards: buildUno112Cards(), deck_id: 'uno_112_reference', version: '0.10.0' },
  zones: [
    {
      id: 'draw_pile',
      name: 'Draw Pile',
      owner: 'shared',
      ordering: 'ORDERED',
      visibility: 'HIDDEN_TO_ALL',
      controller_policy: 'SHARED',
    },
    {
      id: 'discard_pile',
      name: 'Discard Pile',
      owner: 'shared',
      ordering: 'ORDERED',
      visibility: 'PUBLIC',
      controller_policy: 'SHARED',
    },
    {
      id: 'hand:{player}',
      name: '{player_name} Hand',
      owner: '{player}',
      ordering: 'UNORDERED',
      visibility: 'OWNER_ONLY',
      controller_policy: 'OWNER',
    },
  ],
  setup: [
    { op: 'DEAL_ROUND_ROBIN', to: 'hand:{player}', count_per_player: 7 },
    { op: 'REMAINDER', to: 'draw_pile' },
  ],
  mechanicalActions: [
    {
      id: 'play_card',
      parameters: { card: { type: 'CARD_REF' } },
      steps: [{
        op: 'MOVE_REVEAL_PUBLIC',
        from: 'hand:{actor}',
        source_access: 'CONTROLLED',
        to: 'discard_pile',
        selection: { type: 'BY_HANDLE', param: 'card' },
        reveal: 'PUBLIC',
      }],
    },
    {
      id: 'draw_card',
      parameters: {},
      steps: [{
        op: 'MOVE_REVEAL_OWNER',
        from: 'draw_pile',
        source_access: 'CONTROLLED',
        to: 'hand:{actor}',
        selection: { type: 'TOP', count: 1 },
        reveal: 'OWNER',
      }],
    },
  ],
  gameEvents: [{
    id: 'choose_color',
    parameters: { color: { type: 'STRING', enum: ['red', 'yellow', 'green', 'blue'] } },
  }],
  modules: {
    rules: './ruleAdvisor.ts',
    client: './client.ts',
    ui: './ui.tsx',
  },
};

export async function buildUnoGamePackage(): Promise<GamePackage> {
  return {
    descriptor: await makePackageDescriptor(UNO_GAME_MANIFEST),
    manifest: UNO_GAME_MANIFEST,
  };
}
