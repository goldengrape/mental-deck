import React from 'react';
import type { CommittedGameState } from '../../types/contracts';

export interface BridgeUiAdapterProps {
  state: CommittedGameState;
  viewerPlayerId: string;
}

/** Minimal package-local adapter for controller/bidding spike verification. */
export function BridgeUiAdapter({ state, viewerPlayerId }: BridgeUiAdapterProps) {
  const handCount = state.zone_states[`hand:${viewerPlayerId}`]?.card_refs.length ?? 0;
  const trickCount = state.zone_states.current_trick?.card_refs.length ?? 0;
  const delegated = Object.values(state.controller_grants ?? {}).filter(
    grant => grant.status === 'ACTIVE' && grant.controller_player_id === viewerPlayerId
  );
  return (
    <section className="rounded-2xl border border-zinc-200 bg-white p-5 text-sm text-zinc-700">
      <h2 className="font-semibold text-zinc-900">Contract Bridge · Physical Deck v0.10</h2>
      <p className="mt-2">Your hand: {handCount} · Current trick: {trickCount} · Delegated zones: {delegated.length}</p>
      <p className="mt-2 text-xs text-zinc-500">Follow-suit is a local Rule Advisor check; ownership/control remains Core-enforced.</p>
    </section>
  );
}

export default BridgeUiAdapter;
