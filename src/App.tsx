/**
 * Mental Deck - Main Application Entrypoint
 */

import React, { useMemo } from 'react';
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
    <div>
      <div className="mx-auto max-w-5xl px-4 pt-3 text-[11px] leading-relaxed text-amber-900">
        <div className="rounded-xl border border-amber-300 bg-amber-50 px-3 py-2">
          安全模型：当前为 trusted-coordinator 原型。玩家操作已使用 WebCrypto ECDSA 验证；联合加密、重加密洗牌与零知识置换证明仍是模拟实现，不能视为生产级 Mental Poker 密码学。
        </div>
      </div>
      <GenericWebShell
        coordinator={coordinator}
        playerKeyMaterials={playerKeyMaterials}
        localKnowledgeMap={localKnowledgeMap}
      />
    </div>
  );
}
