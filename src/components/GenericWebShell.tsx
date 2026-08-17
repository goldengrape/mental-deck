/**
 * Mental Deck - Generic Web Shell (MDD-MOD-026, URD-ARCH-007, URD-PLAT-001)
 * Clean, lightweight shell wrapping the Quiet Table Game Adapter.
 */

import React, { useState, useEffect } from 'react';
import { GameCoordinator } from '../protocol/coordinator';
import { LocalKnowledgeStore } from '../crypto/localKnowledge';
import { OldMaidGameBoard } from './OldMaidGameBoard';
import { RoomLobby } from './RoomLobby';
import { MentalDeckCrypto } from '../crypto/cryptoProvider';

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

  // Auto initialize default 3-player match so the user instantly lands on the digital card table!
  useEffect(() => {
    async function autoInit() {
      if (coordinator.phase === 'ROOM_OPEN') {
        await coordinator.initializeRoom();
        const pList = [
          { id: 'alice', name: 'Alice', isAi: false },
          { id: 'bob', name: 'Bob', isAi: false },
          { id: 'charlie_ai', name: 'AI', isAi: true },
        ];
        for (const p of pList) {
          const keys = await MentalDeckCrypto.generatePlayerKeys(p.id, coordinator.gameId);
          playerKeyMaterials.set(p.id, keys.encryption.privateKey);
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
          await coordinator.submitInitialStateConfirmation(p.player_id, genesis.state_hash);
          const hand = genesis.zone_states[`zone_hand_${p.player_id}`];
          const kStore = localKnowledgeMap.get(p.player_id);
          if (hand && kStore) {
            for (const ref of hand.card_refs) {
              const inst = coordinator.lookupCardInstance(ref);
              if (inst) {
                kStore.recordKnowledge(ref.ref_id, inst, 0);
              }
            }
          }
        }
        setIsReady(true);
      }
    }
    autoInit();
  }, []);

  return (
    <div className="min-h-screen bg-[#F5F4F0] text-[#171B1E] flex flex-col justify-between p-3 sm:p-6 selection:bg-[#205545]/20">
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
