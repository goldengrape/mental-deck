import { MentalDeckCrypto } from '../crypto/cryptoProvider';
import type {
  CommittedGameState,
  GameManifestV1,
  SignedMechanicalIntent,
  SignedPublicGameEvent,
} from '../types/contracts';

/**
 * Viewer-local v0.10 client contract.
 *
 * This helper can suggest/compile only manifest-declared action/event identifiers. It
 * never grants Core authority: the Coordinator independently verifies signatures,
 * schemas, controllers and mechanical policy against the locked security definition.
 */
export class GameClientRuntime {
  constructor(
    public readonly playerId: string,
    public readonly gameId: string,
    public readonly securityDefinitionHash: string,
    private readonly signingPrivateKey: string,
    public readonly manifest: GameManifestV1
  ) {}

  listMechanicalActions(): string[] {
    return this.manifest.mechanicalActions.map(action => action.id);
  }

  listPublicGameEvents(): string[] {
    return (this.manifest.gameEvents ?? []).map(event => event.id);
  }

  async signMechanicalIntent(
    actionId: string,
    parameters: Record<string, unknown>,
    state: CommittedGameState
  ): Promise<SignedMechanicalIntent> {
    if (!this.manifest.mechanicalActions.some(action => action.id === actionId)) {
      throw new Error(`Client manifest does not declare mechanical action ${actionId}`);
    }
    const unsigned = {
      intent_id: await this.makeId('mechanical', actionId, state.state_version, parameters),
      actor_id: this.playerId,
      game_id: this.gameId,
      security_definition_hash: this.securityDefinitionHash,
      action_id: actionId,
      parameters,
      base_state_hash: state.state_hash,
      base_state_version: state.state_version,
    };
    return {
      ...unsigned,
      signature: await MentalDeckCrypto.signSemanticIntent(this.signingPrivateKey, unsigned),
    };
  }

  async signPublicGameEvent(
    eventType: string,
    parameters: Record<string, unknown>,
    state: CommittedGameState
  ): Promise<SignedPublicGameEvent> {
    if (!(this.manifest.gameEvents ?? []).some(event => event.id === eventType)) {
      throw new Error(`Client manifest does not declare public game event ${eventType}`);
    }
    const unsigned = {
      event_id: await this.makeId('event', eventType, state.state_version, parameters),
      actor_id: this.playerId,
      game_id: this.gameId,
      security_definition_hash: this.securityDefinitionHash,
      event_type: eventType,
      parameters,
      base_state_hash: state.state_hash,
      base_state_version: state.state_version,
    };
    return {
      ...unsigned,
      signature: await MentalDeckCrypto.signSemanticIntent(this.signingPrivateKey, unsigned),
    };
  }

  private async makeId(
    kind: 'mechanical' | 'event',
    typeId: string,
    stateVersion: number,
    parameters: Record<string, unknown>
  ): Promise<string> {
    const material = await MentalDeckCrypto.sha256(
      JSON.stringify({ kind, typeId, stateVersion, parameters, playerId: this.playerId, gameId: this.gameId })
    );
    return `${kind}_${material.slice(0, 24)}`;
  }
}
