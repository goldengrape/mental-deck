import { GameClientRuntime } from '../../client/gameClientRuntime';
import { UNO_GAME_MANIFEST } from './package';

export function createUnoClientRuntime(
  playerId: string,
  securityDefinitionHash: string,
  signingPrivateKey: string
): GameClientRuntime {
  return new GameClientRuntime(
    playerId,
    UNO_GAME_MANIFEST.game.id,
    securityDefinitionHash,
    signingPrivateKey,
    UNO_GAME_MANIFEST
  );
}
