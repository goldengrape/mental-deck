import { readFile } from 'node:fs/promises';
import { GameClientRuntime } from '../client/gameClientRuntime';
import { MentalDeckCrypto } from '../crypto/cryptoProvider';
import { buildOldMaidGamePackage } from '../plugins/oldMaid/package';
import { buildUnoGamePackage } from '../plugins/uno/package';
import { buildBridgeGamePackage } from '../plugins/bridge/package';
import { GamePackageHost } from '../plugins/gamePackageHost';
import { PhysicalDeckCoordinator } from '../protocol/physicalDeckCoordinator';
import {
  exportPhysicalDeckAuditBundle,
  verifyPhysicalDeckAuditEnvelope,
} from '../protocol/physicalDeckAudit';
import type { CardRef, PlayerIdentity } from '../types/contracts';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function expectReject(fn: () => Promise<unknown> | unknown, pattern: RegExp, label: string): Promise<void> {
  try {
    await fn();
    throw new Error(`${label}: expected rejection, operation succeeded`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('expected rejection, operation succeeded')) throw error;
    assert(pattern.test(message), `${label}: wrong rejection: ${message}`);
  }
}

async function readyOldMaid() {
  const packageDef = await buildOldMaidGamePackage();
  const coordinator = new PhysicalDeckCoordinator(packageDef.manifest.game.id, packageDef);
  const secrets = new Map<string, string>();
  const identities: PlayerIdentity[] = [];
  for (const id of ['alice', 'bob', 'charlie_ai']) {
    const keys = await MentalDeckCrypto.generatePlayerKeys(id, packageDef.manifest.game.id);
    secrets.set(id, keys.signing.privateKey);
    const identity = {
      player_id: id,
      display_name: id,
      is_ai: id.includes('ai'),
      signing_public_key: keys.signing.publicKey,
      encryption_public_key: keys.encryption.publicKey,
      pok_proof: keys.encryption.pokProof,
    } satisfies PlayerIdentity;
    identities.push(identity);
    await coordinator.registerPlayer(identity);
  }
  await coordinator.lockRoster();
  const definition = await coordinator.lockSecurityDefinition();
  const refs: CardRef[] = Array.from({ length: 51 }, (_, index) => ({ ref_id: `audit_${index}`, epoch: 1 }));
  await coordinator.initializeOpaqueState(refs);
  return { packageDef, coordinator, secrets, identities, definition };
}

async function auditBundleUsesMinimalUnifiedTransitions(): Promise<void> {
  const { packageDef, coordinator, secrets, definition } = await readyOldMaid();
  const client = new GameClientRuntime(
    'alice',
    packageDef.manifest.game.id,
    definition.security_definition_hash,
    secrets.get('alice')!,
    packageDef.manifest
  );
  const draw = await client.signMechanicalIntent(
    'draw_random_from_player',
    { target_player_id: 'bob' },
    coordinator.stateLedger!.current
  );
  await coordinator.submitMechanicalIntent(draw);
  const endTurn = await client.signPublicGameEvent('end_turn', {}, coordinator.stateLedger!.current);
  await coordinator.submitPublicGameEvent(endTurn);

  const bundle = exportPhysicalDeckAuditBundle(
    coordinator.gameId,
    definition,
    coordinator.lockedRoster!,
    coordinator.stateLedger!
  );
  verifyPhysicalDeckAuditEnvelope(bundle);
  assert(bundle.final_state_version === 2, 'audit bundle missed unified event/mechanical transitions');
  assert(bundle.transitions.map(record => record.transition_kind).join(',') === 'MECHANICAL,PUBLIC_GAME_EVENT', 'audit transition order mismatch');
  assert(!JSON.stringify(bundle).includes('audit_'), 'audit bundle leaked stable hidden CardRef IDs');

  const tampered = structuredClone(bundle);
  tampered.transitions[1].base_state_hash = 'tampered';
  await expectReject(() => verifyPhysicalDeckAuditEnvelope(tampered), /state-hash chain mismatch/, 'tampered audit chain');
}

async function coordinatorHasNoGameSpecificImports(): Promise<void> {
  const source = await readFile(new URL('../protocol/physicalDeckCoordinator.ts', import.meta.url), 'utf8');
  assert(!/plugins\/(oldMaid|uno|bridge)/.test(source), 'Generic Coordinator imports a concrete game package');
  assert(!/OldMaid|Uno|UNO|Bridge/.test(source), 'Generic Coordinator contains game-specific branches/names');
  assert(!/RuleAdvisor/.test(source), 'Generic Coordinator depends on Rule Advisor for authorization');
}

async function manifestSchemaStaysDeclarative(): Promise<void> {
  const schemaText = await readFile(new URL('../../schemas/mental-deck-game-v1.schema.json', import.meta.url), 'utf8');
  const schema = JSON.parse(schemaText) as Record<string, unknown>;
  assert(schema.$schema === 'https://json-schema.org/draft/2020-12/schema', 'JSON Schema version mismatch');
  const lower = schemaText.toLowerCase();
  for (const forbidden of ['javascript', 'eval(', 'authorizationexpression', 'rulepredicate']) {
    assert(!lower.includes(forbidden), `manifest schema accidentally exposes rule DSL hook: ${forbidden}`);
  }

  for (const packageDef of [await buildOldMaidGamePackage(), await buildUnoGamePackage(), await buildBridgeGamePackage()]) {
    GamePackageHost.validateManifest(packageDef.manifest);
    assert(packageDef.manifest.schema === 'mental-deck-game/v1', `${packageDef.manifest.game.name} is not sourced from v1 manifest`);
  }
}

const tests: Array<[string, () => Promise<void>]> = [
  ['audit bundle uses unified minimal-disclosure transition stream', auditBundleUsesMinimalUnifiedTransitions],
  ['generic coordinator has no concrete game or Rule Advisor dependency', coordinatorHasNoGameSpecificImports],
  ['mental-deck-game/v1 schema stays declarative and all reference packages validate', manifestSchemaStaysDeclarative],
];

let failures = 0;
for (const [name, test] of tests) {
  try { await test(); console.log(`PASS  ${name}`); }
  catch (error) { failures++; console.error(`FAIL  ${name}`); console.error(error); }
}
if (failures) throw new Error(`${failures}/${tests.length} v0.10 audit/architecture tests failed`);
console.log(`\n${tests.length}/${tests.length} v0.10 audit/architecture tests passed.`);
