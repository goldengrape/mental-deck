import type { RuleAdvisor, ViewerLocalKnowledge } from '../../client/ruleAdvisor';
import type { CardRef, CommittedGameState, LocalRuleAssessment, PublicRuleView, StateTransitionRecord } from '../../types/contracts';

export const OldMaidRuleAdvisor: RuleAdvisor = {
  rulesModuleVersion: '0.10.0',

  derivePublicRuleView(state: CommittedGameState, transitions: StateTransitionRecord[]): PublicRuleView {
    const endTurns = transitions.filter(record => record.transition_kind === 'PUBLIC_GAME_EVENT' && record.type_id === 'end_turn').length;
    const pairClaims = transitions.filter(record => record.transition_kind === 'MECHANICAL' && record.type_id === 'discard_claim').length;
    return {
      state_head_hash: state.state_hash,
      rules_module_version: '0.10.0',
      view: {
        turn_sequence_hint: endTurns + 1,
        pair_claim_count: pairClaims,
        note: 'Turn target and pair validity are advisory; Core does not authorize from this view.',
      },
    };
  },

  assessLocalRule(
    actionId: string,
    parameters: Record<string, unknown>,
    _state: CommittedGameState,
    localKnowledge: ViewerLocalKnowledge
  ): LocalRuleAssessment {
    if (actionId !== 'discard_claim') return { status: 'LEGAL' };
    const refs = parameters.cards;
    if (!Array.isArray(refs) || refs.length !== 2) return { status: 'WARNING', code: 'PAIR_INPUT', message: 'Select two cards.' };
    const [a, b] = refs as CardRef[];
    const cardA = localKnowledge.getKnownCard(a.ref_id);
    const cardB = localKnowledge.getKnownCard(b.ref_id);
    if (!cardA || !cardB) return { status: 'WARNING', code: 'PAIR_UNKNOWN', message: 'Pair validity cannot be checked from current local knowledge.' };
    if (cardA.rank === cardB.rank) return { status: 'LEGAL', code: 'PAIR_MATCH' };
    return { status: 'VIOLATION', code: 'NOT_A_PAIR', message: `${cardA.symbol} and ${cardB.symbol} do not have the same rank.` };
  },
};
