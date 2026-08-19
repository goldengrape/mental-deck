import { MentalDeckCrypto } from '../crypto/cryptoProvider';
import { buildOldMaidGamePackage } from '../plugins/oldMaid/package';
import { PhysicalDeckCoordinator } from '../protocol/physicalDeckCoordinator';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function expectReject(fn: () => Promise<unknown>, pattern: RegExp, label: string): Promise<void> {
  try {
    await fn();
    throw new Error(`${label}: expected rejection, operation succeeded`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('expected rejection, operation succeeded')) throw error;
    assert(pattern.test(message), `${label}: wrong rejection: ${message}`);
  }
}

async function invalidEncryptionOwnershipProofIsRejected(): Promise<void> {
  const packageDef = await buildOldMaidGamePackage();
  const coordinator = new PhysicalDeckCoordinator(packageDef.manifest.game.id, packageDef);
  const keys = await MentalDeckCrypto.generatePlayerKeys('alice', packageDef.manifest.game.id);
  await expectReject(
    () => coordinator.registerPlayer({
      player_id: 'alice',
      display_name: 'Alice',
      is_ai: false,
      signing_public_key: keys.signing.publicKey,
      encryption_public_key: keys.encryption.publicKey,
      pok_proof: JSON.stringify({ gameId: packageDef.manifest.game.id, nonce: 'x', challenge: 'y', response: 'z' }),
    }),
    /ownership proof failed/,
    'invalid encryption PoK'
  );
}

async function packageAndSecurityHashesHaveDifferentResponsibilities(): Promise<void> {
  const packageDef = await buildOldMaidGamePackage();
  assert(packageDef.descriptor.package_release_hash.length === 64, 'package release hash missing');
  const coordinator = new PhysicalDeckCoordinator(packageDef.manifest.game.id, packageDef);
  for (const id of ['alice', 'bob']) {
    const keys = await MentalDeckCrypto.generatePlayerKeys(id, packageDef.manifest.game.id);
    await coordinator.registerPlayer({
      player_id: id,
      display_name: id,
      is_ai: false,
      signing_public_key: keys.signing.publicKey,
      encryption_public_key: keys.encryption.publicKey,
      pok_proof: keys.encryption.pokProof,
    });
  }
  await coordinator.lockRoster();
  const definition = await coordinator.lockSecurityDefinition();
  assert(definition.security_definition_hash.length === 64, 'security definition hash missing');
  assert(definition.package_release_hash === packageDef.descriptor.package_release_hash, 'locked definition lost release-integrity hash');
}

const tests: Array<[string, () => Promise<void>]> = [
  ['invalid encryption ownership proof is rejected', invalidEncryptionOwnershipProofIsRejected],
  ['package release hash and security definition hash are distinct commitments', packageAndSecurityHashesHaveDifferentResponsibilities],
];

let failures = 0;
for (const [name, test] of tests) {
  try { await test(); console.log(`PASS  ${name}`); }
  catch (error) { failures++; console.error(`FAIL  ${name}`); console.error(error); }
}
if (failures) throw new Error(`${failures}/${tests.length} v0.10 gate tests failed`);
console.log(`\n${tests.length}/${tests.length} v0.10 gate tests passed.`);
