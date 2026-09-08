// ─── Core domain types ────────────────────────────────────────────────────────

export type PlayerRole = 'wk' | 'bat' | 'ar' | 'bowl';
export type MatchFormat = 'T20' | 'ODI' | 'TEST';
export type CaptaincyRole = 'captain' | 'vice_captain' | 'normal';

export interface Player {
  id: string;
  name: string;
  team: string;
  role: PlayerRole;
  credits: number;
  overseas: boolean;
  teamColor: string | null;   // hex color from admin teams table, e.g. '#fbbf24'
  teamColor2: string | null;  // secondary/sleeve hex color from admin teams table (teams.color2)
  teamJerseySvg?: string | null; // optional custom jersey SVG markup (teams.jersey_svg) — takes over from teamColor/teamColor2 when set
  photoUrl?: string | null; // players.photo_url (migration_v45) — background-removed, head-and-neck-cropped photo
}

export interface SelectedPlayer extends Player {
  captaincy: CaptaincyRole;
}

// ─── Scoring types ────────────────────────────────────────────────────────────

export interface BattingInnings {
  runs: number;
  ballsFaced: number;
  fours: number;
  sixes: number;
  isDismissed: boolean;
}

export interface BowlingSpell {
  wickets: number;
  wicketTypes: string[];
  maidens: number;
  runsConceded: number;
  ballsBowled: number;
  dotBalls: number;
  noBalls: number;
  wides: number;
  // Confirmed true only after an admin manually verifies a genuine hat-trick
  // (3 wickets in 3 consecutive deliveries) via the web Review tab — never
  // auto-detected, since none of our data sources reliably expose
  // ball-by-ball sequencing. See scoringEngine.shared.js's calcBowlingPoints.
  hattrick?: boolean;
}

export interface FieldingStats {
  catches: number;
  stumpings: number;
  runOutDirect: number;
  runOutIndirect: number;
}

export interface PlayerMatchPerf {
  id: string;
  name: string;
  role: PlayerRole;
  captaincy: CaptaincyRole;
  is_overseas?: boolean;   // true = overseas player; used by os_double / indian_double boosters
  batting?: BattingInnings;
  bowling?: BowlingSpell;
  fielding?: FieldingStats;
}

export interface ScoreBreakdown {
  batting?: Record<string, number>;
  bowling?: Record<string, number>;
  fielding?: Record<string, number>;
}

export interface PlayerScore {
  name: string;
  totalPoints: number;
  multiplier: number;
  rawPoints: number;
  breakdown: ScoreBreakdown;
}

// ─── Selection rules ──────────────────────────────────────────────────────────

export interface SelectionRules {
  total: number;
  budget: number;
  role: Record<PlayerRole, [number, number]>;
  maxPerTeam: number;
  maxOverseas: Record<MatchFormat, number>;
  // Per-tournament display label for the "non-overseas" bucket (e.g. 'US' for
  // MLC, 'Indian' for IPL) — cosmetic only, doesn't affect maxOverseas/is_overseas.
  domesticLabel: string | null;
  // Icon for the domestic-double booster — emoji or data:image/... URI (see
  // BoosterIcon.tsx). Cosmetic only, same as domesticLabel.
  domesticIcon: string | null;
  // Kill switch for player photos on the jersey icon (migration_v46). false
  // means Jersey always renders the plain icon, even when a player has a
  // photoUrl. Defaults true so photos show once imported, unless explicitly
  // turned off per tournament from Admin.
  showPlayerPhotos: boolean;
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

// ─── Contest / League types ───────────────────────────────────────────────────

export type ContestType    = 'daily' | 'sl' | 'private';
export type LeagueRuleType = 'standard' | 'custom';
// 'standard' = same rules/boosters as the main SL contest
// 'custom'   = league has its own rule set (different from SL)
//
// NOTE: this is the RULES axis only — whether a league uses SL's own
// scoring_rules/available_boosters or its own. It's a separate thing from
// whether the SQUAD is shared (web's primary_squad_id / "shared XI"
// mechanism, migration_v13): a standard-rules league's squad literally IS
// the member's main SL squad, mirrored at lock time; that's the isShared
// flag below, not ruleType. Confirmed while building Phase 4 (mobile
// parity) that ContestContext previously had no field for this at all, and
// toContestContext() hardcoded ruleType: 'standard' for every contest
// regardless of its actual scoring_rules/available_boosters — see
// contestStore.ts's RealContest/toContestContext for the real derivation.

export interface PrivateLeague {
  id:         string;
  name:       string;
  members:    number;
  rank:       number | null;
  ruleType:   LeagueRuleType; // determines whether it nests under SL or stands alone
  deadline:   string;         // ISO string — used to determine "active" league
  isActive:   boolean;        // upcoming match within lock window
}

export interface ContestContext {
  contestId:    string;         // contests.id UUID from Supabase
  contestType:  ContestType;
  leagueId:     string | null;  // null = main contest (no private league)
  leagueName:   string;
  ruleType:     LeagueRuleType;
  deadline:     string;
  // Shared-XI league: this squad mirrors the member's own main SL squad
  // (user_squads.primary_squad_id set), propagated automatically at lock
  // time and kept in sync by migration_v51's trigger. Always false for
  // 'daily'/'sl' contestType — only meaningful for 'private'.
  isShared:     boolean;
}

// ─── Navigation types ─────────────────────────────────────────────────────────

// Root stack: Lobby → Main tabs
export type RootStackParamList = {
  TournamentLobby: undefined;
  Main:            undefined;
};

export type RootTabParamList = {
  Home:        undefined;
  MyXI:        { openPicker?: boolean } | undefined;
  Leaderboard: { contestId?: string } | undefined;
  Rules:       undefined;
  Admin:       undefined;
};
