import manifestJson from './game.json';
import { GameManifestV1, GamePackage } from '../../types/contracts';
import { GamePackageHost, makePackageDescriptor } from '../gamePackageHost';

export const BRIDGE_GAME_MANIFEST = manifestJson as unknown as GameManifestV1;

export async function buildBridgeGamePackage(): Promise<GamePackage> {
  GamePackageHost.validateManifest(BRIDGE_GAME_MANIFEST);
  return {
    descriptor: await makePackageDescriptor(BRIDGE_GAME_MANIFEST),
    manifest: BRIDGE_GAME_MANIFEST,
  };
}
