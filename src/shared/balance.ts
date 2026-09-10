/**
 * Initial balance hypotheses from Plan B5/B6/B7. Every value here is a starting point for the C2
 * playtest, but the constant *names* are contract: the kernel, the server and the UI all read them
 * so a number can never disagree between authority and presentation.
 */

/** Fractions of available torch force (B5: "reverse 0.28, lateral 0.22, brake 0.65, boost 1.65"). */
export const FLIGHT = {
  reverseFactor: 0.28,
  lateralFactor: 0.22,
  brakeFactor: 0.65,
  boostFactor: 1.65,
} as const;

/** Reaction-control fuel draw in kg/s, added to the main-drive figure from the catalog (B5). */
export const RCS_FUEL_KG_S = { turn: 1.2, lateral: 3, brake: 16 } as const;

/** Hull electrical baseline in MW; `activeMW` is additional to it (B6). */
export const HULL_IDLE_MW = 0.5;

/** Clamps applied after multiplicative effects, before dependent stats (B6). */
export const CLAMPS = {
  resistanceMax: 0.35,
  cooldownMinS: 0.06,
  /** Capacitor surplus supply cap before pulse-bank chargeLimitMW is added (B6). */
  capacitorBaseMW: 2,
} as const;

/** Heat thresholds as fractions of fitted heat capacity (B6: warn 85%, block 100%, recover 70%). */
export const HEAT = { warn: 0.85, block: 1, recover: 0.7 } as const;
/** Module output multiplier below 30% health, and the level that disables it entirely (B6). */
export const MODULE = { damagedBelow: 0.3, damagedOutput: 0.5 } as const;

/** Boundary warnings and return timer (B5). */
export const BOUNDARY = { warnFraction: 0.9, returnSeconds: 15 } as const;

/** Sensor rules (B6): signature multipliers per drive state, contact ageing and lock timings. */
export const SENSOR = {
  publicSilhouetteRangeM: 700,
  signatureCoast: 0.6,
  signatureNormal: 1,
  signatureBoost: 1.4,
  passiveRangeClamp: [0.5, 1.5] as const,
  uncertainSeconds: 3,
  lockSeconds: 1,
  lockGapSeconds: 0.25,
  ecmLoseSeconds: 1,
  /** Decoy contest: a standard seeker loses the lock 60% of the time, 40% with survey support (B6). */
  ecmStandardChance: 0.6,
  ecmSupportedChance: 0.4,
} as const;

/** Collision restitution and solver limits (B5). */
export const CONTACT = {
  shipRestitution: 0.15,
  rockRestitution: 0.25,
  slopM: 0.02,
  maxToiPerBodyPerTick: 4,
  friction: 0.35,
  /** Ceiling on collision damage from one contact, so no single impact deletes a full-hull ship. */
  maxDamagePerTick: 25,
} as const;

/** Rock fracture and caps (B5/B9: 256 physical rocks including fragments, 160 initial authored). */
export const ROCKS = {
  maxPhysical: 256,
  minRadiusM: 1.5,
  splitRadiusM: 6,
  densityKgM3: 2400,
  /** Cracked-but-intact coarse body keeps this fraction of hull until a split is safe. */
  crackedHullFraction: 0.4,
} as const;

/** Weapons and projectiles (B6). */
export const WEAPONS = {
  maxProjectiles: 512,
  reservedGuidedSlots: 64,
  minesPerOwner: 6,
  torpedoesPerOwner: 4,
  fixedGunGimbalRad: (15 * Math.PI) / 180,
  pdcArcRad: (160 * Math.PI) / 180,
} as const;

/** Repair, tow and recovery (B6/B7). */
export const RECOVERY = {
  repairHullPerSecond: 4,
  repairRangeM: 100,
  dockHostileRangeM: 300,
  dockDamageWindowS: 5,
  emergencyTowSeconds: 30,
  redeploySeconds: 15,
  recoveryCostCredits: 20,
  moduleRepairFraction: 0.25,
} as const;

/** PvP rules (B7). */
export const PVP = {
  teams: 2,
  maxPerTeam: 4,
  scoreToWin: 30,
  timeLimitS: 600,
  suddenDeathS: 90,
  respawnSeconds: 5,
  spawnProtectionSeconds: 2,
  assistWindowS: 10,
  assistDamageFraction: 0.1,
  killCreditWindowS: 10,
} as const;

/** Lobby and lifecycle limits (B1/B3). */
export const RULES = {
  buildBudget: 110,
  maxPendingSockets: 16,
  helloDeadlineS: 5,
  maxClientFrameBytes: 16 * 1024,
  inputRatePerSecond: 80,
  inputBurst: 120,
  commandRatePerSecond: 8,
  commandBurst: 16,
  codeAttemptsPerSecond: 2,
  codeBucketSeconds: 60,
  baselineRequestsPerSecond: 0.5,
  loadingDeadlineS: 30,
  countdownSeconds: 3,
  extractionSeconds: 45,
  voteSeconds: 30,
  reconnectSeconds: 60,
  maxReplayBytes: 4 * 1024 * 1024,
  replaySeconds: 10,
  heartbeatSeconds: 5,
  staleSeconds: 15,
  snapshotBacklogBytes: 256 * 1024,
  socketBufferBytes: 512 * 1024,
  receiptRetentionS: 600,
  maxReceipts: 1024,
  resumeTokenMinBits: 128,
  previousTokenGraceS: 10,
} as const;

/** Start of a campaign (B7): every admitted pilot gets a loaner fit and these credits. */
export const CAMPAIGN_START = { credits: 200, repairCostPerHull: 1, shopPriceMultiplier: 10 } as const;
