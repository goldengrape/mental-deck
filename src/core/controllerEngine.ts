import {
  CommittedGameState,
  ControllerGrant,
  ZoneDefinition,
} from '../types/contracts';
import { hashCanonical } from '../crypto/cryptoProvider';

/**
 * Mechanical controller authorization only.
 *
 * Controller rights never imply visibility. Runtime delegation is owner-authorized
 * and action-scoped; public game events / Rule Advisor output have no authority here.
 */
export class ControllerEngine {
  static isController(
    state: CommittedGameState,
    zone: ZoneDefinition,
    actorPlayerId: string,
    actionId: string,
    rosterPlayerIds: string[]
  ): boolean {
    if (zone.owner_player_id === actorPlayerId) return true;

    const policy = zone.controller_policy ?? (zone.owner_player_id ? 'OWNER' : 'SHARED');
    if (policy === 'SHARED') return rosterPlayerIds.includes(actorPlayerId);
    if (policy !== 'DELEGATED') return false;

    return Object.values(state.controller_grants ?? {}).some(grant =>
      grant.status === 'ACTIVE' &&
      grant.zone_id === zone.zone_id &&
      grant.controller_player_id === actorPlayerId &&
      grant.allowed_action_ids.includes(actionId) &&
      grant.parent_state_hash !== ''
    );
  }

  static async createOwnerGrant(
    state: CommittedGameState,
    zone: ZoneDefinition,
    grantorPlayerId: string,
    controllerPlayerId: string,
    allowedActionIds: string[],
    grantedByIntentId: string,
    permittedActionIds: string[],
    rosterPlayerIds: string[]
  ): Promise<ControllerGrant> {
    if (!zone.owner_player_id || zone.owner_player_id !== grantorPlayerId) {
      throw new Error('Runtime controller grant must be signed by the Zone owner');
    }
    if ((zone.controller_policy ?? 'OWNER') !== 'DELEGATED') {
      throw new Error(`Zone ${zone.zone_id} does not allow delegated control`);
    }
    if (!rosterPlayerIds.includes(controllerPlayerId)) {
      throw new Error(`Controller ${controllerPlayerId} is not in the locked roster`);
    }
    if (allowedActionIds.length === 0) throw new Error('Controller grant requires a non-empty action scope');
    const uniqueScope = [...new Set(allowedActionIds)];
    for (const actionId of uniqueScope) {
      if (!permittedActionIds.includes(actionId)) {
        throw new Error(`Controller grant cannot authorize undeclared action ${actionId}`);
      }
    }

    const digest = await hashCanonical({
      zone_id: zone.zone_id,
      grantor_player_id: grantorPlayerId,
      controller_player_id: controllerPlayerId,
      allowed_action_ids: uniqueScope,
      granted_by_intent_id: grantedByIntentId,
      parent_state_hash: state.state_hash,
    });

    return {
      grant_id: `ctrl_${digest.slice(0, 24)}`,
      zone_id: zone.zone_id,
      grantor_player_id: grantorPlayerId,
      controller_player_id: controllerPlayerId,
      allowed_action_ids: uniqueScope,
      granted_by_intent_id: grantedByIntentId,
      created_at_state_version: state.state_version + 1,
      parent_state_hash: state.state_hash,
      status: 'ACTIVE',
    };
  }

  static revokeGrant(
    state: CommittedGameState,
    grantId: string,
    actorPlayerId: string
  ): ControllerGrant {
    const grant = state.controller_grants?.[grantId];
    if (!grant || grant.status !== 'ACTIVE') throw new Error(`Active ControllerGrant ${grantId} not found`);
    if (actorPlayerId !== grant.grantor_player_id && actorPlayerId !== grant.controller_player_id) {
      throw new Error('Only grantor may revoke, or controller may relinquish, a ControllerGrant');
    }
    return { ...grant, status: 'REVOKED' };
  }
}
