import { knownCards, type RuleAdvisor, type ViewerLocalKnowledge } from '../../client/ruleAdvisor';
import type { CardRef, CommittedGameState, LocalRuleAssessment, PublicRuleView, StateTransitionRecord } from '../../types/contracts';

export const BridgeRuleAdvisor: RuleAdvisor = {
  rulesModuleVersion: '0.10.0',

  derivePublicRuleView(state: CommittedGameState, transitions: StateTransitionRecord[]): PublicRuleView {
    const auction = transitions
      .filter(record => record.transition_kind === 'PUBLIC_GAME_EVENT' && ['pass', 'bid', 'double', 'redouble'].includes(record.type_id))
      .map(record => ({ actor_id: record.actor_id, type: record.type_id, parameters: record.public_payload.parameters ?? {} }));
    const cardsInCurrentTrick = state.zone_states.current_trick?.card_refs.length ?? 0;
    return {
      state_head_hash: state.state_hash,
      rules_module_version: '0.10.0',
      view: {
        auction,
        cards_in_current_trick: cardsInCurrentTrick,
        note: 'Auction/trick interpretation is advisory; mechanical card control stays in Core.',
      },
    };
  },

  assessLocalRule(
    actionId: string,
    parameters: Record<string, unknown>,
    state: CommittedGameState,
    localKnowledge: ViewerLocalKnowledge
  ): LocalRuleAssessment {
    if (actionId !== 'play_card') return { status: 'LEGAL' };
    const ref = parameters.card as CardRef | undefined;
    const handPlayerId = parameters.hand_player_id;
    if (!ref || typeof handPlayerId !== 'string') return { status: 'WARNING', code: 'PLAY_INPUT', message: 'Card and hand player are required.' };

    const card = localKnowledge.getKnownCard(ref.ref_id);
    if (!card) return { status: 'WARNING', code: 'PLAY_UNKNOWN', message: 'Selected card is not known locally.' };
    const trickRefs = state.zone_states.current_trick?.card_refs ?? [];
    if (trickRefs.length === 0) return { status: 'LEGAL' };
    const lead = state.public_bindings[trickRefs[0].ref_id]?.card_instance;
    if (!lead?.suit || !card.suit || lead.suit === 'none' || card.suit === lead.suit) return { status: 'LEGAL' };

    const handRefs = state.zone_states[`hand:${handPlayerId}`]?.card_refs ?? [];
    const knownHand = knownCards(handRefs, localKnowledge);
    const hasLeadSuit = knownHand.some(entry => entry.card.suit === lead.suit);
    if (hasLeadSuit) {
      return {
        status: 'VIOLATION',
        code: 'MUST_FOLLOW_SUIT',
        message: `Local knowledge shows a ${lead.suit} card remains in hand. Playing ${card.symbol} would violate follow-suit.`,
      };
    }
    return {
      status: 'LEGAL',
      code: 'NO_KNOWN_LEAD_SUIT',
    };
  },
};
