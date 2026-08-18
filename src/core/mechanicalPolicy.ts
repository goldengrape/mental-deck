import {
  CardRef,
  LockedSecurityDefinition,
  MechanicalActionSpec,
  MechanicalStepSpec,
  ParameterSchema,
  SelectionSpec,
  SignedMechanicalIntent,
} from '../types/contracts';

export interface ResolvedMechanicalStep extends Omit<MechanicalStepSpec, 'from' | 'to' | 'selection'> {
  source_zone_id?: string;
  destination_zone_id?: string;
  selection?: SelectionSpec;
}

export interface ResolvedMechanicalAction {
  action: MechanicalActionSpec;
  steps: ResolvedMechanicalStep[];
}

function isCardRef(value: unknown): value is CardRef {
  if (!value || typeof value !== 'object') return false;
  const ref = value as CardRef;
  return typeof ref.ref_id === 'string' && Number.isInteger(ref.epoch) && ref.epoch >= 0;
}

export class MechanicalPolicyEngine {
  static resolve(
    definition: LockedSecurityDefinition,
    intent: SignedMechanicalIntent,
    rosterPlayerIds: string[]
  ): ResolvedMechanicalAction {
    const action = definition.mechanical_policy.find(candidate => candidate.id === intent.action_id);
    if (!action) throw new Error(`Mechanical action ${intent.action_id} is not declared by locked policy`);
    this.validateParameters(action, intent.parameters, rosterPlayerIds);

    return {
      action,
      steps: action.steps.map(step => this.resolveStep(step, intent, rosterPlayerIds)),
    };
  }

  private static validateParameters(
    action: MechanicalActionSpec,
    parameters: Record<string, unknown>,
    rosterPlayerIds: string[]
  ): void {
    const schemas = action.parameters ?? {};
    for (const [name, schema] of Object.entries(schemas)) {
      if (!(name in parameters)) throw new Error(`Mechanical action ${action.id} missing parameter ${name}`);
      this.validateParameter(name, parameters[name], schema, rosterPlayerIds);
    }
    for (const key of Object.keys(parameters)) {
      if (!(key in schemas)) throw new Error(`Mechanical action ${action.id} received undeclared parameter ${key}`);
    }
  }

  private static validateParameter(
    name: string,
    value: unknown,
    schema: ParameterSchema,
    rosterPlayerIds: string[]
  ): void {
    switch (schema.type) {
      case 'CARD_REF':
        if (!isCardRef(value)) throw new Error(`Parameter ${name} must be a CardRef`);
        return;
      case 'CARD_REF_LIST': {
        if (!Array.isArray(value) || !value.every(isCardRef)) throw new Error(`Parameter ${name} must be a CardRef[]`);
        if (schema.min !== undefined && value.length < schema.min) throw new Error(`Parameter ${name} below minimum length`);
        if (schema.max !== undefined && value.length > schema.max) throw new Error(`Parameter ${name} above maximum length`);
        return;
      }
      case 'ROSTER_PLAYER_ID':
        if (typeof value !== 'string' || !rosterPlayerIds.includes(value)) throw new Error(`Parameter ${name} must identify a locked roster player`);
        return;
      case 'STRING':
        if (typeof value !== 'string') throw new Error(`Parameter ${name} must be a string`);
        if (schema.enum && !schema.enum.includes(value)) throw new Error(`Parameter ${name} is not in the declared enum`);
        return;
      case 'INTEGER':
        if (!Number.isInteger(value)) throw new Error(`Parameter ${name} must be an integer`);
        if (schema.min !== undefined && (value as number) < schema.min) throw new Error(`Parameter ${name} below minimum`);
        if (schema.max !== undefined && (value as number) > schema.max) throw new Error(`Parameter ${name} above maximum`);
        return;
      case 'BOOLEAN':
        if (typeof value !== 'boolean') throw new Error(`Parameter ${name} must be boolean`);
        return;
      default:
        throw new Error(`Unsupported parameter schema ${(schema as ParameterSchema).type}`);
    }
  }

  private static resolveStep(
    step: MechanicalStepSpec,
    intent: SignedMechanicalIntent,
    rosterPlayerIds: string[]
  ): ResolvedMechanicalStep {
    const sourceZoneId = step.from ? this.resolveZoneTemplate(step.from, intent, rosterPlayerIds) : undefined;
    const destinationZoneId = step.to ? this.resolveZoneTemplate(step.to, intent, rosterPlayerIds) : undefined;

    let selection: SelectionSpec | undefined;
    if (step.selection) {
      switch (step.selection.type) {
        case 'BY_HANDLE': {
          const selected = intent.parameters[step.selection.param];
          const refs = Array.isArray(selected) ? selected : [selected];
          if (!refs.every(isCardRef)) throw new Error(`Selection parameter ${step.selection.param} is not CardRef/CardRef[]`);
          selection = { type: 'BY_HANDLE', card_refs: refs };
          break;
        }
        case 'TOP':
        case 'BOTTOM':
          selection = { type: step.selection.type, count: step.selection.count };
          break;
        case 'ALL':
          selection = { type: 'ALL' };
          break;
        case 'RANDOM':
          selection = { type: 'RANDOM', count: step.selection.count };
          break;
      }
    }

    if (step.source_access === 'BLIND_RANDOM') {
      if (step.op !== 'RANDOM_MOVE' || selection?.type !== 'RANDOM' || (selection.count ?? 0) <= 0) {
        throw new Error('BLIND_RANDOM is restricted to fixed-count RANDOM_MOVE');
      }
      if (selection.card_refs?.length) throw new Error('BLIND_RANDOM request must never carry client-selected final CardRefs');
    }

    return {
      op: step.op,
      source_access: step.source_access,
      source_zone_id: sourceZoneId,
      destination_zone_id: destinationZoneId,
      selection,
      reveal: step.reveal,
      action_scope: step.action_scope,
    };
  }

  private static resolveZoneTemplate(
    template: string,
    intent: SignedMechanicalIntent,
    rosterPlayerIds: string[]
  ): string {
    return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (_match, token: string) => {
      if (token === 'actor') return intent.actor_id;
      const value = intent.parameters[token];
      if (typeof value !== 'string' || !rosterPlayerIds.includes(value)) {
        throw new Error(`Zone token {${token}} must resolve to a locked roster player`);
      }
      return value;
    });
  }
}
