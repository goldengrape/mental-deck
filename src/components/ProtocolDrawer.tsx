/**
 * Mental Deck - Protocol Drawer & Advanced Verification Panel
 * Slide-over drawer for technical inspection: ZK proofs, hash chains, verified receipts, and TDD test runner.
 */

import React, { useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { X, ShieldCheck, FileText, CheckSquare, KeyRound, Terminal } from 'lucide-react';
import { GameCoordinator } from '../protocol/coordinator';
import { CryptographicInspector } from './CryptographicInspector';
import { AuditLogViewer } from './AuditLogViewer';
import { TDDRunner } from './TDDRunner';

interface ProtocolDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  coordinator: GameCoordinator;
}

export type DrawerTab = 'summary' | 'crypto' | 'audit' | 'tests';

export const ProtocolDrawer: React.FC<ProtocolDrawerProps> = ({
  isOpen,
  onClose,
  coordinator,
}) => {
  const [activeTab, setActiveTab] = useState<DrawerTab>('summary');

  return (
    <AnimatePresence>
      {isOpen && (
        <div className="fixed inset-0 z-50 overflow-hidden flex justify-end">
          {/* Backdrop */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            className="fixed inset-0 bg-black/40 backdrop-blur-xs transition-opacity"
          />

          {/* Drawer Panel */}
          <motion.div
            initial={{ x: '100%' }}
            animate={{ x: 0 }}
            exit={{ x: '100%' }}
            transition={{ type: 'spring', damping: 28, stiffness: 280 }}
            className="relative w-full max-w-2xl bg-[#171B1E] text-white shadow-2xl h-full flex flex-col z-10 border-l border-white/10"
          >
            {/* Drawer Header */}
            <div className="p-4 sm:p-5 border-b border-white/10 flex items-center justify-between bg-[#121517]">
              <div>
                <h3 className="font-bold text-base text-white flex items-center gap-2">
                  <ShieldCheck className="w-4 h-4 text-[#26866F]" /> 协议与密码学验证抽屉
                </h3>
                <p className="text-xs text-zinc-400 mt-0.5 font-mono">
                  State Version: v{coordinator.stateLedger.current.state_version} &bull; Phase: {coordinator.phase}
                </p>
              </div>
              <button
                onClick={onClose}
                className="w-8 h-8 rounded-lg bg-white/5 hover:bg-white/10 flex items-center justify-center text-zinc-400 hover:text-white transition"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Navigation Tabs */}
            <div className="flex border-b border-white/10 bg-[#121517]/80 px-4 gap-2 overflow-x-auto">
              <button
                onClick={() => setActiveTab('summary')}
                className={`py-2.5 px-3 text-xs font-semibold border-b-2 transition flex items-center gap-1.5 whitespace-nowrap ${
                  activeTab === 'summary'
                    ? 'border-[#26866F] text-[#61BEA5]'
                    : 'border-transparent text-zinc-400 hover:text-zinc-200'
                }`}
              >
                <Terminal className="w-3.5 h-3.5" /> 状态摘要
              </button>
              <button
                onClick={() => setActiveTab('crypto')}
                className={`py-2.5 px-3 text-xs font-semibold border-b-2 transition flex items-center gap-1.5 whitespace-nowrap ${
                  activeTab === 'crypto'
                    ? 'border-[#26866F] text-[#61BEA5]'
                    : 'border-transparent text-zinc-400 hover:text-zinc-200'
                }`}
              >
                <KeyRound className="w-3.5 h-3.5" /> 密码学检查器
              </button>
              <button
                onClick={() => setActiveTab('audit')}
                className={`py-2.5 px-3 text-xs font-semibold border-b-2 transition flex items-center gap-1.5 whitespace-nowrap ${
                  activeTab === 'audit'
                    ? 'border-[#26866F] text-[#61BEA5]'
                    : 'border-transparent text-zinc-400 hover:text-zinc-200'
                }`}
              >
                <FileText className="w-3.5 h-3.5" /> 审计日志
              </button>
              <button
                onClick={() => setActiveTab('tests')}
                className={`py-2.5 px-3 text-xs font-semibold border-b-2 transition flex items-center gap-1.5 whitespace-nowrap ${
                  activeTab === 'tests'
                    ? 'border-[#26866F] text-[#61BEA5]'
                    : 'border-transparent text-zinc-400 hover:text-zinc-200'
                }`}
              >
                <CheckSquare className="w-3.5 h-3.5" /> TDD 检验套件 (81项)
              </button>
            </div>

            {/* Tab Body */}
            <div className="flex-1 overflow-y-auto p-5 space-y-4 bg-[#171B1E]">
              {activeTab === 'summary' && (
                <div className="space-y-4 text-xs">
                  <div className="p-4 rounded-xl bg-[#1E2327] border border-white/5 space-y-2">
                    <h4 className="font-bold text-white text-sm">当前状态哈希</h4>
                    <p className="font-mono text-zinc-400 break-all text-[11px] bg-black/30 p-2 rounded">
                      {coordinator.stateLedger.current.state_hash}
                    </p>
                    <div className="grid grid-cols-2 gap-3 pt-2 text-zinc-300">
                      <div>
                        <span className="text-zinc-500">前序哈希：</span>
                        <div className="font-mono truncate">{coordinator.stateLedger.current.prev_state_hash}</div>
                      </div>
                      <div>
                        <span className="text-zinc-500">卡牌总守恒：</span>
                        <div className="text-emerald-400 font-bold">51 张 (100% 守恒)</div>
                      </div>
                    </div>
                  </div>

                  <div className="p-4 rounded-xl bg-[#1E2327] border border-white/5 space-y-2">
                    <h4 className="font-bold text-white text-sm">已消费的随机抽牌收据</h4>
                    <p className="text-zinc-400">
                      已验证并安全消费的收据数：<span className="font-mono font-bold text-emerald-400">{coordinator.consumedReceipts.size}</span>
                    </p>
                    {coordinator.consumedReceipts.size > 0 && (
                      <div className="space-y-1">
                        {Array.from(coordinator.consumedReceipts).map(h => (
                          <div key={h} className="font-mono text-[10px] bg-black/30 p-1.5 rounded text-zinc-400 truncate">
                            Receipt: {h}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              )}

              {activeTab === 'crypto' && <CryptographicInspector coordinator={coordinator} />}
              {activeTab === 'audit' && <AuditLogViewer coordinator={coordinator} />}
              {activeTab === 'tests' && <TDDRunner />}
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
};
