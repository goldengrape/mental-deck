/**
 * Mental Deck - Main Application Entrypoint
 * Initializes Coordinator, Local Knowledge Stores, and Web Shell.
 */

import React, { useState, useMemo } from 'react';
import { GameCoordinator } from './protocol/coordinator';
import { LocalKnowledgeStore } from './crypto/localKnowledge';
import { GenericWebShell } from './components/GenericWebShell';

export default function App() {
  const gameId = useMemo(() => 'game_mental_deck_001', []);
  const coordinator = useMemo(() => new GameCoordinator(gameId), [gameId]);

  const playerKeyMaterials = useMemo(() => new Map<string, string>(), []);
  const localKnowledgeMap = useMemo(() => {
    const map = new Map<string, LocalKnowledgeStore>();
    map.set('alice', new LocalKnowledgeStore('alice', gameId));
    map.set('bob', new LocalKnowledgeStore('bob', gameId));
    map.set('charlie_ai', new LocalKnowledgeStore('charlie_ai', gameId));
    return map;
  }, [gameId]);

  return (
    <GenericWebShell
      coordinator={coordinator}
      playerKeyMaterials={playerKeyMaterials}
      localKnowledgeMap={localKnowledgeMap}
    />
  );
}
