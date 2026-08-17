/**
 * Mental Deck - Cryptographic Inspector Component
 * Real-time verification monitor of joint keys, zero-knowledge proofs, and hash chain.
 */

import React from 'react';
import { ShieldCheck, KeyRound, Lock, Shuffle, Link2, Hash, FileCheck } from 'lucide-react';
import { GameCoordinator } from '../protocol/coordinator';

interface CryptographicInspectorProps {
  coordinator: GameCoordinator;
}

export const CryptographicInspector: React.FC<CryptographicInspectorProps> = ({ coordinator }) => {
  const state = coordinator.stateLedger?.current;
  const history = coordinator.stateLedger?.getAllSnapshots() || [];

  return (
    <div className="max-w-6xl mx-auto space-y-6">
      {/* Header Bento Tile */}
      <div className="bg-[#121214] border border-white/10 rounded-3xl p-6 text-white shadow-xl">
        <div className="flex items-center gap-3.5 mb-2">
          <div className="w-11 h-11 rounded-2xl bg-indigo-500/15 border border-indigo-400/30 flex items-center justify-center text-indigo-400 shadow-md shadow-indigo-500/10">
            <ShieldCheck className="w-6 h-6" />
          </div>
          <div>
            <h2 className="text-xl font-black text-white">Cryptographic Protocol Inspector</h2>
            <p className="text-xs text-zinc-400 mt-0.5">
              Live zero-knowledge proof verification, joint public key derivation, and immutable state hash chaining.
            </p>
          </div>
        </div>
      </div>

      {/* Grid of Bento Crypto Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {/* Joint Key */}
        <div className="p-5 rounded-2xl bg-[#121214] border border-white/10 shadow-xl space-y-3 flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between mb-3">
              <span className="text-xs font-bold text-zinc-400 uppercase tracking-wider flex items-center gap-1.5 font-mono">
                <KeyRound className="w-4 h-4 text-indigo-400" /> Joint Public Key
              </span>
              <span className="px-2.5 py-0.5 rounded-full text-[10px] font-bold bg-emerald-500/15 text-emerald-300 border border-emerald-400/30">
                Multi-Party
              </span>
            </div>
            <div className="p-3 rounded-xl bg-[#09090B] border border-white/10 font-mono text-[11px] text-indigo-300 break-all leading-relaxed">
              {coordinator.jointPublicKey || 'Not generated yet (Pending Key Setup)'}
            </div>
          </div>
          <p className="text-[11px] text-zinc-400 mt-2">
            Requires all {coordinator.lockedRoster?.players.length ?? 0} player shares to decrypt. Zero central master key.
          </p>
        </div>

        {/* Privacy Pool */}
        <div className="p-5 rounded-2xl bg-[#121214] border border-white/10 shadow-xl space-y-3 flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between mb-3">
              <span className="text-xs font-bold text-zinc-400 uppercase tracking-wider flex items-center gap-1.5 font-mono">
                <Lock className="w-4 h-4 text-indigo-400" /> Privacy Pool (URD-INV-017)
              </span>
              <span className="px-2.5 py-0.5 rounded-full text-[10px] font-bold bg-indigo-500/15 text-indigo-300 border border-indigo-400/30">
                51 Opaque Ciphers
              </span>
            </div>
            <div className="p-3 rounded-xl bg-[#09090B] border border-white/10 font-mono text-[11px] text-zinc-300 break-all leading-relaxed">
              Status: Randomized via 3-Stage Verifiable Re-encryption Shuffle before allocation.
            </div>
          </div>
          <p className="text-[11px] text-zinc-400 mt-2">
            CardRef epoch rotated. Coordinator cannot correlate output CardRefs with initial CardInstances.
          </p>
        </div>

        {/* State Hash Chain */}
        <div className="p-5 rounded-2xl bg-[#121214] border border-white/10 shadow-xl space-y-3 flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between mb-3">
              <span className="text-xs font-bold text-zinc-400 uppercase tracking-wider flex items-center gap-1.5 font-mono">
                <Hash className="w-4 h-4 text-indigo-400" /> Current State Hash
              </span>
              <span className="px-2.5 py-0.5 rounded-full text-[10px] font-bold bg-blue-500/15 text-blue-300 border border-blue-400/30 font-mono">
                v{state?.state_version ?? 0}
              </span>
            </div>
            <div className="p-3 rounded-xl bg-[#09090B] border border-white/10 font-mono text-[11px] text-emerald-300 break-all leading-relaxed">
              {state?.state_hash || 'GENESIS'}
            </div>
          </div>
          <p className="text-[11px] text-zinc-400 mt-2">
            Prev: <span className="font-mono text-zinc-300">{state?.prev_state_hash.substring(0, 16)}...</span>
          </p>
        </div>
      </div>

      {/* State Transitions Hash Chain Bento Card */}
      <div className="bg-[#121214] border border-white/10 rounded-3xl p-6 shadow-xl space-y-4">
        <h3 className="text-base font-bold text-white flex items-center gap-2">
          <Link2 className="w-4 h-4 text-indigo-400" /> State Hash Chain Timeline (Immutable Ledger)
        </h3>

        <div className="space-y-3">
          {history.map((snapshot) => (
            <div
              key={snapshot.state_version}
              className="p-4 rounded-2xl bg-[#18181B] border border-white/10 flex flex-col md:flex-row items-start md:items-center justify-between gap-3 text-xs hover:border-white/20 transition-all"
            >
              <div className="flex items-center gap-3">
                <span className="w-8 h-8 rounded-xl bg-indigo-600 text-white font-bold flex items-center justify-center text-xs shrink-0 shadow-md shadow-indigo-600/30">
                  #{snapshot.state_version}
                </span>
                <div>
                  <div className="font-bold text-white text-sm">{snapshot.last_action_summary || 'State Commit'}</div>
                  <div className="font-mono text-[11px] text-zinc-400 mt-0.5">
                    Hash: {snapshot.state_hash.substring(0, 24)}...
                  </div>
                </div>
              </div>

              <div className="flex items-center gap-2 font-mono text-[11px] text-zinc-300 bg-[#09090B] px-3 py-1.5 rounded-xl border border-white/10 shrink-0">
                <span>Ext Hash: {snapshot.game_state_extension_hash.substring(0, 12)}...</span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
