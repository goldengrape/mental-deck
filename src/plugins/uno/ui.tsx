import React from 'react';
import type { CommittedGameState } from '../../types/contracts';

export interface UnoUiAdapterProps {
  state: CommittedGameState;
  viewerPlayerId: string;
}

/** Minimal package-local adapter; full gameplay UX remains a follow-up. */
export function UnoUiAdapter({ state, viewerPlayerId }: UnoUiAdapterProps) {
  const handCount = state.zone_states[`hand:${viewerPlayerId}`]?.card_refs.length ?? 0;
  const drawCount = state.zone_states.draw_pile?.card_refs.length ?? 0;
  const discardCount = state.zone_states.discard_pile?.card_refs.length ?? 0;
  return (
    <section className="rounded-2xl border border-zinc-200 bg-white p-5 text-sm text-zinc-700">
      <h2 className="font-semibold text-zinc-900">UNO · Physical Deck v0.10</h2>
      <p className="mt-2">Your hand: {handCount} · Draw pile: {drawCount} · Discard pile: {discardCount}</p>
      <p className="mt-2 text-xs text-zinc-500">Color/value legality is advisory; Core protects real-card control and draw integrity.</p>
    </section>
  );
}

export default UnoUiAdapter;
