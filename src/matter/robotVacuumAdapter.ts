import { API, Logger } from 'homebridge';
import { MultiServiceAccessory } from '../multiServiceAccessory';
import type { ShortEvent } from '../webhook/subscriptionHandler';
import { BaseMatterAdapter } from './baseMatterAdapter';
import {
  MatterAdapter,
  NormalizedMatterCommand,
  NormalizedMatterState,
  MatterClusterNames,
  MatterRvcOperationalState,
  MatterRvcCleanMode,
  MatterRvcRunMode,
  MatterPowerSource,
} from './matterTypes';

const SMARTTHINGS_ROBOT_VACUUM_CAPABILITIES = [
  'robotCleanerOperatingState',
  'samsungce.robotCleanerOperatingState',
  'robotCleanerCleaningMode',
  'samsungce.robotCleanerCleaningMode',
  'robotCleanerTurboMode',
  'samsungce.robotCleanerTurboMode',
  'robotCleanerMovement',
  'samsungce.robotCleanerMovement',
  'battery',
  'switch',
] as const;

type SmartThingsRobotVacuumCapability = typeof SMARTTHINGS_ROBOT_VACUUM_CAPABILITIES[number];

interface RobotCleanerOperatingState {
  operatingState?: {
    value: string;
  };
  supportedOperatingStates?: {
    value: string[];
  };
  supportedCommands?: {
    value: string[];
  };
}

interface RobotCleanerCleaningMode {
  robotCleanerCleaningMode?: {
    value: string;
  };
  supportedRobotCleanerCleaningModes?: {
    value: string[];
  };
}

interface RobotCleanerTurboMode {
  robotCleanerTurboMode?: {
    value: string;
  };
  supportedRobotCleanerTurboModes?: {
    value: string[];
  };
}

interface RobotCleanerMovement {
  robotCleanerMovement?: {
    value: string;
  };
}

interface Battery {
  battery?: {
    value: number;
  };
}

interface Switch {
  switch?: {
    value: string;
  };
}

interface SmartThingsRobotVacuumStatus {
  main?: {
    robotCleanerOperatingState?: RobotCleanerOperatingState;
    'samsungce.robotCleanerOperatingState'?: RobotCleanerOperatingState;
    robotCleanerCleaningMode?: RobotCleanerCleaningMode;
    'samsungce.robotCleanerCleaningMode'?: RobotCleanerCleaningMode;
    robotCleanerTurboMode?: RobotCleanerTurboMode;
    'samsungce.robotCleanerTurboMode'?: RobotCleanerTurboMode;
    robotCleanerMovement?: RobotCleanerMovement;
    'samsungce.robotCleanerMovement'?: RobotCleanerMovement;
    battery?: Battery;
    switch?: Switch;
  };
}

export class RobotVacuumAdapter extends BaseMatterAdapter implements MatterAdapter {
  readonly deviceType = 'RoboticVacuumCleaner';
  readonly supportedCapabilities = [...SMARTTHINGS_ROBOT_VACUUM_CAPABILITIES];

  private matterApi: any = null;
  private currentOperationalState: number = MatterRvcOperationalState.OperationalState.STOPPED;
  private currentCleanMode: number = MatterRvcCleanMode.CurrentMode.AUTO;
  private currentRunMode: number = MatterRvcRunMode.CurrentMode.VACUUM;
  private currentBatteryLevel = 100;
  private currentCharging = false;
  private currentPowerOn = false;

  constructor(platform: API, log: Logger, multiServiceAccessory: MultiServiceAccessory) {
    super(platform, log, multiServiceAccessory);
    this.matterApi = (platform as any).matter || null;
  }

  protected async setupMatterAccessory(): Promise<void> {
    if (!this.matterApi || !this.context) {
      this.log.warn('[RobotVacuumAdapter] Matter API not available or context not initialized');
      return;
    }

    try {
      // Generate UUID for standalone Matter accessory (not tied to HAP accessory)
      const uuid = this.platform.hap.uuid.generate(this.context.deviceId + '-matter');

      // Register as standalone Matter accessory for proper device icon during pairing
      // Using registerPlatformAccessories for Matter accessory
      await this.matterApi.registerPlatformAccessories('homebridge-smartthings-oauth-custom-hsk', 'HomeBridgeSmartThingsCustomHSK', [{
        UUID: uuid,
        displayName: this.context.label,
        deviceType: this.matterApi.deviceTypes.RoboticVacuumCleaner,
        manufacturer: this.context.manufacturerName || 'Samsung',
        model: this.context.model || 'SmartThings Robot Vacuum',
        serialNumber: this.context.serialNumber || this.context.deviceId,
        firmwareRevision: this.context.firmwareRevision || '1.0',
        clusters: {
          basicInformation: {
            vendorName: this.context.manufacturerName || 'Samsung',
            productName: this.context.label,
            productId: 0x0001,
            deviceTypeId: 0x0001,
            softwareVersion: 1,
            softwareVersionString: this.context.firmwareRevision || '1.0',
          },
          // OnOff cluster with handler for on/off commands
          onOff: {
            onOff: this.currentPowerOn,
            handlers: {
              on: async () => this.handleOnOffCommand('on'),
              off: async () => this.handleOnOffCommand('off'),
            },
          },
          // RvcOperationalState cluster with handlers for start/pause/goHome
          rvcOperationalState: {
            operationalState: this.currentOperationalState,
            operationalError: { errorStateId: MatterRvcOperationalState.OperationalError.NO_ERROR },
            operationalStateList: [
              { operationalStateId: MatterRvcOperationalState.OperationalState.STOPPED },
              { operationalStateId: MatterRvcOperationalState.OperationalState.RUNNING },
              { operationalStateId: MatterRvcOperationalState.OperationalState.PAUSED },
              { operationalStateId: MatterRvcOperationalState.OperationalState.ERROR },
              { operationalStateId: MatterRvcOperationalState.OperationalState.SEEKING_CHARGER },
              { operationalStateId: MatterRvcOperationalState.OperationalState.CHARGING },
              { operationalStateId: MatterRvcOperationalState.OperationalState.DOCKED },
            ],
            handlers: {
              start: async () => this.handleOperationalStateCommand('start'),
              pause: async () => this.handleOperationalStateCommand('pause'),
              goHome: async () => this.handleOperationalStateCommand('goHome'),
            },
          },
          // RvcCleanMode cluster with handler for changeToMode
          rvcCleanMode: {
            currentMode: this.currentCleanMode,
            supportedModes: [
              { mode: MatterRvcCleanMode.SupportedModes.AUTO, label: 'Auto', modeTags: [{ value: MatterRvcCleanMode.ModeTag.VACUUM }] },
              { mode: MatterRvcCleanMode.SupportedModes.QUIET, label: 'Quiet', modeTags: [{ value: MatterRvcCleanMode.ModeTag.VACUUM }] },
              { mode: MatterRvcCleanMode.SupportedModes.DEEP, label: 'Deep', modeTags: [{ value: MatterRvcCleanMode.ModeTag.VACUUM }] },
              { mode: MatterRvcCleanMode.SupportedModes.SPOT, label: 'Spot', modeTags: [{ value: MatterRvcCleanMode.ModeTag.VACUUM }] },
              { mode: MatterRvcCleanMode.SupportedModes.TURBO, label: 'Turbo', modeTags: [{ value: MatterRvcCleanMode.ModeTag.VACUUM }] },
            ],
            handlers: {
              changeToMode: async (request: { newMode: number }) => this.handleCleanModeCommand('changeToMode', [request.newMode]),
            },
          },
          // RvcRunMode cluster with handler for changeToMode
          rvcRunMode: {
            currentMode: this.currentRunMode,
            supportedModes: [
              { mode: MatterRvcRunMode.SupportedModes.VACUUM, label: 'Vacuum', modeTags: [{ value: MatterRvcRunMode.ModeTag.IDLE }] },
              { mode: MatterRvcRunMode.SupportedModes.MOP, label: 'Mop', modeTags: [{ value: MatterRvcRunMode.ModeTag.CLEANING }] },
              { mode: MatterRvcRunMode.SupportedModes.VACUUM_AND_MOP, label: 'Vacuum and Mop', modeTags: [{ value: MatterRvcRunMode.ModeTag.CLEANING }] },
            ],
            handlers: {
              changeToMode: async (request: { newMode: number }) => this.handleRunModeCommand('changeToMode', [request.newMode]),
            },
          },
          // powerSource: batChargeLevel as enum (OK=0, WARNING=1, CRITICAL=2)
          powerSource: {
            batChargeLevel: this.batteryLevelToMatterEnum(this.currentBatteryLevel),
            batChargeState: this.currentCharging ? MatterPowerSource.BatChargeState.CHARGING : MatterPowerSource.BatChargeState.NOT_CHARGING,
            powerSource: MatterPowerSource.PowerSource.BATTERY,
            batReplacementNeeded: MatterPowerSource.BatReplacementNeeded,
            batReplaceability: MatterPowerSource.BatReplaceability.NOT_REPLACEABLE,
          },
        },
      }]);

      this.log.info(`[RobotVacuumAdapter] Registered standalone Matter accessory: ${this.context.label} (${uuid})`);
    } catch (error) {
      this.log.error(`[RobotVacuumAdapter] Failed to register Matter accessory: ${error}`);
    }
  }

  private async updateMatterClustersAfterRegistration(): Promise<void> {
    if (!this.matterApi || !this.context) {
      return;
    }

    const deviceId = this.context.deviceId;

    try {
      // Update state values after registration
      await this.matterApi.updateAccessoryState(deviceId, MatterClusterNames.RvcOperationalState, {
        operationalState: this.currentOperationalState,
        operationalError: MatterRvcOperationalState.OperationalError.NO_ERROR,
      });

      await this.matterApi.updateAccessoryState(deviceId, MatterClusterNames.RvcCleanMode, {
        currentMode: this.currentCleanMode,
      });

      await this.matterApi.updateAccessoryState(deviceId, MatterClusterNames.RvcRunMode, {
        currentMode: this.currentRunMode,
      });

      await this.matterApi.updateAccessoryState(deviceId, MatterClusterNames.PowerSource, {
        batChargeLevel: this.batteryLevelToMatterEnum(this.currentBatteryLevel),
        batChargeState: this.currentCharging ? MatterPowerSource.BatChargeState.CHARGING : MatterPowerSource.BatChargeState.NOT_CHARGING,
        powerSource: MatterPowerSource.PowerSource.BATTERY,
        batReplacementNeeded: MatterPowerSource.BatReplacementNeeded,
        batReplaceability: MatterPowerSource.BatReplaceability.NOT_REPLACEABLE,
      });

      this.log.debug('[RobotVacuumAdapter] Updated Matter cluster states after registration');
    } catch (error) {
      this.log.error(`[RobotVacuumAdapter] Failed to update Matter cluster states: ${error}`);
    }
  }

  protected async handleMatterCommand(command: NormalizedMatterCommand): Promise<boolean> {
    if (!this.context) {
      return false;
    }

    try {
      switch (command.cluster) {
        case MatterClusterNames.OnOff:
          return await this.handleOnOffCommand(command.command);

        case MatterClusterNames.RvcOperationalState:
          return await this.handleOperationalStateCommand(command.command);

        case MatterClusterNames.RvcCleanMode:
          return await this.handleCleanModeCommand(command.command, command.arguments);

        case MatterClusterNames.RvcRunMode:
          return await this.handleRunModeCommand(command.command, command.arguments);

        default:
          this.log.debug(`[RobotVacuumAdapter] Unhandled cluster: ${command.cluster}`);
          return false;
      }
    } catch (error) {
      this.log.error(`[RobotVacuumAdapter] Error handling command ${command.cluster}.${command.command}: ${error}`);
      return false;
    }
  }

  private async handleOnOffCommand(command: string): Promise<boolean> {
    const targetState = command === 'on';
    this.currentPowerOn = targetState;

    const success = await this.sendSmartThingsCommand('main', 'switch', targetState ? 'on' : 'off');
    if (success) {
      this.matterApi?.updateAccessoryState(this.context!.deviceId, MatterClusterNames.OnOff, { onOff: targetState });
      this.updateOperationalStateFromPower(targetState);
    }
    return success;
  }

  private async handleOperationalStateCommand(command: string): Promise<boolean> {
    let success = false;

    switch (command) {
      case 'start':
        success = await this.sendSmartThingsCommand('main', 'samsungce.robotCleanerOperatingState', 'start');
        if (success) {
          this.currentOperationalState = MatterRvcOperationalState.OperationalState.RUNNING;
        }
        break;
      case 'pause':
        success = await this.sendSmartThingsCommand('main', 'samsungce.robotCleanerOperatingState', 'pause');
        if (success) {
          this.currentOperationalState = MatterRvcOperationalState.OperationalState.PAUSED;
        }
        break;
      case 'goHome':
      case 'stop':
        success = await this.sendSmartThingsCommand('main', 'samsungce.robotCleanerOperatingState', 'goHome');
        if (success) {
          this.currentOperationalState = MatterRvcOperationalState.OperationalState.SEEKING_CHARGER;
        }
        break;
      default:
        this.log.debug(`[RobotVacuumAdapter] Unknown operational state command: ${command}`);
        return false;
    }

    if (success) {
      this.pushOperationalState();
    }
    return success;
  }

  private async handleCleanModeCommand(command: string, args?: unknown[]): Promise<boolean> {
    if (command !== 'changeToMode' || !args || args.length === 0) {
      return false;
    }

    const mode = args[0] as number;
    const smartThingsMode = this.mapMatterCleanModeToSmartThings(mode);

    if (!smartThingsMode) {
      this.log.warn(`[RobotVacuumAdapter] Unsupported Matter clean mode: ${mode}`);
      return false;
    }

    const success = await this.sendSmartThingsCommand('main', 'samsungce.robotCleanerCleaningMode', 'setCleaningMode', [smartThingsMode]);
    if (success) {
      this.currentCleanMode = mode;
      this.matterApi?.updateAccessoryState(this.context!.deviceId, MatterClusterNames.RvcCleanMode, { currentMode: mode });
    }
    return success;
  }

  private async handleRunModeCommand(command: string, args?: unknown[]): Promise<boolean> {
    if (command !== 'changeToMode' || !args || args.length === 0) {
      return false;
    }

    const mode = args[0] as number;
    const smartThingsMode = this.mapMatterRunModeToSmartThings(mode);

    if (!smartThingsMode) {
      this.log.warn(`[RobotVacuumAdapter] Unsupported Matter run mode: ${mode}`);
      return false;
    }

    const success = await this.sendSmartThingsCommand('main', 'samsungce.robotCleanerMovement', 'setRobotCleanerMovement', [smartThingsMode]);
    if (success) {
      this.currentRunMode = mode;
      this.matterApi?.updateAccessoryState(this.context!.deviceId, MatterClusterNames.RvcRunMode, { currentMode: mode });
    }
    return success;
  }

  protected pushStateToMatter(state: NormalizedMatterState): void {
    if (!this.matterApi || !this.context) {
      return;
    }

    const uuid = this.context.deviceId;

    if (state[MatterClusterNames.OnOff]) {
      this.matterApi?.updateAccessoryState(uuid, MatterClusterNames.OnOff, state[MatterClusterNames.OnOff]);
    }
    if (state[MatterClusterNames.RvcOperationalState]) {
      this.matterApi?.updateAccessoryState(uuid, MatterClusterNames.RvcOperationalState, state[MatterClusterNames.RvcOperationalState]);
    }
    if (state[MatterClusterNames.RvcCleanMode]) {
      this.matterApi?.updateAccessoryState(uuid, MatterClusterNames.RvcCleanMode, state[MatterClusterNames.RvcCleanMode]);
    }
    if (state[MatterClusterNames.RvcRunMode]) {
      this.matterApi?.updateAccessoryState(uuid, MatterClusterNames.RvcRunMode, state[MatterClusterNames.RvcRunMode]);
    }
    if (state[MatterClusterNames.PowerSource]) {
      this.matterApi?.updateAccessoryState(uuid, MatterClusterNames.PowerSource, state[MatterClusterNames.PowerSource]);
    }
  }

  private pushOperationalState(): void {
    if (!this.matterApi || !this.context) {
      return;
    }

    this.matterApi?.updateAccessoryState(this.context.deviceId, MatterClusterNames.RvcOperationalState, {
      operationalState: this.currentOperationalState,
      operationalError: MatterRvcOperationalState.OperationalError.NO_ERROR,
    });
  }

  private updateOperationalStateFromPower(powerOn: boolean): void {
    if (powerOn) {
      this.currentOperationalState = MatterRvcOperationalState.OperationalState.RUNNING;
    } else {
      this.currentOperationalState = MatterRvcOperationalState.OperationalState.STOPPED;
    }
    this.pushOperationalState();
  }

  protected handleSmartThingsEvent(event: ShortEvent): void {
    const capability = event.capability as SmartThingsRobotVacuumCapability;
    const attribute = event.attribute;
    const value = event.value;

    switch (capability) {
      case 'robotCleanerOperatingState':
      case 'samsungce.robotCleanerOperatingState':
        this.handleOperatingStateEvent(attribute, value);
        break;
      case 'robotCleanerCleaningMode':
      case 'samsungce.robotCleanerCleaningMode':
        this.handleCleaningModeEvent(attribute, value);
        break;
      case 'robotCleanerTurboMode':
      case 'samsungce.robotCleanerTurboMode':
        this.handleTurboModeEvent(attribute, value);
        break;
      case 'robotCleanerMovement':
      case 'samsungce.robotCleanerMovement':
        this.handleMovementEvent(attribute, value);
        break;
      case 'battery':
        this.handleBatteryEvent(attribute, value);
        break;
      case 'switch':
        this.handleSwitchEvent(attribute, value);
        break;
    }
  }

  private handleOperatingStateEvent(attribute: string, value: unknown): void {
    if (attribute !== 'operatingState') {
      return;
    }

    const state = value as string;
    const newOperationalState = this.mapSmartThingsOperatingStateToMatter(state);

    if (newOperationalState !== undefined && newOperationalState !== this.currentOperationalState) {
      this.currentOperationalState = newOperationalState;
      this.pushOperationalState();
    }
  }

  private handleCleaningModeEvent(attribute: string, value: unknown): void {
    if (attribute !== 'robotCleanerCleaningMode') {
      return;
    }

    const mode = value as string;
    const newCleanMode = this.mapSmartThingsCleaningModeToMatter(mode);

    if (newCleanMode !== undefined && newCleanMode !== this.currentCleanMode) {
      this.currentCleanMode = newCleanMode;
      this.matterApi?.updateAccessoryState(this.context!.deviceId, MatterClusterNames.RvcCleanMode, {
        currentMode: newCleanMode,
      });
    }
  }

  private handleTurboModeEvent(attribute: string, value: unknown): void {
    if (attribute !== 'robotCleanerTurboMode') {
      return;
    }

    const mode = value as string;
    if (mode === 'on') {
      this.currentCleanMode = MatterRvcCleanMode.CurrentMode.TURBO;
    } else if (mode === 'off') {
      this.currentCleanMode = MatterRvcCleanMode.CurrentMode.AUTO;
    }
    this.matterApi?.updateAccessoryState(this.context!.deviceId, MatterClusterNames.RvcCleanMode, {
      currentMode: this.currentCleanMode,
    });
  }

  private handleMovementEvent(attribute: string, value: unknown): void {
    if (attribute !== 'robotCleanerMovement') {
      return;
    }

    const mode = value as string;
    const newRunMode = this.mapSmartThingsMovementToMatter(mode);

    if (newRunMode !== undefined && newRunMode !== this.currentRunMode) {
      this.currentRunMode = newRunMode;
      this.matterApi?.updateAccessoryState(this.context!.deviceId, MatterClusterNames.RvcRunMode, {
        currentMode: newRunMode,
      });
    }
  }

  private handleBatteryEvent(attribute: string, value: unknown): void {
    if (attribute !== 'battery') {
      return;
    }

    const level = value as number;
    if (typeof level === 'number' && level !== this.currentBatteryLevel) {
      this.currentBatteryLevel = Math.max(0, Math.min(100, level));
      this.matterApi?.updateAccessoryState(this.context!.deviceId, MatterClusterNames.PowerSource, {
        batChargeLevel: this.batteryLevelToMatterEnum(this.currentBatteryLevel),
      });
    }
  }

  /**
   * Convert 0-100 battery percentage to Matter PowerSource.BatChargeLevel enum
   * 0 = OK, 1 = Warning, 2 = Critical
   */
  private batteryLevelToMatterEnum(level: number): number {
    if (level >= 50) {
      return MatterPowerSource.BatChargeLevel.OK;
    } else if (level >= 20) {
      return MatterPowerSource.BatChargeLevel.WARNING;
    } else {
      return MatterPowerSource.BatChargeLevel.CRITICAL;
    }
  }

  private handleSwitchEvent(attribute: string, value: unknown): void {
    if (attribute !== 'switch') {
      return;
    }

    const state = value as string;
    const powerOn = state === 'on';
    if (powerOn !== this.currentPowerOn) {
      this.currentPowerOn = powerOn;
      this.matterApi?.updateAccessoryState(this.context!.deviceId, MatterClusterNames.OnOff, {
        onOff: powerOn,
      });
      this.updateOperationalStateFromPower(powerOn);
    }
  }

  private mapSmartThingsOperatingStateToMatter(state: string): number | undefined {
    const stateMap: Record<string, number> = {
      stopped: MatterRvcOperationalState.OperationalState.STOPPED,
      running: MatterRvcOperationalState.OperationalState.RUNNING,
      paused: MatterRvcOperationalState.OperationalState.PAUSED,
      seekingCharger: MatterRvcOperationalState.OperationalState.SEEKING_CHARGER,
      charging: MatterRvcOperationalState.OperationalState.CHARGING,
      docked: MatterRvcOperationalState.OperationalState.DOCKED,
      unableToStartOrResume: MatterRvcOperationalState.OperationalState.ERROR,
      unableToCompleteOperation: MatterRvcOperationalState.OperationalState.ERROR,
      commandInvalidInState: MatterRvcOperationalState.OperationalState.ERROR,
      failedToFindChargingDock: MatterRvcOperationalState.OperationalState.ERROR,
      stuck: MatterRvcOperationalState.OperationalState.ERROR,
      dustBinMissing: MatterRvcOperationalState.OperationalState.ERROR,
      dustBinFull: MatterRvcOperationalState.OperationalState.ERROR,
      waterTankEmpty: MatterRvcOperationalState.OperationalState.ERROR,
      waterTankMissing: MatterRvcOperationalState.OperationalState.ERROR,
      waterTankLidOpen: MatterRvcOperationalState.OperationalState.ERROR,
      mopCleaningPadMissing: MatterRvcOperationalState.OperationalState.ERROR,
    };
    return stateMap[state];
  }

  private mapSmartThingsCleaningModeToMatter(mode: string): number | undefined {
    const modeMap: Record<string, number> = {
      auto: MatterRvcCleanMode.CurrentMode.AUTO,
      quick: MatterRvcCleanMode.CurrentMode.QUICK,
      quiet: MatterRvcCleanMode.CurrentMode.QUIET,
      deep: MatterRvcCleanMode.CurrentMode.DEEP,
      spot: MatterRvcCleanMode.CurrentMode.SPOT,
      manual: MatterRvcCleanMode.CurrentMode.MANUAL,
      edge: MatterRvcCleanMode.CurrentMode.EDGE,
      zone: MatterRvcCleanMode.CurrentMode.ZONE,
      map: MatterRvcCleanMode.CurrentMode.MAP,
      selectiveRoom: MatterRvcCleanMode.CurrentMode.SELECTIVE_ROOM,
      thorough: MatterRvcCleanMode.CurrentMode.THOROUGH,
      turbo: MatterRvcCleanMode.CurrentMode.TURBO,
    };
    return modeMap[mode.toLowerCase()];
  }

  private mapMatterCleanModeToSmartThings(mode: number): string | null {
    const modeMap: Record<number, string> = {
      [MatterRvcCleanMode.SupportedModes.AUTO]: 'auto',
      [MatterRvcCleanMode.SupportedModes.QUIET]: 'quiet',
      [MatterRvcCleanMode.SupportedModes.DEEP]: 'deep',
      [MatterRvcCleanMode.SupportedModes.SPOT]: 'spot',
      [MatterRvcCleanMode.SupportedModes.TURBO]: 'turbo',
    };
    return modeMap[mode] || null;
  }

  private mapSmartThingsMovementToMatter(mode: string): number | undefined {
    const modeMap: Record<string, number> = {
      vacuum: MatterRvcRunMode.CurrentMode.VACUUM,
      mop: MatterRvcRunMode.CurrentMode.MOP,
      vacuumAndMop: MatterRvcRunMode.CurrentMode.VACUUM_AND_MOP,
      sweep: MatterRvcRunMode.CurrentMode.SWEEP,
    };
    return modeMap[mode.toLowerCase()];
  }

  private mapMatterRunModeToSmartThings(mode: number): string | null {
    const modeMap: Record<number, string> = {
      [MatterRvcRunMode.SupportedModes.VACUUM]: 'vacuum',
      [MatterRvcRunMode.SupportedModes.MOP]: 'mop',
      [MatterRvcRunMode.SupportedModes.VACUUM_AND_MOP]: 'vacuumAndMop',
      [MatterRvcRunMode.SupportedModes.SWEEP]: 'sweep',
    };
    return modeMap[mode] || null;
  }

  getInitialState(): NormalizedMatterState {
    const status = this.getDeviceStatus() as SmartThingsRobotVacuumStatus;
    const main = status.main || {};

    // Check both standard and samsungce capabilities
    const operatingState = main.robotCleanerOperatingState ?? main['samsungce.robotCleanerOperatingState'];
    const cleaningMode = main.robotCleanerCleaningMode ?? main['samsungce.robotCleanerCleaningMode'];
    const turboMode = main.robotCleanerTurboMode ?? main['samsungce.robotCleanerTurboMode'];
    const movement = main.robotCleanerMovement ?? main['samsungce.robotCleanerMovement'];

    if (operatingState?.operatingState?.value) {
      const mapped = this.mapSmartThingsOperatingStateToMatter(operatingState.operatingState.value);
      if (mapped !== undefined) {
        this.currentOperationalState = mapped;
      }
    }

    if (cleaningMode?.robotCleanerCleaningMode?.value) {
      const mapped = this.mapSmartThingsCleaningModeToMatter(cleaningMode.robotCleanerCleaningMode.value);
      if (mapped !== undefined) {
        this.currentCleanMode = mapped;
      }
    }

    if (turboMode?.robotCleanerTurboMode?.value) {
      const turbo = turboMode.robotCleanerTurboMode.value;
      this.currentCleanMode = turbo === 'on' ? MatterRvcCleanMode.CurrentMode.TURBO : MatterRvcCleanMode.CurrentMode.AUTO;
    }

    if (movement?.robotCleanerMovement?.value) {
      const mapped = this.mapSmartThingsMovementToMatter(movement.robotCleanerMovement.value);
      if (mapped !== undefined) {
        this.currentRunMode = mapped;
      }
    }

    if (main.battery?.battery?.value !== undefined) {
      this.currentBatteryLevel = Math.max(0, Math.min(100, main.battery.battery.value));
    }

    if (main.switch?.switch?.value) {
      this.currentPowerOn = main.switch.switch.value === 'on';
      this.updateOperationalStateFromPower(this.currentPowerOn);
    }

    this.currentCharging = this.currentOperationalState === MatterRvcOperationalState.OperationalState.CHARGING;

    return {
      [MatterClusterNames.OnOff]: { onOff: this.currentPowerOn },
      [MatterClusterNames.RvcOperationalState]: {
        operationalState: this.currentOperationalState,
        operationalError: MatterRvcOperationalState.OperationalError.NO_ERROR,
      },
      [MatterClusterNames.RvcCleanMode]: { currentMode: this.currentCleanMode },
      [MatterClusterNames.RvcRunMode]: { currentMode: this.currentRunMode },
      [MatterClusterNames.PowerSource]: {
        batChargeLevel: this.batteryLevelToMatterEnum(this.currentBatteryLevel),
        batChargeState: this.currentCharging ? MatterPowerSource.BatChargeState.CHARGING : MatterPowerSource.BatChargeState.NOT_CHARGING,
        powerSource: MatterPowerSource.PowerSource.BATTERY,
      },
    };
  }
}