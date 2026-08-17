/**
 * Mental Deck - Room Lobby & Cryptographic Setup Ceremony Component
 * Quiet Table tactile styling for setup, registration, and verifiable shuffle.
 */

import React, { useState } from 'react';
import { motion } from 'motion/react';
import {
  ShieldCheck,
  Users,
  KeyRound,
  Shuffle,
  CheckCircle2,
  Sparkles,
  Bot,
  UserCheck,
  Lock,
  ArrowRight,
  Dice5,
} from 'lucide-react';
import { GameCoordinator, RoomPhase } from '../protocol/coordinator';
import { OLD_MAID_PLUGIN_DESCRIPTOR } from '../plugins/oldMaid/definition';
import { MentalDeckCrypto } from '../crypto/cryptoProvider';

interface RoomLobbyProps {
  coordinator: GameCoordinator;
  onGameReady: () => void;
  playerKeyMaterials: Map<string, string>;
}

export const RoomLobby: React.FC<RoomLobbyProps> = ({
  coordinator,
  onGameReady,
  playerKeyMaterials,
}) => {
  const [phase, setPhase] = useState<RoomPhase>(coordinator.phase);
  const [loading, setLoading] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string>('准备开始牌局设置仪式。');

  // Step 1: Initialize Room
  const handleInitRoom = async () => {
    setLoading(true);
    try {
      await coordinator.initializeRoom(OLD_MAID_PLUGIN_DESCRIPTOR);
      setPhase(coordinator.phase);
      setStatusMessage('已锁定插件：Old Maid v0.9（51张牌，25对 + 1张乌龟/鬼牌）。');
    } catch (err: any) {
      setStatusMessage(`错误：${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  // Step 2: Add 3 Standard Players
  const handleAddDefaultPlayers = async () => {
    setLoading(true);
    try {
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

      setPhase(coordinator.phase);
      setStatusMessage('3 位玩家已就绪（Alice、Bob、AI）。多方临时公私钥已生成。');
    } catch (err: any) {
      setStatusMessage(`错误：${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  // Step 3: Lock Roster & Definition
  const handleLockRosterAndDefinition = async () => {
    setLoading(true);
    try {
      await coordinator.lockRoster();
      await coordinator.lockDefinition();
      setPhase(coordinator.phase);
      setStatusMessage('玩家名单与游戏定义已锁定，卡牌清单已确定。');
    } catch (err: any) {
      setStatusMessage(`错误：${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  // Step 4: Joint Key Setup & Privacy Pool
  const handleKeySetupAndPool = async () => {
    setLoading(true);
    try {
      await coordinator.setupCryptoKeys();
      await coordinator.bootstrapPrivacyPool();
      setPhase(coordinator.phase);
      setStatusMessage('联合公钥已派生，51 张加密卡牌已注入隐私池。');
    } catch (err: any) {
      setStatusMessage(`错误：${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  // Step 5: Multi-Party Verifiable Shuffle & Allocation & Confirmation -> READY
  const handleCompleteSetup = async () => {
    setLoading(true);
    try {
      setStatusMessage('正在执行多方可验证重加密洗牌与零知识置换证明...');
      await coordinator.executeVerifiableShuffle(playerKeyMaterials);

      setStatusMessage('根据分配方案分配盲牌引用至各玩家手牌...');
      const genesis = await coordinator.executeInitialAllocation();

      setStatusMessage('所有玩家共同签名确认创世状态哈希...');
      for (const p of coordinator.lockedRoster!.players) {
        await coordinator.submitInitialStateConfirmation(p.player_id, genesis.state_hash);
      }

      setPhase(coordinator.phase);
      setStatusMessage('设置仪式完成！所有客户端同步至 state_version 0，正在进入牌桌...');
      setTimeout(() => {
        onGameReady();
      }, 600);
    } catch (err: any) {
      setStatusMessage(`错误：${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  // 1-Click Quick Setup
  const handleOneClickQuickStart = async () => {
    setLoading(true);
    try {
      setStatusMessage('正在快速完成多方零知识牌局准备与洗牌...');
      if (coordinator.phase === 'ROOM_OPEN') await coordinator.initializeRoom();
      if (coordinator.draftPlayers.length === 0) {
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
      }
      await coordinator.lockRoster();
      await coordinator.lockDefinition();
      await coordinator.setupCryptoKeys();
      await coordinator.bootstrapPrivacyPool();
      await coordinator.executeVerifiableShuffle(playerKeyMaterials);
      const genesis = await coordinator.executeInitialAllocation();
      for (const p of coordinator.lockedRoster!.players) {
        await coordinator.submitInitialStateConfirmation(p.player_id, genesis.state_hash);
      }
      setPhase('READY');
      onGameReady();
    } catch (err: any) {
      setStatusMessage(`错误：${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  const steps = [
    { title: '房间与插件', isDone: phase !== 'ROOM_OPEN' },
    { title: '玩家注册', isDone: phase !== 'ROOM_OPEN' && phase !== 'PLUGIN_PINNED' && coordinator.draftPlayers.length >= 2 },
    { title: '锁定定义', isDone: ['DEFINITION_LOCKED', 'KEY_SETUP', 'PRIVACY_POOL_READY', 'INITIAL_VERIFIABLE_SHUFFLE', 'INITIAL_ALLOCATION', 'READY'].includes(phase) },
    { title: '隐私池与密钥', isDone: ['PRIVACY_POOL_READY', 'INITIAL_VERIFIABLE_SHUFFLE', 'INITIAL_ALLOCATION', 'READY'].includes(phase) },
    { title: '洗牌与发牌', isDone: phase === 'READY' },
  ];

  return (
    <div className="max-w-4xl mx-auto space-y-5 text-[#171B1E]">
      {/* Header Container */}
      <div className="bg-white rounded-3xl p-6 sm:p-8 border border-[#E2DDD5] shadow-xs flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 mb-2">
            <span className="bg-[#EBF3EF] text-[#205545] text-xs font-semibold px-2.5 py-0.5 rounded-full">
              Mental Poker &bull; 无可信发牌员
            </span>
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-[#171B1E]">
            Mental Deck &bull; 房间大厅与洗牌仪式
          </h1>
          <p className="text-xs text-zinc-500 mt-1 max-w-lg leading-relaxed">
            Old Maid (抽乌龟) 3人局（Alice、Bob、AI）。51 张卡牌通过多方联合加密与置换洗牌，任何单方均无法窥探私牌。
          </p>
        </div>

        <button
          id="btn-quick-start"
          onClick={handleOneClickQuickStart}
          disabled={loading}
          className="px-5 py-3 rounded-2xl bg-[#205545] hover:bg-[#1A4739] text-white font-bold text-xs sm:text-sm shadow-md transition-all active:scale-98 shrink-0 flex items-center gap-2"
        >
          <Sparkles className="w-4 h-4 text-amber-300" />
          一键准备并开局
        </button>
      </div>

      {/* Pipeline Steps */}
      <div className="bg-white rounded-3xl p-6 border border-[#E2DDD5] shadow-xs space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-bold text-[#171B1E] flex items-center gap-2">
            <KeyRound className="w-4 h-4 text-[#205545]" /> 密码学准备流程
          </h2>
          <span className="text-xs text-zinc-400 font-mono">{phase}</span>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-5 gap-2.5">
          {steps.map((step, idx) => (
            <div
              key={idx}
              className={`p-3 rounded-xl border flex flex-col items-center text-center transition-all ${
                step.isDone
                  ? 'bg-[#EBF3EF] border-[#CAD8D1] text-[#205545]'
                  : 'bg-[#FAF8F5] border-[#E2DDD5] text-zinc-400'
              }`}
            >
              <div className="flex items-center justify-center w-6 h-6 rounded-lg mb-1.5 font-bold text-xs">
                {step.isDone ? (
                  <CheckCircle2 className="w-5 h-5 text-[#205545]" />
                ) : (
                  <span className="w-5 h-5 rounded-full bg-zinc-200 text-zinc-500 flex items-center justify-center text-[10px] font-mono">
                    {idx + 1}
                  </span>
                )}
              </div>
              <span className="text-xs font-medium">{step.title}</span>
            </div>
          ))}
        </div>

        {/* Action Panel */}
        <div className="p-4 rounded-xl bg-[#FAF8F5] border border-[#E2DDD5] flex flex-col sm:flex-row items-center justify-between gap-3">
          <div className="text-xs text-zinc-600 font-medium">
            <span className="font-bold text-[#205545]">当前状态：</span>
            {statusMessage}
          </div>

          <div className="flex items-center gap-2 shrink-0">
            {phase === 'ROOM_OPEN' && (
              <button
                onClick={handleInitRoom}
                disabled={loading}
                className="px-4 py-2 bg-[#205545] text-white rounded-xl text-xs font-bold hover:bg-[#1A4739] transition"
              >
                1. 锁定插件 <ArrowRight className="w-3.5 h-3.5 inline ml-1" />
              </button>
            )}

            {phase === 'PLUGIN_PINNED' && (
              <button
                onClick={handleAddDefaultPlayers}
                disabled={loading}
                className="px-4 py-2 bg-[#205545] text-white rounded-xl text-xs font-bold hover:bg-[#1A4739] transition"
              >
                2. 注册 3 位玩家 <Users className="w-3.5 h-3.5 inline ml-1" />
              </button>
            )}

            {phase === 'PLAYERS_JOINING' && (
              <button
                onClick={handleLockRosterAndDefinition}
                disabled={loading}
                className="px-4 py-2 bg-[#205545] text-white rounded-xl text-xs font-bold hover:bg-[#1A4739] transition"
              >
                3. 锁定名单 <Lock className="w-3.5 h-3.5 inline ml-1" />
              </button>
            )}

            {phase === 'DEFINITION_LOCKED' && (
              <button
                onClick={handleKeySetupAndPool}
                disabled={loading}
                className="px-4 py-2 bg-[#205545] text-white rounded-xl text-xs font-bold hover:bg-[#1A4739] transition"
              >
                4. 派生联合密钥 <KeyRound className="w-3.5 h-3.5 inline ml-1" />
              </button>
            )}

            {phase === 'PRIVACY_POOL_READY' && (
              <button
                onClick={handleCompleteSetup}
                disabled={loading}
                className="px-4 py-2 bg-[#205545] text-white rounded-xl text-xs font-bold hover:bg-[#1A4739] transition"
              >
                5. 完成洗牌并进入 <Shuffle className="w-3.5 h-3.5 inline ml-1" />
              </button>
            )}

            {phase === 'READY' && (
              <button
                onClick={onGameReady}
                className="px-4 py-2 bg-[#205545] text-white rounded-xl text-xs font-bold hover:bg-[#1A4739] transition"
              >
                进入牌桌 <ArrowRight className="w-3.5 h-3.5 inline ml-1" />
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Players List Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        {coordinator.draftPlayers.map((player, idx) => (
          <div
            key={player.player_id}
            className="p-4 rounded-2xl bg-white border border-[#E2DDD5] shadow-2xs flex flex-col justify-between"
          >
            <div>
              <div className="flex items-center justify-between mb-2">
                <span className="text-[11px] font-mono text-zinc-400">座位 #{idx + 1}</span>
                {player.is_ai ? (
                  <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-purple-50 text-purple-700">
                    AI Agent
                  </span>
                ) : (
                  <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-blue-50 text-blue-700">
                    人类玩家
                  </span>
                )}
              </div>
              <h3 className="text-sm font-bold text-[#171B1E]">{player.display_name}</h3>
              <p className="text-[11px] text-zinc-400 font-mono mt-0.5">ID: {player.player_id}</p>
            </div>

            <div className="mt-3 pt-2 border-t border-zinc-100 text-[11px] text-zinc-500 space-y-1">
              <div className="flex justify-between">
                <span>PoK 密钥证明：</span>
                <span className="text-emerald-700 font-medium">已验证</span>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};
