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
  new (
    platform: API,
    log: Logger,
    multiServiceAccessory: MultiServiceAccessory
  ): MatterAdapter;
}

export const MatterClusterNames = {
  OnOff: 'onOff',
  RvcOperationalState: 'rvcOperationalState',
  RvcCleanMode: 'rvcCleanMode',
  RvcRunMode: 'rvcRunMode',
  ServiceArea: 'serviceArea',
  PowerSource: 'powerSource',
  BasicInformation: 'basicInformation',
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
  SupportedModes: {
    AUTO: 0,
    QUICK: 1,
    QUIET: 2,
    DEEP: 3,
    SPOT: 4,
    MANUAL: 5,
    EDGE: 6,
    ZONE: 7,
    MAP: 8,
    SELECTIVE_ROOM: 9,
    THOROUGH: 10,
    TURBO: 11,
  },
  CurrentMode: {
    AUTO: 0,
    QUICK: 1,
    QUIET: 2,
    DEEP: 3,
    SPOT: 4,
    MANUAL: 5,
    EDGE: 6,
    ZONE: 7,
    MAP: 8,
    SELECTIVE_ROOM: 9,
    THOROUGH: 10,
    TURBO: 11,
  },
  ModeTag: {
    VACUUM: 16385,
    MOP: 16386,
    VACUUM_THEN_MOP: 16387,
  },
} as const;

export const MatterRvcRunMode = {
  SupportedModes: {
    IDLE: 0,
    VACUUM: 1,
    MOP: 2,
    VACUUM_AND_MOP: 3,
    SWEEP: 4,
  },
  CurrentMode: {
    IDLE: 0,
    VACUUM: 1,
    MOP: 2,
    VACUUM_AND_MOP: 3,
    SWEEP: 4,
  },
  ModeTag: {
    IDLE: 16384,
    CLEANING: 16385,
    MAPPING: 16386,
  },
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