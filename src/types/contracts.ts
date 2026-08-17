/**
 * Mental Deck - Core Data Contracts (MDD-DATA-001 to MDD-DATA-039)
 * Based on URD v0.9 / ADD v0.9 / MDD v0.9
 */

export type ArtifactKind = 'canonical_rules' | 'client_rules' | 'ui_adapter';

export interface PluginArtifactDescriptor {
  plugin_id: string;
  plugin_version: string;
  plugin_package_hash: string;
  artifact_kinds: ArtifactKind[];
  trust_status: 'product_shipped' | 'allowlisted' | 'untrusted';
  name: string;
  description: string;
}

export interface PublicGameConfig {
  max_players: number;
  min_players: number;
  custom_options?: Record<string, string | number | boolean>;
}

export interface PlayerIdentity {
  player_id: string;
  display_name: string;
  is_ai: boolean;
  signing_public_key: string;
  encryption_public_key: string;
  pok_proof?: string;
}

export interface LockedRoster {
  players: PlayerIdentity[];
  roster_hash: string;
  locked_at: number;
}

export interface CardInstance {
  card_instance_id: string;
  symbol: string;
  suit?: '♠' | '♥' | '♦' | '♣' | 'none';
  rank?: string;
  name: string;
  metadata?: Record<string, string | number | boolean>;
}

export interface DeckManifest {
  deck_id: string;
  version: string;
  cards: CardInstance[];
  deck_manifest_hash: string;
}

export type ZoneOrdering = 'ORDERED' | 'UNORDERED';
export type ZoneVisibility = 'PUBLIC' | 'OWNER_ONLY' | 'HIDDEN_TO_ALL' | 'SELECTIVE';

export interface ZoneDefinition {
  zone_id: string;
  name: string;
  owner_player_id?: string | null; // null for shared
  ordering: ZoneOrdering;
  default_visibility: ZoneVisibility;
}

export interface ZoneManifest {
  zones: ZoneDefinition[];
  zone_manifest_hash: string;
}

export interface AllocationStep {
  step_id: string;
  source_pool: 'privacy_pool';
  destination_zone_id: string;
  count: number;
  selector: 'TOP';
}

export interface InitializationPlan {
  steps: AllocationStep[];
  plan_hash: string;
}

export interface LockedGameDefinition {
  plugin_descriptor: PluginArtifactDescriptor;
  roster_hash: string;
  deck_manifest: DeckManifest;
  zone_manifest: ZoneManifest;
  initial_game_extension: Record<string, unknown>;
  initialization_plan: InitializationPlan;
  game_definition_hash: string;
}

export interface ProtocolContext {
  protocol_id: string;
  protocol_version: string;
  game_id: string;
  roster_hash: string;
  definition_hash: string;
  phase: string;
  actor_id?: string;
  workflow_id?: string;
  action_id?: string;
  base_state_hash?: string;
  input_hash?: string;
}

export interface LocalKeyMaterial {
  game_id: string;
  player_id: string;
  signing_private_key: string;
  signing_public_key: string;
  encryption_private_key: string;
  encryption_public_key: string;
  pok_proof: string;
  created_at: number;
}

export interface CardRef {
  ref_id: string;
  epoch: number;
}

export interface CipherCard {
  card_ref: CardRef;
  ciphertext: string; // Serialized encrypted object
  commitment: string;
}

export interface ZoneState {
  zone_id: string;
  card_refs: CardRef[];
  commitment_hash: string;
}

export interface CardGroup {
  group_id: string;
  zone_id: string;
  member_refs: CardRef[];
  label?: string;
  metadata?: Record<string, unknown>;
}

export interface PublicCardBinding {
  card_ref: CardRef;
  card_instance_id: string;
  card_instance: CardInstance;
  reveal_evidence_hash: string;
  disclosed_at_state: number;
}

export interface DisclosureGrant {
  grant_id: string;
  card_refs: CardRef[];
  visibility: 'PUBLIC' | 'SELECTIVE';
  authorized_viewers: string[]; // player_ids or ['PUBLIC']
  workflow_id: string;
  stage_id: string;
  parent_state_hash: string;
  status: 'PENDING_SHARES' | 'COMMITTED_AND_DELIVERED';
}

export interface CommittedGameState {
  state_version: number;
  state_hash: string;
  prev_state_hash: string;
  zone_states: Record<string, ZoneState>;
  groups: Record<string, CardGroup>;
  public_bindings: Record<string, PublicCardBinding>; // card_ref.ref_id -> binding
  grants: Record<string, DisclosureGrant>;
  game_state_extension: Record<string, unknown>;
  game_state_extension_hash: string;
  last_action_summary?: string;
  active_workflow_id?: string | null;
}

export interface SignedSemanticIntent {
  intent_id: string;
  actor_id: string;
  plugin_id: string;
  action_type: string;
  parameters: Record<string, unknown>;
  base_state_hash: string;
  base_state_version: number;
  signature: string;
  timestamp: number;
}

export type RuleDecisionType = 'ALLOWED' | 'REJECTED' | 'DISCLOSURE_REQUIRED';

export interface RuleDecision {
  decision: RuleDecisionType;
  canonical_code: string;
  reason?: string;
  allowed_operation_skeleton?: OperationPlan;
  continuation_required?: boolean;
  continuation_type?: string;
  output_hash: string;
}

export interface AuthorizedIntent {
  signed_intent: SignedSemanticIntent;
  rule_decision: RuleDecision;
  authorization_hash: string;
}

export type SelectionType = 'TOP' | 'BOTTOM' | 'BY_HANDLE' | 'ALL' | 'RANDOM';

export interface SelectionSpec {
  type: SelectionType;
  count?: number;
  card_refs?: CardRef[]; // Only valid for BY_HANDLE
}

export type ResolvedSelectionKind = 'TOP' | 'BOTTOM' | 'BY_HANDLE' | 'ALL' | 'VERIFIED_RANDOM';

export interface ResolvedSelection {
  selection_kind: ResolvedSelectionKind;
  selected_card_refs: CardRef[];
  source_zone_id: string;
  workflow_id?: string;
  parent_state_hash?: string;
  evidence_ref?: string; // e.g. receipt_hash for VERIFIED_RANDOM, or selection evidence hash
  // Backward compatibility alias for selected_card_refs
  selected_refs?: CardRef[];
  evidence_hash?: string;
}

export interface RandomSelectionContext {
  workflow_id: string;
  parent_state_hash: string;
  source_zone_id: string;
  source_ref_set_commitment: string;
  card_count: number;
  participant_ids: string[];
  round: number;
}

export interface RandomSelectionReceipt {
  context_hash: string;
  source_zone_id: string;
  source_ref_set_commitment: string;
  workflow_id: string;
  parent_state_hash: string;
  commitments: Record<string, string>; // player_id -> commitment
  revealed_nonces: Record<string, string>; // player_id -> nonce
  derived_seed: string;
  unbiased_index: number;
  selected_ref: CardRef;
  receipt_hash: string; // One-time consumption identity (MDD-DATA-028)
  evidence_hash?: string;
}

export interface DecryptShareSubmission {
  player_id: string;
  card_ref: CardRef;
  viewers: string[];
  workflow_id: string;
  stage_id: string;
  share: string;
  proof: string;
}

export type CoreOperationType =
  | 'MOVE'
  | 'REVEAL_PUBLIC'
  | 'REVEAL_TO'
  | 'PEEK'
  | 'GROUP'
  | 'UNGROUP'
  | 'SHUFFLE';

export interface BaseOperation {
  op_type: CoreOperationType;
}

export interface MoveOperation extends BaseOperation {
  op_type: 'MOVE';
  source_zone_id: string;
  destination_zone_id: string;
  selection?: SelectionSpec;
  resolved_selection?: ResolvedSelection;
  placement: 'TOP' | 'BOTTOM';
}

export interface RevealOperation extends BaseOperation {
  op_type: 'REVEAL_PUBLIC' | 'REVEAL_TO';
  card_refs: CardRef[];
  viewers: string[];
}

export interface PeekOperation extends BaseOperation {
  op_type: 'PEEK';
  source_zone_id: string;
  selection: SelectionSpec;
  viewers: string[];
}

export interface GroupOperation extends BaseOperation {
  op_type: 'GROUP';
  zone_id: string;
  group_id: string;
  card_refs: CardRef[];
  label?: string;
}

export interface UngroupOperation extends BaseOperation {
  op_type: 'UNGROUP';
  group_id: string;
}

export interface ShuffleOperation extends BaseOperation {
  op_type: 'SHUFFLE';
  zone_id: string;
}

export type CoreOperation =
  | MoveOperation
  | RevealOperation
  | PeekOperation
  | GroupOperation
  | UngroupOperation
  | ShuffleOperation;

export interface OperationPlan {
  operations: CoreOperation[];
  is_atomic: boolean;
  plan_hash: string;
}

export interface CoreEventCandidate {
  base_state_hash: string;
  simulated_zone_states: Record<string, ZoneState>;
  simulated_groups: Record<string, CardGroup>;
  simulated_public_bindings: Record<string, PublicCardBinding>;
  simulated_grants: Record<string, DisclosureGrant>;
  candidate_hash: string;
  events_summary: string[];
}

export interface GameTransitionPatch {
  next_game_state_extension: Record<string, unknown>;
  next_extension_hash: string;
  outcome_hint?: ProtocolOutcome | null;
}

export interface WorkflowContinuationAuthorization {
  workflow_id: string;
  origin_intent_hash: string;
  parent_state_hash: string;
  rule_decision_hash: string;
  continuation_type: string;
  target_refs: CardRef[];
  authorization_hash: string;
}

export interface SemanticWorkflowRecord {
  workflow_id: string;
  original_intent: SignedSemanticIntent;
  current_stage: string;
  parent_state_hash: string;
  receipts: Record<string, unknown>;
  continuation?: WorkflowContinuationAuthorization;
  is_complete: boolean;
}

export interface LocalKnowledgeRecord {
  card_ref_id: string;
  card_instance: CardInstance;
  learned_at_state_version: number;
  learned_at_workflow_id?: string;
  is_public: boolean;
  zone_at_reveal?: string;
}

export interface GameView {
  viewer_player_id: string | 'PUBLIC';
  game_id: string;
  state_version: number;
  state_hash: string;
  zones: Array<{
    zone_id: string;
    name: string;
    owner_player_id?: string | null;
    ordering: ZoneOrdering;
    visibility: ZoneVisibility;
    card_count: number;
    cards?: Array<{
      ref_id: string;
      card_instance?: CardInstance; // Only if locally known
      is_known: boolean;
    }>;
  }>;
  groups: CardGroup[];
  public_pairs: Array<{
    group_id: string;
    cards: CardInstance[];
  }>;
  game_state_extension: Record<string, unknown>;
  allowed_actions: Array<{
    action_type: string;
    label: string;
    parameters_schema?: Record<string, unknown>;
    is_legal: boolean;
    reason_if_illegal?: string;
  }>;
}

export type ProtocolOutcomeType =
  | 'NORMAL_VICTORY'
  | 'REJECTED'
  | 'CHEATING_DETECTED'
  | 'GAME_STALLED'
  | 'GAME_ABORTED';

export interface ProtocolOutcome {
  outcome_type: ProtocolOutcomeType;
  winner_player_ids?: string[];
  loser_player_id?: string | null;
  reason: string;
  final_state_hash: string;
  evidence_hashes: string[];
}

export interface TranscriptRecord {
  record_id: string;
  record_type: string;
  sequence_number: number;
  prev_record_hash: string;
  record_hash: string;
  timestamp: number;
  payload: Record<string, unknown>;
}

export interface AuditVerifierBundle {
  game_id: string;
  plugin_descriptor: PluginArtifactDescriptor;
  locked_roster: LockedRoster;
  locked_definition: LockedGameDefinition;
  initial_state_hash: string;
  transcript: TranscriptRecord[];
  final_state_hash: string;
  final_outcome: ProtocolOutcome;
}
