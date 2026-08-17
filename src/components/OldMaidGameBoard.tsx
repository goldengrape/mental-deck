/**
 * Mental Deck - Old Maid Interactive Game Board
 * Meticulously crafted "Quiet Table / 轻牌桌" aesthetic based on v0.1 UI Design specifications.
 */

import React, { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import confetti from 'canvas-confetti';
import {
  Sparkles,
  Bot,
  User,
  Crown,
  Shuffle,
  CheckCircle2,
  AlertCircle,
  Copy,
  Check,
  Settings,
  Info,
  ChevronUp,
  Dice5,
  Tag,
  Target,
} from 'lucide-react';
import { GameCoordinator } from '../protocol/coordinator';
import { CardGroup, CardInstance, CardRef, CommittedGameState, PlayerIdentity } from '../types/contracts';
import { LocalKnowledgeStore } from '../crypto/localKnowledge';
import { OldMaidClientContract } from '../plugins/oldMaid/clientRules';
import { AiGameAgent } from '../protocol/aiAgent';
import { PlayingCard } from './PlayingCard';
import { CardBack } from './CardBack';
import { ProtocolDrawer } from './ProtocolDrawer';

interface OldMaidGameBoardProps {
  coordinator: GameCoordinator;
  activeViewerId: string;
  onSwitchViewer: (viewerId: string) => void;
  localKnowledgeMap: Map<string, LocalKnowledgeStore>;
  playerKeyMaterials: Map<string, string>;
  onOpenDrawer?: () => void;
}

export const OldMaidGameBoard: React.FC<OldMaidGameBoardProps> = ({
  coordinator,
  activeViewerId,
  onSwitchViewer,
  localKnowledgeMap,
  playerKeyMaterials,
  onOpenDrawer,
}) => {
  const [gameState, setGameState] = useState<CommittedGameState>(coordinator.stateLedger.current);
  const [selectedCardRefs, setSelectedCardRefs] = useState<CardRef[]>([]);
  const [statusNote, setStatusNote] = useState<string>('正在一起洗牌');
  const [isAiAutoPlaying, setIsAiAutoPlaying] = useState<boolean>(true);
  const [isProcessing, setIsProcessing] = useState<boolean>(false);
  const [copiedRoom, setCopiedRoom] = useState<boolean>(false);
  const [isDrawerOpen, setIsDrawerOpen] = useState<boolean>(false);

  // Signature Draw Animation State ('idle' | 'random_fixed' | 'move_committed' | 'disclosing')
  const [drawAnimStage, setDrawAnimStage] = useState<'idle' | 'random_fixed' | 'move_committed' | 'disclosing'>('idle');
  const [newlyDrawnCard, setNewlyDrawnCard] = useState<CardInstance | null>(null);

  // Failed pair disclosure tracking
  const [disclosedMismatchedRefs, setDisclosedMismatchedRefs] = useState<Set<string>>(new Set());

  const ext = gameState.game_state_extension as {
    current_player_id: string;
    turn_number: number;
    draw_completed_this_turn: boolean;
    pairs_discarded_count: number;
    active_players: string[];
    finished_players: string[];
    history: string[];
  };

  const isMyTurn = ext.current_player_id === activeViewerId;
  const activeViewer = coordinator.lockedRoster?.players.find(p => p.player_id === activeViewerId);
  const localKnowledge = localKnowledgeMap.get(activeViewerId)!;

  // Determine target player to draw from (in turn order)
  const players = coordinator.lockedRoster?.players || [];
  const currentIdx = players.findIndex(p => p.player_id === activeViewerId);
  let targetOpponent: PlayerIdentity | undefined;
  if (currentIdx !== -1 && players.length > 1) {
    for (let offset = 1; offset < players.length; offset++) {
      const candidate = players[(currentIdx + offset) % players.length];
      const count = gameState.zone_states[`zone_hand_${candidate.player_id}`]?.card_refs.length || 0;
      if (count > 0) {
        targetOpponent = candidate;
        break;
      }
    }
  }

  // Sync local knowledge for newly dealt or drawn cards
  useEffect(() => {
    if (coordinator.lockedDefinition && coordinator.lockedRoster) {
      for (const p of coordinator.lockedRoster.players) {
        const handZone = gameState.zone_states[`zone_hand_${p.player_id}`];
        const pKnowledge = localKnowledgeMap.get(p.player_id);
        if (handZone && pKnowledge) {
          for (const ref of handZone.card_refs) {
            if (!pKnowledge.hasKnowledge(ref.ref_id)) {
              try {
                const inst = coordinator.lookupCardInstance(ref);
                if (inst) {
                  pKnowledge.recordKnowledge(ref.ref_id, inst, gameState.state_version);
                }
              } catch (e) {
                console.error('Failed to lookup card instance for ref', ref, e);
              }
            }
          }
        }
      }
    }
  }, [gameState.state_version, gameState.zone_states, activeViewerId]);

  // Check victory / game over
  useEffect(() => {
    if (coordinator.outcome) {
      confetti({
        particleCount: 100,
        spread: 70,
        origin: { y: 0.6 },
      });
    }
  }, [coordinator.outcome]);

  // AI Auto-Turn Loop
  useEffect(() => {
    if (!isAiAutoPlaying || coordinator.outcome || isProcessing) return;

    const currentPlayer = coordinator.lockedRoster?.players.find(p => p.player_id === ext.current_player_id);
    if (currentPlayer && currentPlayer.is_ai) {
      const timer = setTimeout(async () => {
        setIsProcessing(true);
        try {
          const aiKnowledge = localKnowledgeMap.get(currentPlayer.player_id)!;
          const aiAgent = new AiGameAgent(
            currentPlayer.player_id,
            coordinator.gameId,
            {
              game_id: coordinator.gameId,
              player_id: currentPlayer.player_id,
              signing_private_key: `sign_${currentPlayer.player_id}`,
              signing_public_key: currentPlayer.signing_public_key,
              encryption_private_key: playerKeyMaterials.get(currentPlayer.player_id) || '',
              encryption_public_key: currentPlayer.encryption_public_key,
              pok_proof: '',
              created_at: 0,
            }
          );
          aiAgent.localKnowledge = aiKnowledge;

          const action = await aiAgent.decideNextAction(coordinator.stateLedger.current);
          if (action) {
            const nextState = await coordinator.proposeGameIntent(action, playerKeyMaterials);
            setGameState(nextState);
            setSelectedCardRefs([]);
            setStatusNote(`AI ${currentPlayer.display_name} 完成操作：${action.action_type === 'draw_random_from_next_player' ? '随机抽牌' : action.action_type === 'discard_pair' ? '丢出一对' : '结束回合'}`);
          }
        } catch (err: any) {
          setStatusNote(`AI 错误：${err.message}`);
        } finally {
          setIsProcessing(false);
        }
      }, 1400);
      return () => clearTimeout(timer);
    }
  }, [ext.current_player_id, ext.draw_completed_this_turn, gameState.state_version, isAiAutoPlaying, isProcessing]);

  // Handle card click in current viewer hand
  const handleCardClick = (cardRef: CardRef) => {
    if (!isMyTurn) return;
    const isSelected = selectedCardRefs.some(r => r.ref_id === cardRef.ref_id);
    if (isSelected) {
      setSelectedCardRefs(selectedCardRefs.filter(r => r.ref_id !== cardRef.ref_id));
    } else {
      if (selectedCardRefs.length < 2) {
        setSelectedCardRefs([...selectedCardRefs, cardRef]);
      } else {
        setSelectedCardRefs([selectedCardRefs[1], cardRef]);
      }
    }
  };

  // Human Action: Discard Selected Pair
  const handleDiscardSelectedPair = async () => {
    if (selectedCardRefs.length !== 2 || !isMyTurn || isProcessing) return;
    setIsProcessing(true);
    try {
      const cardA = localKnowledge.getKnownCard(selectedCardRefs[0].ref_id);
      const cardB = localKnowledge.getKnownCard(selectedCardRefs[1].ref_id);
      const isMatched = cardA && cardB && cardA.rank === cardB.rank && !cardA.metadata?.is_old_maid && !cardB.metadata?.is_old_maid;

      const intent = await OldMaidClientContract.compileAndSignIntent(
        activeViewerId,
        'discard_pair',
        { card_ref_a: selectedCardRefs[0], card_ref_b: selectedCardRefs[1] },
        gameState,
        playerKeyMaterials.get(activeViewerId) || 'priv'
      );
      const nextState = await coordinator.proposeGameIntent(intent, playerKeyMaterials);
      setGameState(nextState);

      if (isMatched) {
        setStatusNote(`成功丢出一对：${cardA.symbol} ${cardB.symbol}`);
      } else {
        // Record mismatched disclosed cards
        setDisclosedMismatchedRefs(prev => new Set([...prev, selectedCardRefs[0].ref_id, selectedCardRefs[1].ref_id]));
        setStatusNote('不是一对。两张牌已经公开，仍留在你的手里。');
      }
      setSelectedCardRefs([]);
    } catch (err: any) {
      setStatusNote(`操作提示：${err.message}`);
    } finally {
      setIsProcessing(false);
    }
  };

  // Human Action: Signature Locked Draw ("抽到、锁定、再翻牌")
  const handleDrawRandom = async () => {
    if (!isMyTurn || isProcessing || ext.draw_completed_this_turn) return;
    setIsProcessing(true);

    try {
      // Step 1: RANDOM FIXED (Target opponent stack lightly collapses/pulses)
      setDrawAnimStage('random_fixed');
      setStatusNote('多方随机选牌中...');
      await new Promise(r => setTimeout(r, 450));

      // Step 2: MOVE COMMITTED (Card back flies to player's hand, still face down)
      setDrawAnimStage('move_committed');
      setStatusNote('已抽到 1 张牌（锁定中）');
      await new Promise(r => setTimeout(r, 600));

      // Execute real cryptographic commit & state transition
      const intent = await OldMaidClientContract.compileAndSignIntent(
        activeViewerId,
        'draw_random_from_next_player',
        {},
        gameState,
        playerKeyMaterials.get(activeViewerId) || 'priv'
      );
      const nextState = await coordinator.proposeGameIntent(intent, playerKeyMaterials);
      setGameState(nextState);

      // Step 3: PRIVATE DISCLOSURE (Flip card to reveal value to user)
      setDrawAnimStage('disclosing');
      setStatusNote('正在翻开你的牌...');
      await new Promise(r => setTimeout(r, 500));

      setDrawAnimStage('idle');
      setStatusNote('成功从对手处随机抽得 1 张牌！');
      setSelectedCardRefs([]);
    } catch (err: any) {
      setDrawAnimStage('idle');
      setStatusNote(`抽牌错误：${err.message}`);
    } finally {
      setIsProcessing(false);
    }
  };

  // Quick Pair Detection
  const currentHandRefs = gameState.zone_states[`zone_hand_${activeViewerId}`]?.card_refs || [];
  const foundPairs = OldMaidClientContract.findMatchingPairsInHand(currentHandRefs, localKnowledge);

  const handleQuickSelectPair = (pair: { cardA: { ref: CardRef }; cardB: { ref: CardRef } }) => {
    setSelectedCardRefs([pair.cardA.ref, pair.cardB.ref]);
  };

  const copyRoomCode = () => {
    navigator.clipboard?.writeText('7F2K');
    setCopiedRoom(true);
    setTimeout(() => setCopiedRoom(false), 2000);
  };

  const opponents = (coordinator.lockedRoster?.players || []).filter(p => p.player_id !== activeViewerId);
  const discardedGroups: CardGroup[] = Object.values(gameState.groups || {});

  const currentTurnPlayer = coordinator.lockedRoster?.players.find(p => p.player_id === ext.current_player_id);

  return (
    <div className="w-full max-w-6xl mx-auto flex flex-col space-y-4 sm:space-y-6">
      {/* Top Navigation Bar / Generic Shell Header */}
      <header className="w-full flex items-center justify-between px-2 sm:px-4 py-2 text-[#171B1E]">
        {/* Brand & Game Title */}
        <div className="flex items-center gap-2">
          <span className="font-bold tracking-tight text-sm sm:text-base font-sans">MENTAL DECK</span>
          <span className="text-zinc-400 font-normal text-xs sm:text-sm">/ OLD MAID</span>
        </div>

        {/* Room Code Badge */}
        <div
          onClick={copyRoomCode}
          className="hidden sm:flex items-center gap-1.5 px-3 py-1 rounded-full bg-white border border-[#E2DDD5] text-xs font-mono text-[#171B1E] cursor-pointer hover:bg-zinc-50 shadow-xs transition"
          title="点击复制房间号"
        >
          <span>Room 7F2K</span>
          {copiedRoom ? <Check className="w-3 h-3 text-emerald-600" /> : <Copy className="w-3 h-3 text-zinc-400" />}
        </div>

        {/* Identity Chip & Connection Status */}
        <div className="flex items-center gap-2 sm:gap-3">
          {/* Active Player Perspective Tag */}
          <div className="flex items-center gap-1.5 px-3 py-1 rounded-full bg-white border border-[#E2DDD5] text-xs shadow-xs">
            <span className="w-4 h-4 rounded-full bg-[#EBF3EF] text-[#205545] font-bold text-[10px] flex items-center justify-center">
              👤
            </span>
            <span className="font-semibold text-[#171B1E]">{activeViewer?.display_name || activeViewerId}</span>
            <span className="text-[#205545] font-medium text-[11px]">
              &bull; {isMyTurn ? '你的回合' : '等待中'}
            </span>
          </div>

          {/* Connection Status Indicator */}
          <div className="flex items-center gap-1.5 text-xs text-zinc-600 font-medium">
            <span className="w-2 h-2 rounded-full bg-emerald-500" />
            <span className="hidden sm:inline">Connected</span>
          </div>

          {/* Settings / Protocol Drawer Toggle */}
          <button
            onClick={() => setIsDrawerOpen(true)}
            className="w-8 h-8 rounded-full bg-white border border-[#E2DDD5] flex items-center justify-center text-zinc-600 hover:text-black hover:bg-zinc-50 shadow-xs transition"
            title="查看协议与密码学详情"
          >
            <Settings className="w-4 h-4" />
          </button>
        </div>
      </header>

      {/* Main Quiet Table Felt Stage (中央轻牌桌) */}
      <div className="w-full table-felt table-felt-inner rounded-3xl p-4 sm:p-8 relative min-h-[580px] flex flex-col justify-between border border-[#CAD8D1] shadow-md overflow-hidden">
        {/* Top Opponents Rail */}
        <div className="w-full flex items-center justify-between gap-4">
          {opponents.map(opp => {
            const oppHand = gameState.zone_states[`zone_hand_${opp.player_id}`]?.card_refs || [];
            const isTarget = targetOpponent?.player_id === opp.player_id;
            const isOppTurn = ext.current_player_id === opp.player_id;

            return (
              <div
                key={opp.player_id}
                className={`bg-white/95 rounded-2xl p-3 sm:p-4 shadow-sm border transition-all flex items-center justify-between gap-3 sm:gap-5 min-w-[140px] sm:min-w-[210px] ${
                  isTarget && isMyTurn
                    ? 'border-[#205545]/40 ring-2 ring-[#205545]/20'
                    : 'border-[#E2DDD5]'
                }`}
              >
                {/* Left: Avatar & Info */}
                <div className="flex items-start gap-2.5">
                  <div className="w-8 h-8 sm:w-10 sm:h-10 rounded-full bg-[#4A7C6D] text-white font-bold text-xs sm:text-sm flex items-center justify-center shrink-0 shadow-xs">
                    {opp.is_ai ? 'AI' : opp.display_name.charAt(0).toUpperCase()}
                  </div>
                  <div>
                    <div className="font-bold text-xs sm:text-sm text-[#171B1E] leading-tight flex items-center gap-1">
                      {opp.display_name.split(' ')[0]}
                    </div>
                    <div className="text-[11px] text-zinc-500 font-mono mt-0.5">
                      {oppHand.length} cards
                    </div>
                    <div className="mt-1.5 flex items-center gap-1">
                      {isTarget && isMyTurn ? (
                        <span className="px-2 py-0.5 rounded-full bg-[#EBF3EF] text-[#205545] text-[10px] font-semibold flex items-center gap-1">
                          <Target className="w-3 h-3" /> 抽牌目标
                        </span>
                      ) : (
                        <span className="text-[11px] text-zinc-400 flex items-center gap-1">
                          <span className="w-1.5 h-1.5 rounded-full bg-zinc-300" />
                          {isOppTurn ? '思考中' : '等待中'}
                        </span>
                      )}
                    </div>
                  </div>
                </div>

                {/* Right: Opponent Hidden Stack */}
                <div className="relative shrink-0">
                  <CardBack
                    count={oppHand.length}
                    size="stack"
                    className={`transition-transform ${
                      drawAnimStage === 'random_fixed' && isTarget ? 'scale-105 ring-2 ring-[#205545]' : ''
                    }`}
                  />
                </div>
              </div>
            );
          })}
        </div>

        {/* Center Table Area: Discarded Pairs & Turn Statement & Signature Action */}
        <div className="my-auto py-6 flex flex-col items-center justify-center space-y-4">
          {/* Discarded Pairs Inset Tray */}
          <div className="bg-white/80 border border-[#E2DDD5] rounded-2xl p-3 sm:p-4 shadow-xs max-w-lg w-full flex flex-col items-center">
            <span className="text-[11px] font-medium text-zinc-500 tracking-wider mb-2">
              已弃出的对子
            </span>

            <div className="flex flex-wrap gap-3 items-center justify-center min-h-16">
              {discardedGroups.map(group => {
                const cardA = gameState.public_bindings[group.member_refs[0]?.ref_id]?.card_instance;
                const cardB = gameState.public_bindings[group.member_refs[1]?.ref_id]?.card_instance;
                return (
                  <div
                    key={group.group_id}
                    className="flex items-center -space-x-2 bg-zinc-50/60 p-1 rounded-xl border border-zinc-200/60 shadow-2xs"
                  >
                    {cardA && <PlayingCard cardInstance={cardA} isFaceUp={true} size="sm" />}
                    {cardB && <PlayingCard cardInstance={cardB} isFaceUp={true} size="sm" />}
                  </div>
                );
              })}

              {discardedGroups.length === 0 && (
                <span className="text-xs text-zinc-400 py-3 italic">暂无已弃出的对子</span>
              )}
            </div>
          </div>

          {/* Current Turn Statement */}
          <div className="text-sm sm:text-base font-semibold text-[#171B1E] flex items-center gap-2">
            <span>{currentTurnPlayer?.display_name || ext.current_player_id} 的回合</span>
            {targetOpponent && (
              <>
                <span className="text-zinc-400">&rarr;</span>
                <span className="text-[#205545] font-bold">{targetOpponent.display_name}</span>
              </>
            )}
          </div>

          {/* Signature Action Button: [ 🎲 随机抽一张 ] */}
          <div className="flex flex-col items-center space-y-1.5">
            <button
              id="btn-random-draw"
              onClick={handleDrawRandom}
              disabled={!isMyTurn || isProcessing || ext.draw_completed_this_turn}
              className={`px-6 sm:px-8 py-3 rounded-2xl font-bold text-sm sm:text-base text-white transition-all shadow-md flex items-center gap-2 ${
                isMyTurn && !ext.draw_completed_this_turn && !isProcessing
                  ? 'bg-[#205545] hover:bg-[#1A4739] cursor-pointer hover:shadow-lg active:scale-98'
                  : 'bg-[#5B7970] opacity-60 cursor-not-allowed'
              }`}
            >
              <Dice5 className="w-5 h-5 text-white" />
              <span>随机抽一张</span>
            </button>

            <span className="text-[11px] sm:text-xs text-zinc-500">
              {targetOpponent
                ? `从 ${targetOpponent.display_name} 的 ${gameState.zone_states[`zone_hand_${targetOpponent.player_id}`]?.card_refs.length || 0} 张牌中随机抽一张`
                : '所有对手手牌已空'}
            </span>
          </div>
        </div>

        {/* Bottom Local Hand Dock (你的手牌) */}
        <div className="w-full bg-white/95 rounded-2xl p-4 sm:p-5 border border-[#E2DDD5] shadow-sm flex flex-col space-y-3">
          {/* Hand Header */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-xs sm:text-sm font-semibold text-[#171B1E]">
              <span>👤 你的手牌</span>
              <span className="text-zinc-400 font-mono">&bull; {currentHandRefs.length}</span>
            </div>

            {/* Quick Perspective Switcher */}
            <div className="flex items-center gap-1 bg-[#F5F4F0] p-1 rounded-xl">
              <span className="text-[10px] text-zinc-400 px-1 font-medium hidden sm:inline">视角：</span>
              {coordinator.lockedRoster?.players.map(p => (
                <button
                  key={p.player_id}
                  onClick={() => onSwitchViewer(p.player_id)}
                  className={`px-2 py-0.5 rounded-lg text-[11px] font-medium transition ${
                    activeViewerId === p.player_id
                      ? 'bg-white text-[#205545] font-bold shadow-2xs border border-zinc-200'
                      : 'text-zinc-500 hover:text-black'
                  }`}
                >
                  {p.display_name.split(' ')[0]}
                </button>
              ))}
            </div>
          </div>

          {/* Cards Row */}
          <div className="w-full flex items-center justify-start sm:justify-center gap-2 sm:gap-3 overflow-x-auto py-3 px-1 no-scrollbar min-h-28">
            {currentHandRefs.map(ref => {
              let knownInst = localKnowledge.getKnownCard(ref.ref_id);
              if (!knownInst && coordinator.lockedDefinition) {
                try {
                  knownInst = coordinator.lookupCardInstance(ref);
                  if (knownInst) {
                    localKnowledge.recordKnowledge(ref.ref_id, knownInst, gameState.state_version);
                  }
                } catch {
                  // Fallback
                }
              }
              const isSelected = selectedCardRefs.some(r => r.ref_id === ref.ref_id);
              const isCandidate = foundPairs.some(
                p => p.cardA.ref.ref_id === ref.ref_id || p.cardB.ref.ref_id === ref.ref_id
              );
              const isDisclosed = disclosedMismatchedRefs.has(ref.ref_id);

              return (
                <PlayingCard
                  key={ref.ref_id}
                  cardInstance={knownInst ?? undefined}
                  isFaceUp={!!knownInst}
                  isSelected={isSelected}
                  isPairCandidate={isCandidate}
                  isPublicKnown={isDisclosed}
                  onClick={() => handleCardClick(ref)}
                  size="md"
                />
              );
            })}

            {currentHandRefs.length === 0 && (
              <div className="text-xs text-emerald-700 font-bold py-6 flex items-center gap-1.5">
                <Crown className="w-4 h-4 text-amber-500" /> 手牌已清空！顺利逃脱！
              </div>
            )}
          </div>

          {/* Bottom Action Strip: Discard Pairs & Feedback */}
          <div className="pt-2 border-t border-zinc-100 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
            {/* Auto Pair Hint or Selected Pair */}
            <div className="flex items-center gap-2 text-xs">
              {foundPairs.length > 0 ? (
                <div className="flex items-center gap-2">
                  <span className="text-zinc-600 flex items-center gap-1">
                    <Tag className="w-3.5 h-3.5 text-[#205545]" /> 可丢出一对：
                  </span>
                  <div
                    onClick={() => handleQuickSelectPair(foundPairs[0])}
                    className="flex items-center gap-1 bg-[#F5F4F0] px-2 py-0.5 rounded-md cursor-pointer hover:bg-zinc-200 transition font-medium"
                  >
                    <span className={foundPairs[0].cardA.instance.suit === '♥' || foundPairs[0].cardA.instance.suit === '♦' ? 'text-[#C83737]' : 'text-[#171B1E]'}>
                      {foundPairs[0].cardA.instance.symbol}
                    </span>
                    <span className={foundPairs[0].cardB.instance.suit === '♥' || foundPairs[0].cardB.instance.suit === '♦' ? 'text-[#C83737]' : 'text-[#171B1E]'}>
                      {foundPairs[0].cardB.instance.symbol}
                    </span>
                  </div>
                </div>
              ) : (
                <span className="text-zinc-400 text-xs">
                  {selectedCardRefs.length > 0 ? `已选 ${selectedCardRefs.length}/2 张牌` : '请点击 2 张相同点数的牌进行弃牌'}
                </span>
              )}
            </div>

            {/* Discard Pair Button */}
            <div className="flex items-center gap-2 w-full sm:w-auto justify-end">
              <button
                id="btn-discard-pair"
                onClick={handleDiscardSelectedPair}
                disabled={selectedCardRefs.length !== 2 || !isMyTurn || isProcessing}
                className="px-4 py-1.5 rounded-xl border border-[#205545] text-[#205545] hover:bg-[#EBF3EF] disabled:opacity-30 disabled:border-zinc-300 disabled:text-zinc-400 disabled:hover:bg-transparent font-medium text-xs sm:text-sm transition shadow-2xs"
              >
                丢出这对
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Footer Bar: Protocol Natural Language Status & Drawer Entry */}
      <footer className="w-full flex items-center justify-between px-2 sm:px-4 py-1 text-xs text-zinc-500 font-sans">
        <div className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-[#205545]" />
          <span>{statusNote}</span>
        </div>

        <button
          onClick={() => setIsDrawerOpen(true)}
          className="flex items-center gap-1.5 px-3 py-1 rounded-xl bg-white border border-[#E2DDD5] text-[#171B1E] font-medium text-xs hover:bg-zinc-50 shadow-2xs transition"
        >
          <Info className="w-3.5 h-3.5 text-zinc-500" />
          <span>协议信息</span>
          <ChevronUp className="w-3 h-3 text-zinc-400" />
        </button>
      </footer>

      {/* Protocol Advanced Drawer */}
      <ProtocolDrawer
        isOpen={isDrawerOpen}
        onClose={() => setIsDrawerOpen(false)}
        coordinator={coordinator}
      />

      {/* Game Over Modal */}
      <AnimatePresence>
        {coordinator.outcome && (
          <motion.div
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-xs"
          >
            <div className="bg-white border border-[#E2DDD5] rounded-3xl p-8 max-w-md w-full text-center shadow-xl space-y-4">
              <div className="w-16 h-16 rounded-2xl bg-[#EBF3EF] text-[#205545] border border-[#205545]/20 flex items-center justify-center mx-auto mb-2">
                <Crown className="w-8 h-8" />
              </div>
              <h3 className="text-xl font-bold text-[#171B1E]">牌局结束！</h3>
              <p className="text-xs text-zinc-600 leading-relaxed">{coordinator.outcome.reason}</p>

              <div className="p-3.5 rounded-xl bg-[#F5F4F0] border border-[#E2DDD5] text-xs text-zinc-700 leading-relaxed">
                丢出全部对子的玩家顺利逃脱获胜，最后留下黑桃Q（抽乌龟）的玩家失败。
              </div>

              <button
                onClick={() => window.location.reload()}
                className="w-full py-2.5 rounded-xl bg-[#205545] hover:bg-[#1A4739] text-white font-bold text-sm shadow-md transition"
              >
                开新一局
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};
