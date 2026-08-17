/**
 * Mental Deck - Protocol Inspector.
 *
 * The current executable crypto path is simulation-only. This panel intentionally
 * avoids claiming zero-knowledge security or server blindness that the demo harness
 * does not yet provide.
 */

import React from 'react';
import { AlertTriangle, Hash, KeyRound, Link2, ShieldCheck } from 'lucide-react';
import { GameCoordinator } from '../protocol/coordinator';
import { CRYPTO_SECURITY_STATUS } from '../crypto/cryptoProvider';

interface CryptographicInspectorProps {
  coordinator: GameCoordinator;
}

export const CryptographicInspector: React.FC<CryptographicInspectorProps> = ({ coordinator }) => {
  const state = coordinator.stateLedger?.current;
  const history = coordinator.stateLedger?.getAllSnapshots() || [];

  return (
    <div className="max-w-6xl mx-auto space-y-5">
      <div className="rounded-3xl border border-amber-400/30 bg-amber-950/40 p-6 text-amber-50">
        <div className="flex items-start gap-3">
          <AlertTriangle className="w-6 h-6 text-amber-300 shrink-0 mt-0.5" />
          <div>
            <div className="font-mono text-xs text-amber-300 mb-1">{CRYPTO_SECURITY_STATUS}</div>
            <h2 className="text-lg font-bold">Protocol simulation inspector</h2>
            <p className="text-xs text-amber-100/75 mt-1 leading-relaxed max-w-3xl">
              These values are useful for checking state-machine wiring, context binding and replay behavior. The current provider is not a real ElGamal / verifiable-shuffle / DLEQ implementation and must not be interpreted as proof of production cryptographic security.
            </p>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="p-5 rounded-2xl bg-[#121214] border border-white/10 text-white space-y-3">
          <div className="text-xs font-bold text-zinc-400 uppercase tracking-wider flex items-center gap-1.5 font-mono">
            <KeyRound className="w-4 h-4" /> Simulated joint key
          </div>
          <div className="p-3 rounded-xl bg-[#09090B] border border-white/10 font-mono text-[11px] text-zinc-300 break-all">
            {coordinator.jointPublicKey || 'Not generated'}
          </div>
          <p className="text-[11px] text-zinc-500">Structure only; real multi-party key algebra remains behind RMD-TASK-004.</p>
        </div>

        <div className="p-5 rounded-2xl bg-[#121214] border border-white/10 text-white space-y-3">
          <div className="text-xs font-bold text-zinc-400 uppercase tracking-wider flex items-center gap-1.5 font-mono">
            <ShieldCheck className="w-4 h-4" /> Security mode
          </div>
          <div className="p-3 rounded-xl bg-[#09090B] border border-white/10 font-mono text-[11px] text-amber-300">
            {coordinator.securityMode}
          </div>
          <p className="text-[11px] text-zinc-500">Production rendering is blocked while this mode is active.</p>
        </div>

        <div className="p-5 rounded-2xl bg-[#121214] border border-white/10 text-white space-y-3">
          <div className="text-xs font-bold text-zinc-400 uppercase tracking-wider flex items-center gap-1.5 font-mono">
            <Hash className="w-4 h-4" /> Current state
          </div>
          <div className="p-3 rounded-xl bg-[#09090B] border border-white/10 font-mono text-[11px] text-emerald-300 break-all">
            {state?.state_hash || 'GENESIS'}
          </div>
          <p className="text-[11px] text-zinc-500">State version: {state?.state_version ?? 0}</p>
        </div>
      </div>

      <div className="bg-[#121214] border border-white/10 rounded-3xl p-6 text-white space-y-4">
        <h3 className="text-sm font-bold flex items-center gap-2">
          <Link2 className="w-4 h-4" /> Committed state hash chain
        </h3>
        <div className="space-y-2">
          {history.map(snapshot => (
            <div key={snapshot.state_version} className="rounded-xl border border-white/10 bg-[#18181B] p-3 text-xs">
              <div className="font-semibold">#{snapshot.state_version} {snapshot.last_action_summary || 'State commit'}</div>
              <div className="font-mono text-[10px] text-zinc-500 mt-1 break-all">{snapshot.state_hash}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
