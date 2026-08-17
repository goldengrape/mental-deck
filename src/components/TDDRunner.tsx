/**
 * Mental Deck - Interactive TDD Test Suite Runner
 * Live execution and verification of all formal checks (TDD-TEST-001 to TDD-TEST-080).
 */

import React, { useState } from 'react';
import { Play, CheckCircle2, XCircle, ShieldCheck, Filter, RefreshCw } from 'lucide-react';
import { TestResult, TddTestSuite } from '../tests/tddTestSuite';

export const TDDRunner: React.FC = () => {
  const [results, setResults] = useState<TestResult[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const [progress, setProgress] = useState<{ current: number; total: number }>({ current: 0, total: 0 });
  const [filterCategory, setFilterCategory] = useState<string>('All');

  const handleRunAllTests = async () => {
    setIsRunning(true);
    setResults([]);
    setProgress({ current: 0, total: 24 });

    const executed = await TddTestSuite.runAllTests((completed, total, latest) => {
      setProgress({ current: completed, total });
      setResults(prev => [...prev, latest]);
    });

    setIsRunning(false);
  };

  const categories = ['All', 'Acceptance', 'Contract', 'Security', 'Regression', 'Property'];
  const filteredResults = filterCategory === 'All'
    ? results
    : results.filter(r => r.category === filterCategory);

  const passedCount = results.filter(r => r.passed).length;
  const failedCount = results.filter(r => !r.passed).length;

  return (
    <div className="max-w-6xl mx-auto space-y-6">
      {/* Header Bento Tile */}
      <div className="bg-[#121214] border border-white/10 rounded-3xl p-6 text-white shadow-xl flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 mb-2.5">
            <span className="bg-purple-500/15 text-purple-300 text-xs font-semibold px-3 py-1 rounded-full border border-purple-400/30 flex items-center gap-1.5">
              <ShieldCheck className="w-3.5 h-3.5 text-purple-400" /> TDD v0.8 Specification Check Plan
            </span>
          </div>
          <h2 className="text-xl font-black text-white flex items-center gap-2">
            Executable TDD Test Suite Runner
          </h2>
          <p className="text-xs text-zinc-400 mt-1 max-w-xl leading-relaxed">
            Executes all formal tests covering Acceptance (URD-ACC), Security (URD-SEC), Contracts (MDD-API),
            Invariants (P1-P16), and deterministic replay oracles.
          </p>
        </div>

        <button
          id="btn-run-all-tests"
          onClick={handleRunAllTests}
          disabled={isRunning}
          className="px-5 py-3.5 rounded-2xl bg-gradient-to-r from-emerald-500 to-emerald-600 hover:from-emerald-400 hover:to-emerald-500 disabled:opacity-50 text-slate-950 font-black text-xs shadow-xl shadow-emerald-500/20 transition flex items-center gap-2 shrink-0"
        >
          {isRunning ? (
            <>
              <RefreshCw className="w-4 h-4 animate-spin text-slate-950" /> Running Tests ({progress.current}/{progress.total})...
            </>
          ) : (
            <>
              <Play className="w-4 h-4 fill-slate-950" /> Execute All Formal Tests
            </>
          )}
        </button>
      </div>

      {/* Progress Bar & Summary Bento Tile */}
      {results.length > 0 && (
        <div className="p-5 bg-[#121214] border border-white/10 rounded-3xl shadow-xl space-y-3">
          <div className="flex items-center justify-between text-xs font-bold">
            <div className="flex flex-wrap items-center gap-4">
              <span className="text-white font-mono">Total Executed: {results.length}</span>
              <span className="text-emerald-400 flex items-center gap-1">
                <CheckCircle2 className="w-4 h-4" /> Passed: {passedCount}
              </span>
              {failedCount > 0 && (
                <span className="text-rose-400 flex items-center gap-1">
                  <XCircle className="w-4 h-4" /> Failed: {failedCount}
                </span>
              )}
            </div>
            <span className="text-zinc-400 font-mono">
              Pass Rate: {Math.round((passedCount / results.length) * 100)}%
            </span>
          </div>

          <div className="w-full bg-[#18181B] rounded-full h-2 overflow-hidden border border-white/5">
            <div
              className={`h-full transition-all duration-300 ${
                failedCount === 0 ? 'bg-emerald-500' : 'bg-amber-500'
              }`}
              style={{ width: `${(results.length / (progress.total || 24)) * 100}%` }}
            />
          </div>
        </div>
      )}

      {/* Filter Tabs */}
      <div className="flex items-center gap-2 overflow-x-auto pb-1">
        <Filter className="w-4 h-4 text-zinc-500 shrink-0" />
        {categories.map(cat => (
          <button
            key={cat}
            onClick={() => setFilterCategory(cat)}
            className={`px-3.5 py-1.5 rounded-2xl text-xs font-bold border transition-all shrink-0 ${
              filterCategory === cat
                ? 'bg-indigo-600 text-white border-indigo-500 shadow-md shadow-indigo-600/30'
                : 'bg-[#18181B] text-zinc-400 border-white/10 hover:text-white hover:bg-white/5'
            }`}
          >
            {cat}
          </button>
        ))}
      </div>

      {/* Test List Bento Card */}
      <div className="bg-[#121214] border border-white/10 rounded-3xl overflow-hidden shadow-xl">
        <div className="divide-y divide-white/5">
          {filteredResults.map(res => (
            <div key={res.id} className="p-4 sm:p-5 hover:bg-white/[0.02] transition text-xs space-y-2">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2.5">
                  {res.passed ? (
                    <CheckCircle2 className="w-5 h-5 text-emerald-400 shrink-0" />
                  ) : (
                    <XCircle className="w-5 h-5 text-rose-400 shrink-0" />
                  )}
                  <span className="font-mono font-bold text-indigo-400">{res.id}</span>
                  <span className="font-bold text-white text-sm">{res.name}</span>
                </div>

                <div className="flex items-center gap-2">
                  <span className="px-2.5 py-0.5 rounded-full text-[10px] font-bold bg-[#18181B] text-zinc-300 border border-white/10 font-mono">
                    {res.category}
                  </span>
                  <span className="text-[11px] font-mono text-zinc-500">{res.durationMs}ms</span>
                </div>
              </div>

              <div className="pl-7 text-[11px] text-zinc-300">
                <span className="font-semibold text-zinc-500">Details: </span>
                {res.details}
              </div>

              <div className="pl-7 text-[10px] text-zinc-400 font-mono">
                <span className="font-bold text-indigo-400">Oracle: </span>
                {res.oracle}
              </div>
            </div>
          ))}

          {filteredResults.length === 0 && !isRunning && (
            <div className="p-12 text-center text-zinc-500 text-xs">
              Click &ldquo;Execute All Formal Tests&rdquo; above to run the live test suite against the cryptographic state machine.
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
