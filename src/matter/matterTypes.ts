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
    SEEKING_CHARGER: 4,
    CHARGING: 5,
    DOCKED: 6,
  },
  OperationalError: {
    NO_ERROR: 0,
    UNABLE_TO_START_OR_RESUME: 1,
    UNABLE_TO_COMPLETE_OPERATION: 2,
    COMMAND_INVALID_IN_STATE: 3,
    FAILED_TO_FIND_CHARGING_DOCK: 4,
    STUCK: 5,
    DUST_BIN_MISSING: 6,
    DUST_BIN_FULL: 7,
    WATER_TANK_EMPTY: 8,
    WATER_TANK_MISSING: 9,
    WATER_TANK_LID_OPEN: 10,
    MOP_CLEANING_PAD_MISSING: 11,
  },
  OperationalStateTransition: {
    STOPPED_TO_RUNNING: 0,
    RUNNING_TO_PAUSED: 1,
    PAUSED_TO_RUNNING: 2,
    RUNNING_TO_STOPPED: 3,
    STOPPED_TO_SEEKING_CHARGER: 4,
    SEEKING_CHARGER_TO_CHARGING: 5,
    CHARGING_TO_DOCKED: 6,
    RUNNING_TO_ERROR: 7,
    ERROR_TO_STOPPED: 8,
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
} as const;

export const MatterRvcRunMode = {
  SupportedModes: {
    VACUUM: 0,
    MOP: 1,
    VACUUM_AND_MOP: 2,
    SWEEP: 3,
  },
  CurrentMode: {
    VACUUM: 0,
    MOP: 1,
    VACUUM_AND_MOP: 2,
    SWEEP: 3,
  },
} as const;

export const MatterPowerSource = {
  BatChargeLevel: 0,
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