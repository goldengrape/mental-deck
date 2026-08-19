import type {
  CardInstance,
  CardRef,
  CommittedGameState,
  LocalRuleAssessment,
  PublicRuleView,
  StateTransitionRecord,
} from '../types/contracts';

export interface ViewerLocalKnowledge {
  getKnownCard(refId: string): CardInstance | undefined;
}

/**
 * Non-TCB game-rule helper.
 *
 * Public derivation may consume only public committed state projections + public
 * transition records. Local assessment may additionally use the current viewer's own
 * knowledge. Neither return value is a Core authorization proof or state-hash input.
 */
export interface RuleAdvisor {
  readonly rulesModuleVersion: string;

  derivePublicRuleView(
    state: CommittedGameState,
    transitions: StateTransitionRecord[]
  ): Promise<PublicRuleView> | PublicRuleView;

  assessLocalRule?(
    actionId: string,
    parameters: Record<string, unknown>,
    state: CommittedGameState,
    localKnowledge: ViewerLocalKnowledge
  ): Promise<LocalRuleAssessment> | LocalRuleAssessment;
}

export function knownCards(
  refs: CardRef[],
  localKnowledge: ViewerLocalKnowledge
): Array<{ ref: CardRef; card: CardInstance }> {
  const result: Array<{ ref: CardRef; card: CardInstance }> = [];
  for (const ref of refs) {
    const card = localKnowledge.getKnownCard(ref.ref_id);
    if (card) result.push({ ref, card });
  }
  return result;
}
