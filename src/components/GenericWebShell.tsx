/**
 * Mental Deck - Generic Web Shell.
 *
 * The current in-browser 3-player harness is explicitly simulation-only. Production
 * rendering is blocked while the real multi-client Mental Poker provider is absent.
 */

import React, { useEffect, useState } from 'react';
import { GameCoordinator } from '../protocol/coordinator';
import { LocalKnowledgeStore } from '../crypto/localKnowledge';
import { OldMaidGameBoard } from './OldMaidGameBoard';
import { RoomLobby } from './RoomLobby';
import {
  CRYPTO_SECURITY_STATUS,
  MentalDeckCrypto,
  PRODUCTION_CRYPTO_AVAILABLE,
} from '../crypto/cryptoProvider';

interface GenericWebShellProps {
  coordinator: GameCoordinator;
  playerKeyMaterials: Map<string, string>;
  localKnowledgeMap: Map<string, LocalKnowledgeStore>;
}

export const GenericWebShell: React.FC<GenericWebShellProps> = ({
  coordinator,
  playerKeyMaterials,
  localKnowledgeMap,
}) => {
  const [activeViewerId, setActiveViewerId] = useState<string>('alice');
  const [isReady, setIsReady] = useState<boolean>(coordinator.phase === 'READY');
  const productionBlocked = import.meta.env.PROD && !PRODUCTION_CRYPTO_AVAILABLE;

  useEffect(() => {
    if (productionBlocked) return;

    async function autoInitSimulation() {
      if (coordinator.phase !== 'ROOM_OPEN') return;
      await coordinator.initializeRoom();
      const players = [
        { id: 'alice', name: 'Alice', isAi: false },
        { id: 'bob', name: 'Bob', isAi: false },
        { id: 'charlie_ai', name: 'AI', isAi: true },
      ];
      const signingSecrets = new Map<string, string>();

      for (const p of players) {
        const keys = await MentalDeckCrypto.generatePlayerKeys(p.id, coordinator.gameId);
        // DEV HARNESS ONLY: production clients must each own exactly one local secret set.
        playerKeyMaterials.set(p.id, keys.encryption.privateKey);
        signingSecrets.set(p.id, keys.signing.privateKey);
        await coordinator.registerPlayer({
          player_id: p.id,
          display_name: p.name,
          is_ai: p.isAi,
          signing_public_key: keys.signing.publicKey,
          encryption_public_key: keys.encryption.publicKey,
          pok_proof: keys.encryption.pokProof,
        });
      }

      await coordinator.lockRoster();
      await coordinator.lockDefinition();
      await coordinator.setupCryptoKeys();
      await coordinator.bootstrapPrivacyPool();
      await coordinator.executeVerifiableShuffle(playerKeyMaterials);
      const genesis = await coordinator.executeInitialAllocation();

      for (const p of coordinator.lockedRoster!.players) {
        const confirmationPayload = {
          game_id: coordinator.gameId,
          player_id: p.player_id,
          state_hash: genesis.state_hash,
          purpose: 'INITIAL_STATE_CONFIRM',
        };
        const confirmationSig = await MentalDeckCrypto.signSemanticIntent(
          signingSecrets.get(p.player_id)!,
          confirmationPayload
        );
        await coordinator.submitInitialStateConfirmation(p.player_id, genesis.state_hash, confirmationSig);

        // Simulation-only plaintext hydration. This is deliberately kept in the demo
        // harness and is blocked from production; real clients will learn cards only
        // through distributed disclosure.
        const hand = genesis.zone_states[`zone_hand_${p.player_id}`];
        const knowledge = localKnowledgeMap.get(p.player_id);
        if (hand && knowledge) {
          for (const ref of hand.card_refs) {
            const card = coordinator.simulationLookupCardInstance(ref);
            knowledge.recordKnowledge(ref.ref_id, card, 0);
          }
        }
      }
      setIsReady(true);
    }

    autoInitSimulation().catch(err => {
      console.error('Simulation initialization failed', err);
    });
  }, [coordinator, localKnowledgeMap, playerKeyMaterials, productionBlocked]);

  if (productionBlocked) {
    return (
      <div className="min-h-screen bg-[#F5F4F0] text-[#171B1E] grid place-items-center p-6">
        <div className="max-w-xl rounded-3xl border border-amber-300 bg-amber-50 p-7 shadow-sm space-y-3">
          <div className="text-xs font-mono font-bold text-amber-800">SECURITY GATE · RMD-TASK-004</div>
          <h1 className="text-xl font-bold">Mental Deck production mode is intentionally blocked.</h1>
          <p className="text-sm leading-relaxed text-zinc-700">
            The current crypto implementation is a single-process simulation and does not provide real Mental Poker / zero-knowledge security. Install and validate the real browser/WASM crypto provider before deploying this game for adversarial play.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#F5F4F0] text-[#171B1E] flex flex-col justify-between p-3 sm:p-6 selection:bg-[#205545]/20">
      <div className="w-full max-w-6xl mx-auto mb-3 rounded-2xl border border-amber-300 bg-amber-50 px-4 py-2.5 text-xs text-amber-900 flex flex-wrap items-center justify-between gap-2">
        <span className="font-semibold">Protocol simulation — not production-secure Mental Poker.</span>
        <span className="font-mono">{CRYPTO_SECURITY_STATUS}</span>
      </div>
      <main className="flex-1 flex flex-col justify-center items-center">
        {isReady ? (
          <OldMaidGameBoard
            coordinator={coordinator}
            activeViewerId={activeViewerId}
            onSwitchViewer={setActiveViewerId}
            localKnowledgeMap={localKnowledgeMap}
            playerKeyMaterials={playerKeyMaterials}
          />
        ) : (
          <RoomLobby
            coordinator={coordinator}
            onGameReady={() => setIsReady(true)}
            playerKeyMaterials={playerKeyMaterials}
          />
        )}
      </main>
    </div>
  );
};
