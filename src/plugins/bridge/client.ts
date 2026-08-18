import { GameClientRuntime } from '../../client/gameClientRuntime';
import { BRIDGE_GAME_MANIFEST } from './package';

export function createBridgeClientRuntime(
  playerId: string,
  securityDefinitionHash: string,
  signingPrivateKey: string
): GameClientRuntime {
  return new GameClientRuntime(
    playerId,
    BRIDGE_GAME_MANIFEST.game.id,
    securityDefinitionHash,
    signingPrivateKey,
    BRIDGE_GAME_MANIFEST
  );
}
