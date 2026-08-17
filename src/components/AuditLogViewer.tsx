/**
 * Mental Deck - Minimal-Disclosure Audit Log Explorer (MDD-MOD-029, URD-SEC-014, URD-ACC-010)
 *
 * Inspects append-only hash-linked transcript records and provides 1-click deterministic replay verification.
 */

import React, { useState } from 'react';
import { FileText, ShieldCheck, CheckCircle2, AlertTriangle, Download, RefreshCw, Lock } from 'lucide-react';
import { GameCoordinator } from '../protocol/coordinator';
import { TranscriptRecorder } from '../protocol/transcriptRecorder';
import { AuditVerifierBundle } from '../types/contracts';

interface AuditLogViewerProps {
  coordinator: GameCoordinator;
}

export const AuditLogViewer: React.FC<AuditLogViewerProps> = ({ coordinator }) => {
  const [verificationResult, setVerificationResult] = useState<{
    tested: boolean;
    isValid: boolean;
    errors: string[];
    recordsCount: number;
  } | null>(null);
  const [isVerifying, setIsVerifying] = useState(false);

  const records = coordinator.transcriptRecorder?.getRecords() || [];

  const handleVerifyTranscript = async () => {
    setIsVerifying(true);
    try {
      const bundle = coordinator.exportAuditBundle();
      const res = await TranscriptRecorder.verifyAuditBundle(bundle);
      setVerificationResult({
        tested: true,
        isValid: res.isValid,
        errors: res.errors,
        recordsCount: res.replayedRecordsCount,
      });
    } catch (err: any) {
      setVerificationResult({
        tested: true,
        isValid: false,
        errors: [err.message || 'Verification exception'],
        recordsCount: records.length,
      });
    } finally {
      setIsVerifying(false);
    }
  };

  const handleExportJson = () => {
    try {
      const bundle = coordinator.exportAuditBundle();
      const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `audit_transcript_${coordinator.gameId}.json`;
      a.click();
    } catch (err: any) {
      alert(`Export failed: ${err.message}`);
    }
  };

  return (
    <div className="max-w-6xl mx-auto space-y-6">
      {/* Header Bento Tile */}
      <div className="bg-[#121214] border border-white/10 rounded-3xl p-6 text-white shadow-xl flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 mb-2.5">
            <span className="bg-emerald-500/15 text-emerald-300 text-xs font-semibold px-3 py-1 rounded-full border border-emerald-400/30 flex items-center gap-1.5">
              <Lock className="w-3.5 h-3.5 text-emerald-400" /> URD-SEC-014 Compliant Minimal Disclosure
            </span>
          </div>
          <h2 className="text-xl font-black text-white flex items-center gap-2">
            <FileText className="w-5 h-5 text-indigo-400" /> Audit Transcript &amp; Replay Verifier
          </h2>
          <p className="text-xs text-zinc-400 mt-1 max-w-xl leading-relaxed">
            Append-only hash-linked record of all room ceremonies, shuffle proofs, and atomic transitions.
            Contains zero private plaintext mappings or unrevealed card associations.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          <button
            onClick={handleVerifyTranscript}
            disabled={isVerifying || records.length === 0}
            className="px-4 py-2.5 rounded-2xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-30 disabled:cursor-not-allowed text-white font-bold text-xs shadow-lg shadow-indigo-600/25 transition flex items-center gap-1.5"
          >
            <ShieldCheck className="w-4 h-4" /> 1-Click Replay Verification
          </button>

          <button
            onClick={handleExportJson}
            disabled={records.length === 0}
            className="px-3.5 py-2.5 rounded-2xl bg-[#18181B] hover:bg-white/10 disabled:opacity-30 disabled:cursor-not-allowed text-zinc-300 font-bold text-xs border border-white/10 transition flex items-center gap-1.5"
          >
            <Download className="w-4 h-4" /> Export JSON
          </button>
        </div>
      </div>

      {/* Verification Result Banner */}
      {verificationResult && (
        <div
          className={`p-5 rounded-3xl border flex items-start gap-3.5 shadow-xl ${
            verificationResult.isValid
              ? 'bg-emerald-950/30 border-emerald-500/40 text-emerald-200'
              : 'bg-rose-950/30 border-rose-500/40 text-rose-200'
          }`}
        >
          {verificationResult.isValid ? (
            <CheckCircle2 className="w-6 h-6 text-emerald-400 shrink-0 mt-0.5" />
          ) : (
            <AlertTriangle className="w-6 h-6 text-rose-400 shrink-0 mt-0.5" />
          )}
          <div>
            <h4 className="font-bold text-sm text-white">
              {verificationResult.isValid
                ? `Transcript Replay Verified (100% Passed Across ${verificationResult.recordsCount} Records)`
                : 'Transcript Verification Failed'}
            </h4>
            <p className="text-xs mt-1 text-zinc-300 leading-relaxed">
              {verificationResult.isValid
                ? 'All SHA-256 hash chains, definition manifests, roster identities, and deterministic outcomes replayed with 100% cryptographic integrity.'
                : verificationResult.errors.join('; ')}
            </p>
          </div>
        </div>
      )}

      {/* Records Bento Ledger Table */}
      <div className="bg-[#121214] border border-white/10 rounded-3xl overflow-hidden shadow-xl">
        <div className="p-4 sm:p-5 border-b border-white/10 flex items-center justify-between">
          <span className="text-xs font-bold text-zinc-400 uppercase tracking-wider font-mono">
            Transcript Records ({records.length} total)
          </span>
          <span className="text-xs text-zinc-500 font-mono">Hash-linked cryptographic audit ledger</span>
        </div>

        <div className="divide-y divide-white/5 max-h-[520px] overflow-y-auto">
          {records.map((rec) => (
            <div key={rec.record_id} className="p-4 sm:p-5 hover:bg-white/[0.02] transition text-xs space-y-2">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2.5">
                  <span className="w-7 h-7 rounded-xl bg-indigo-500/20 text-indigo-300 border border-indigo-400/30 font-bold flex items-center justify-center text-[10px] font-mono">
                    {rec.sequence_number}
                  </span>
                  <span className="font-bold text-white text-sm">{rec.record_type}</span>
                </div>
                <span className="text-[11px] text-zinc-400 font-mono">{new Date(rec.timestamp).toLocaleTimeString()}</span>
              </div>

              <div className="flex flex-wrap items-center gap-4 font-mono text-[11px] text-zinc-400 pl-9">
                <span>Record Hash: <span className="text-indigo-400 font-bold">{rec.record_hash.substring(0, 16)}...</span></span>
                <span>Prev: <span className="text-zinc-500">{rec.prev_record_hash.substring(0, 12)}...</span></span>
              </div>

              <div className="pl-9 pt-1">
                <pre className="p-3 rounded-xl bg-[#09090B] border border-white/10 text-zinc-300 font-mono text-[10px] overflow-x-auto leading-relaxed">
                  {JSON.stringify(rec.payload, null, 2)}
                </pre>
              </div>
            </div>
          ))}

          {records.length === 0 && (
            <div className="p-10 text-center text-zinc-500 text-xs italic">
              No transcript records generated yet. Complete the room ceremony to populate the audit ledger.
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
