import '../protocol/coordinator';

/**
 * Transitional compile-time overload for legacy demo/tests that still call the old
 * two-argument confirmation API. Runtime coordinator remains fail-closed and rejects
 * a missing signature. Delete this file once all call sites are migrated.
 */
declare module '../protocol/coordinator' {
  interface GameCoordinator {
    submitInitialStateConfirmation(
      playerId: string,
      stateHash: string,
      signature?: string
    ): Promise<boolean>;
  }
}
