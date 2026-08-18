import manifestJson from './game.json';
import { GameManifestV1, GamePackage } from '../../types/contracts';
import { GamePackageHost, makePackageDescriptor } from '../gamePackageHost';

/**
 * Old Maid is now sourced from the standardized mental-deck-game/v1 JSON manifest.
 * Pair validity and turn order remain optional Rule Advisor behavior, not Core proof.
 */
export const OLD_MAID_GAME_MANIFEST = manifestJson as unknown as GameManifestV1;

export async function buildOldMaidGamePackage(): Promise<GamePackage> {
  GamePackageHost.validateManifest(OLD_MAID_GAME_MANIFEST);
  return {
    descriptor: await makePackageDescriptor(OLD_MAID_GAME_MANIFEST),
    manifest: OLD_MAID_GAME_MANIFEST,
  };
}
