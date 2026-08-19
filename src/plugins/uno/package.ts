import manifestJson from './game.json';
import { GameManifestV1, GamePackage } from '../../types/contracts';
import { GamePackageHost, makePackageDescriptor } from '../gamePackageHost';

/**
 * UNO is sourced from mental-deck-game/v1 JSON. Color/value legality and Wild Draw
 * Four eligibility are Rule Advisor concerns; Core protects only physical-card rights.
 */
export const UNO_GAME_MANIFEST = manifestJson as unknown as GameManifestV1;

export async function buildUnoGamePackage(): Promise<GamePackage> {
  GamePackageHost.validateManifest(UNO_GAME_MANIFEST);
  return {
    descriptor: await makePackageDescriptor(UNO_GAME_MANIFEST),
    manifest: UNO_GAME_MANIFEST,
  };
}
