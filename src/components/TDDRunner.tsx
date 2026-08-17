/**
 * Mental Deck - Legacy executable TDD subset runner.
 *
 * This UI runs the currently implemented browser smoke/security subset. It is NOT
 * evidence that every documented TDD-TEST-001..081 case exists or passed. CI's
 * `test:security` suite is the hardening gate for the concrete security regressions.
 */

import React, { useState } from 'react';
import { AlertTriangle, CheckCircle2, Filter, Play, RefreshCw, XCircle } from 'lucide-react';
import { TestResult, TddTestSuite } from '../tests/tddTestSuite';

export const TDDRunner: React.FC = () => {
  const [results, setResults] = useState<TestResult[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const [progress, setProgress] = useState({ current: 0, total: 0 });
  const [filterCategory, setFilterCategory] = useState('All');

  const handleRunAllTests = async () => {
    setIsRunning(true);
    setResults([]);
    setProgress({ current: 0, total: 0 });
    await TddTestSuite.runAllTests((completed, total, latest) => {
      setProgress({ current: completed, total });
      setResults(prev => [...prev, latest]);
    });
    setIsRunning(false);
  };

  const categories = ['All', 'Acceptance', 'Contract', 'Security', 'Regression', 'Property'];
  const filteredResults = filterCategory === 'All' ? results : results.filter(r => r.category === filterCategory);
  const passedCount = results.filter(r => r.passed).length;
  const failedCount = results.length - passedCount;

  return (
    <div className="max-w-6xl mx-auto space-y-5">
      <div className="rounded-3xl border border-amber-400/30 bg-amber-950/40 p-5 text-amber-50 flex gap-3">
        <AlertTriangle className="w-5 h-5 text-amber-300 shrink-0 mt-0.5" />
        <div>
          <div className="text-xs font-mono font-bold text-amber-300">EXECUTABLE SUBSET · NOT FULL TDD COVERAGE</div>
          <p className="text-xs text-amber-100/80 mt-1 leading-relaxed">
            This panel runs the subset currently registered in <code>TddTestSuite.runAllTests()</code>. Some historical TDD IDs remain unimplemented or contain prototype assertions. Use CI <code>bun run test:security</code> for the current security hardening gate.
          </p>
        </div>
      </div>

      <div className="bg-[#121214] border border-white/10 rounded-3xl p-6 text-white shadow-xl flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-black">Prototype TDD smoke runner</h2>
          <p className="text-xs text-zinc-400 mt-1">Useful for interactive protocol checks; not a formal proof or complete v0.9 acceptance suite.</p>
        </div>
        <button
          id="btn-run-all-tests"
          onClick={handleRunAllTests}
          disabled={isRunning}
          className="px-5 py-3 rounded-2xl bg-emerald-500 hover:bg-emerald-400 disabled:opacity-50 text-slate-950 font-black text-xs transition flex items-center gap-2"
        >
          {isRunning ? <><RefreshCw className="w-4 h-4 animate-spin" /> Running ({progress.current}/{progress.total || '?'})</> : <><Play className="w-4 h-4" /> Run implemented subset</>}
        </button>
      </div>

      {results.length > 0 && (
        <div className="p-5 bg-[#121214] border border-white/10 rounded-3xl text-white space-y-3">
          <div className="flex flex-wrap items-center gap-4 text-xs font-bold">
            <span className="font-mono">Executed: {results.length}</span>
            <span className="text-emerald-400 flex items-center gap-1"><CheckCircle2 className="w-4 h-4" /> Passed: {passedCount}</span>
            <span className={failedCount ? 'text-rose-400 flex items-center gap-1' : 'text-zinc-500 flex items-center gap-1'}><XCircle className="w-4 h-4" /> Failed: {failedCount}</span>
          </div>
          <div className="w-full bg-[#18181B] rounded-full h-2 overflow-hidden">
            <div className={failedCount === 0 ? 'h-full bg-emerald-500' : 'h-full bg-amber-500'} style={{ width: `${progress.total ? (results.length / progress.total) * 100 : 0}%` }} />
          </div>
        </div>
      )}

      <div className="flex items-center gap-2 overflow-x-auto pb-1">
        <Filter className="w-4 h-4 text-zinc-500 shrink-0" />
        {categories.map(cat => (
          <button
            key={cat}
            onClick={() => setFilterCategory(cat)}
            className={`px-3.5 py-1.5 rounded-2xl text-xs font-bold border shrink-0 ${filterCategory === cat ? 'bg-indigo-600 text-white border-indigo-500' : 'bg-[#18181B] text-zinc-400 border-white/10'}`}
          >
            {cat}
          </button>
        ))}
      </div>

      <div className="bg-[#121214] border border-white/10 rounded-3xl overflow-hidden shadow-xl text-white">
        <div className="divide-y divide-white/5">
          {filteredResults.map(res => (
            <div key={res.id} className="p-4 sm:p-5 text-xs space-y-2">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2.5 min-w-0">
                  {res.passed ? <CheckCircle2 className="w-5 h-5 text-emerald-400 shrink-0" /> : <XCircle className="w-5 h-5 text-rose-400 shrink-0" />}
                  <span className="font-mono font-bold text-indigo-400">{res.id}</span>
                  <span className="font-bold truncate">{res.name}</span>
                </div>
                <span className="text-[10px] font-mono text-zinc-500 shrink-0">{res.durationMs}ms</span>
              </div>
              <div className="pl-7 text-[11px] text-zinc-300">{res.details}</div>
              <div className="pl-7 text-[10px] text-zinc-500 font-mono">Oracle: {res.oracle}</div>
            </div>
          ))}
          {filteredResults.length === 0 && !isRunning && (
            <div className="p-10 text-center text-zinc-500 text-xs">Run the implemented subset to inspect results.</div>
          )}
        </div>
      </div>
    </div>
  );
};
