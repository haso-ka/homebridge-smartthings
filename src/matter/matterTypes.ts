import { API, Logger, PlatformAccessory } from 'homebridge';
import { MultiServiceAccessory } from '../multiServiceAccessory';
import type { ShortEvent } from '../webhook/subscriptionHandler';

export interface MatterDeviceContext {
  deviceId: string;
  label: string;
  manufacturerName?: string;
  model?: string;
  serialNumber?: string;
  firmwareRevision?: string;
  capabilities: string[];
  components: Array<{ id: string; capabilities: string[] }>;
}

export interface NormalizedMatterState {
  [clusterName: string]: Record<string, unknown>;
}

export interface NormalizedMatterCommand {
  cluster: string;
  command: string;
  arguments?: unknown[];
}

export interface MatterAdapter {
  readonly deviceType: string;
  readonly supportedCapabilities: string[];

  initialize(accessory: PlatformAccessory, context: MatterDeviceContext): Promise<void>;
  handleCommand(command: NormalizedMatterCommand): Promise<boolean>;
  updateState(state: NormalizedMatterState): void;
  processEvent(event: ShortEvent): void;
  getInitialState(): NormalizedMatterState;
}

export interface MatterAdapterConstructor {
  new(
    platform: API,
    log: Logger,
    multiServiceAccessory: MultiServiceAccessory
  ): MatterAdapter;
}

export const MatterClusterNames = {
  OnOff: 'onOff',
  Identify: 'identify',
  RvcOperationalState: 'rvcOperationalState',
  RvcCleanMode: 'rvcCleanMode',
  RvcRunMode: 'rvcRunMode',
  ServiceArea: 'serviceArea',
  PowerSource: 'powerSource',
  BasicInformation: 'basicInformation',
  BridgedDeviceBasicInformation: 'bridgedDeviceBasicInformation',
  OperationalState: 'operationalState',
  DishwasherMode: 'dishwasherMode',
  DishwasherAlarm: 'dishwasherAlarm',
} as const;

export const MatterRvcOperationalState = {
  OperationalState: {
    STOPPED: 0,
    RUNNING: 1,
    PAUSED: 2,
    ERROR: 3,
    SEEKING_CHARGER: 64,
    CHARGING: 65,
    DOCKED: 66,
    EMPTYING_DUST_BIN: 67,
    CLEANING_MOP: 68,
    FILLING_WATER_TANK: 69,
    UPDATING_MAPS: 70,
  },
  OperationalError: {
    NO_ERROR: 0,
    UNABLE_TO_START_OR_RESUME: 1,
    UNABLE_TO_COMPLETE_OPERATION: 2,
    COMMAND_INVALID_IN_STATE: 3,
    FAILED_TO_FIND_CHARGING_DOCK: 64,
    STUCK: 65,
    DUST_BIN_MISSING: 66,
    DUST_BIN_FULL: 67,
    WATER_TANK_EMPTY: 68,
    WATER_TANK_MISSING: 69,
    WATER_TANK_LID_OPEN: 70,
    MOP_CLEANING_PAD_MISSING: 71,
    LOW_BATTERY: 72,
    CANNOT_REACH_TARGET_AREA: 73,
    DIRTY_WATER_TANK_FULL: 74,
    DIRTY_WATER_TANK_MISSING: 75,
    WHEELS_JAMMED: 76,
    BRUSH_JAMMED: 77,
    NAVIGATION_SENSOR_OBSCURED: 78,
  },
} as const;

export const MatterRvcCleanMode = {
  Type: {
    VACUUM: 0,
    MOP: 1,
    VACUUM_AND_MOP: 2,
    MOP_AFTER_VACUUM: 3,
  },
  Tag: {
    DEEP_CLEAN: 16384, // 0x4000
    VACUUM: 16385, // 0x4001
    MOP: 16386, // 0x4002
    VACUUM_THEN_MOP: 16387, // 0x4003
  },
} as const;


export const MatterRvcCleanModeMap = {
  vacuum: { mode: MatterRvcCleanMode.Type.VACUUM, label: 'Vacuum', tags: [MatterRvcCleanMode.Tag.VACUUM] },
  mop: { mode: MatterRvcCleanMode.Type.MOP, label: 'Mop', tags: [MatterRvcCleanMode.Tag.MOP] },
  vacuumAndMopTogether: { mode: MatterRvcCleanMode.Type.VACUUM_AND_MOP, label: 'Vacuum and Mop', tags: [MatterRvcCleanMode.Tag.VACUUM, MatterRvcCleanMode.Tag.MOP] },
  mopAfterVacuum: { mode: MatterRvcCleanMode.Type.MOP_AFTER_VACUUM, label: 'Mop after Vacuum', tags: [MatterRvcCleanMode.Tag.VACUUM_THEN_MOP] },
} as const;

export const MatterRvcRunMode = {
  Type: {
    IDLE: 0,
    AUTO: 1,
    SPOT: 2,
    AREA: 3,
    OBJECT: 4,
    PATTERN_MAP: 5,
    UNCLEANED_OBJECT: 6,
    STOP: 7,
    MANUAL: 8,
    PET: 9,
    MAP: 10,
    CREATING_MAP: 11,
  },
  Tag: {
    IDLE: 16384, // 0x4000
    CLEANING: 16385, // 0x4001
    MAPPING: 16386, // 0x4002
  },
} as const;

export const MatterRvcRequiredRunMode = ['idle', 'auto']

export const MatterRvcOptionalRunMode = ['stop']

export const MatterRvcRunModeMap = {
  idle: { mode: MatterRvcRunMode.Type.IDLE, label: 'Idle', tags: [MatterRvcRunMode.Tag.IDLE] },
  auto: { mode: MatterRvcRunMode.Type.AUTO, label: 'Auto', tags: [MatterRvcRunMode.Tag.CLEANING] },
  spot: { mode: MatterRvcRunMode.Type.SPOT, label: 'Spot', tags: [MatterRvcRunMode.Tag.CLEANING] },
  area: { mode: MatterRvcRunMode.Type.AREA, label: 'Area', tags: [MatterRvcRunMode.Tag.CLEANING] },
  object: { mode: MatterRvcRunMode.Type.OBJECT, label: 'Object', tags: [MatterRvcRunMode.Tag.CLEANING] },
  patternMap: { mode: MatterRvcRunMode.Type.PATTERN_MAP, label: 'Pattern Map', tags: [MatterRvcRunMode.Tag.CLEANING] },
  uncleanedObject: { mode: MatterRvcRunMode.Type.UNCLEANED_OBJECT, label: 'Uncleaned Object', tags: [MatterRvcRunMode.Tag.CLEANING] },
  stop: { mode: MatterRvcRunMode.Type.STOP, label: 'Stop', tags: [MatterRvcRunMode.Tag.IDLE] },
  map: { mode: MatterRvcRunMode.Type.MAP, label: 'Map', tags: [MatterRvcRunMode.Tag.CLEANING] },
  manual: { mode: MatterRvcRunMode.Type.MANUAL, label: 'Manual', tags: [MatterRvcRunMode.Tag.CLEANING] },
  pet: { mode: MatterRvcRunMode.Type.PET, label: 'Pet', tags: [MatterRvcRunMode.Tag.CLEANING] },
  creatingMap: { mode: MatterRvcRunMode.Type.CREATING_MAP, label: 'Creating Map', tags: [MatterRvcRunMode.Tag.MAPPING] },
} as const;

export const MatterPowerSource = {
  BatChargeLevel: {
    OK: 0,
    WARNING: 1,
    CRITICAL: 2,
  },
  BatChargeState: {
    NOT_CHARGING: 0,
    CHARGING: 1,
    CHARGED: 2,
  },
  PowerSource: {
    UNKNOWN: 0,
    INTERNAL: 1,
    EXTERNAL: 2,
    BATTERY: 3,
  },
  BatReplacementNeeded: false,
  BatReplaceability: {
    NOT_REPLACEABLE: 0,
    USER_REPLACEABLE: 1,
    FACTORY_REPLACEABLE: 2,
  },
} as const;

export const MatterOperationalState = {
  OperationalState: {
    STOPPED: 0,
    RUNNING: 1,
    PAUSED: 2,
    ERROR: 3,
  },
  OperationalError: {
    NO_ERROR: 0,
    UNABLE_TO_START_OR_RESUME: 1,
    UNABLE_TO_COMPLETE_OPERATION: 2,
    COMMAND_INVALID_IN_STATE: 3,
  },
} as const;

export const MatterDishwasherMode = {
  Tag: {
    NORMAL: 16384,
    HEAVY: 16385,
    LIGHT: 16386,
  },
} as const;

export const MatterDishwasherAlarm = {
  State: {
    SUPPRESS_ALL: 0,
  },
  Mask: {
    INFLOW_ERROR: 1 << 0,
    DRAIN_ERROR: 1 << 1,
    DOOR_ERROR: 1 << 2,
    TEMP_TOO_LOW: 1 << 3,
    TEMP_TOO_HIGH: 1 << 4,
    WATER_LEVEL_ERROR: 1 << 5,
  },
  Supported: {
    NONE: 0,
  },
} as const;

export const DishwasherCourseTagMap: Record<string, number> = {
  AI: MatterDishwasherMode.Tag.NORMAL,
  normal: MatterDishwasherMode.Tag.NORMAL,
  eco_10: MatterDishwasherMode.Tag.LIGHT,
  eco: MatterDishwasherMode.Tag.LIGHT,
  intensive: MatterDishwasherMode.Tag.HEAVY,
  steamSoak: MatterDishwasherMode.Tag.HEAVY,
  nightSilence: MatterDishwasherMode.Tag.NORMAL,
  upperExpress: MatterDishwasherMode.Tag.LIGHT,
  babyBottle: MatterDishwasherMode.Tag.HEAVY,
  selfSanitize: MatterDishwasherMode.Tag.HEAVY,
  glasses: MatterDishwasherMode.Tag.LIGHT,
  plastics: MatterDishwasherMode.Tag.LIGHT,
  rinseDry: MatterDishwasherMode.Tag.LIGHT,
  dryOnly: MatterDishwasherMode.Tag.LIGHT,
  coldRinse: MatterDishwasherMode.Tag.LIGHT,
  drinkware: MatterDishwasherMode.Tag.LIGHT,
  auto: MatterDishwasherMode.Tag.NORMAL,
  delicate: MatterDishwasherMode.Tag.LIGHT,
  express: MatterDishwasherMode.Tag.LIGHT,
  preWash: MatterDishwasherMode.Tag.LIGHT,
  selfClean: MatterDishwasherMode.Tag.HEAVY,
  extraSilence: MatterDishwasherMode.Tag.LIGHT,
  rinseOnly: MatterDishwasherMode.Tag.LIGHT,
  potsAndPans: MatterDishwasherMode.Tag.HEAVY,
  babycare: MatterDishwasherMode.Tag.HEAVY,
  quick: MatterDishwasherMode.Tag.LIGHT,
  heavy: MatterDishwasherMode.Tag.HEAVY,
  daily: MatterDishwasherMode.Tag.NORMAL,
  chef: MatterDishwasherMode.Tag.HEAVY,
  preBlast: MatterDishwasherMode.Tag.HEAVY,
  machineCare: MatterDishwasherMode.Tag.NORMAL,
  night: MatterDishwasherMode.Tag.LIGHT,
  quick_14: MatterDishwasherMode.Tag.LIGHT,
  express_0C: MatterDishwasherMode.Tag.LIGHT,
  daily_09: MatterDishwasherMode.Tag.NORMAL,
  eco_08: MatterDishwasherMode.Tag.LIGHT,
} as const;

export const MatterDeviceCapabilityGroups: Record<string, string[][]> = {
  RoboticVacuumCleaner: [
    ['samsungce.robotCleanerOperatingState', 'robotCleanerOperatingState'],
    ['samsungce.robotCleanerCleaningMode', 'robotCleanerCleaningMode', 'robotCleanerMovement', 'samsungce.robotCleanerMovement', 'samsungce.robotCleanerCleaningType'],
    ['battery', 'switch'],
  ],
  Dishwasher: [
    ['dishwasherOperatingState', 'samsungce.dishwasherOperation'],
    ['samsungce.dishwasherWashingCourse'],
    ['samsungce.dishwasherJobState', 'custom.dishwasherOperatingProgress', 'custom.dishwasherOperatingPercentage', 'dishwasherOperatingState'],
    ['switch'],
  ],
};

export function isMatterDeviceMatchingGroups(deviceCaps: Set<string>, deviceType: string): boolean {
  const groups = MatterDeviceCapabilityGroups[deviceType];
  if (!groups) return false;
  return groups.every(group => group.some(cap => deviceCaps.has(cap)));
}

export const MatterDeviceRelevantCapabilities: Record<string, { exact: Set<string>; prefixes: string[] }> = {
  RoboticVacuumCleaner: {
    exact: new Set([
      'robotCleanerMovement',
      'robotCleanerTurboMode',
      'battery',
      'switch',
      'audioNotification',
      'audioVolume',
      'audioMute',
    ]),
    prefixes: ['samsungce.robotCleaner'],
  },
  Dishwasher: {
    exact: new Set([
      'dishwasherOperatingState',
      'switch',
      'samsungce.kidsLock',
      'remoteControlStatus',
      'custom.dishwasherOperatingProgress',
      'custom.dishwasherOperatingPercentage',
      'custom.dishwasherDelayStartTime',
      'execute',
      'powerConsumptionReport',
      'samsungce.waterConsumptionReport',
    ]),
    prefixes: ['samsungce.dishwasher', 'custom.dishwasher'],
  },
};

export function isMatterRelevantCapability(deviceType: string, capabilityId: string): boolean {
  const rel = MatterDeviceRelevantCapabilities[deviceType];
  if (!rel) return false;
  if (rel.exact.has(capabilityId)) return true;
  return rel.prefixes.some(prefix => capabilityId.startsWith(prefix));
}