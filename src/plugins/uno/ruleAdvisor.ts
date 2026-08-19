import type { RuleAdvisor, ViewerLocalKnowledge } from '../../client/ruleAdvisor';
import type { CardRef, CommittedGameState, LocalRuleAssessment, PublicRuleView, StateTransitionRecord } from '../../types/contracts';

export const UnoRuleAdvisor: RuleAdvisor = {
  rulesModuleVersion: '0.10.0',

  derivePublicRuleView(state: CommittedGameState, transitions: StateTransitionRecord[]): PublicRuleView {
    const chooseColor = [...transitions]
      .reverse()
      .find(record => record.transition_kind === 'PUBLIC_GAME_EVENT' && record.type_id === 'choose_color');
    const playedCards = transitions.filter(record => record.transition_kind === 'MECHANICAL' && record.type_id === 'play_card').length;
    return {
      state_head_hash: state.state_hash,
      rules_module_version: '0.10.0',
      view: {
        chosen_color: chooseColor?.public_payload.parameters && (chooseColor.public_payload.parameters as Record<string, unknown>).color,
        played_card_count: playedCards,
        note: 'Wild Draw Four hidden-hand eligibility is advisory, not a Core predicate.',
      },
    };
  },

  assessLocalRule(
    actionId: string,
    parameters: Record<string, unknown>,
    _state: CommittedGameState,
    localKnowledge: ViewerLocalKnowledge
  ): LocalRuleAssessment {
    if (actionId !== 'play_card') return { status: 'LEGAL' };
    const ref = parameters.card as CardRef | undefined;
    if (!ref) return { status: 'WARNING', code: 'CARD_REQUIRED', message: 'Choose a card to play.' };
    const card = localKnowledge.getKnownCard(ref.ref_id);
    if (!card) return { status: 'WARNING', code: 'CARD_UNKNOWN', message: 'Local client cannot evaluate this card yet.' };
    if (card.metadata?.value === 'draw_four') {
      return {
        status: 'WARNING',
        code: 'WILD_DRAW_FOUR_ADVISORY',
        message: 'Wild Draw Four eligibility depends on your hidden hand. The client may warn, but Core intentionally does not prove this rule.',
      };
    }
    return { status: 'LEGAL' };
  },
};
