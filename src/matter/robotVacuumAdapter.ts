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
  'samsungce.robotCleanerOperatingState',
  'samsungce.robotCleanerCleaningMode',
  'samsungce.robotCleanerTurboMode',
  'samsungce.robotCleanerMovement',
  'samsungce.robotCleanerDrivingMode',
  'samsungce.robotCleanerCleaningType',
  'audioNotification',
  'battery',
  'switch',
] as const;

type SmartThingsRobotVacuumCapability = typeof SMARTTHINGS_ROBOT_VACUUM_CAPABILITIES[number];

interface SamsungRobotCleanerOperatingState {
  operatingState?: {
    value: string;
  };
  supportedOperatingState?: {
    value: string[];
  };
  supportedCommands?: {
    value: string[];
  };
}

interface SamsungRobotCleanerCleaningMode {
  robotCleanerCleaningMode?: {
    value: string;
  };
  supportedRobotCleanerCleaningModes?: {
    value: string[];
  };
}

interface SamsungRobotCleanerDrivingMode {
  drivingMode?: {
    value: string;
  };
  supportedDrivingModes?: {
    value: string[];
  };
}

interface SamsungRobotCleanerCleaningType {
  cleaningType?: {
    value: string;
  };
  supportedCleaningTypes?: {
    value: string[];
  };
  availableCleaningTypes?: {
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
  supportedRobotCleanerMovements?: {
    value: string[];
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
    'samsungce.robotCleanerOperatingState'?: SamsungRobotCleanerOperatingState;
    'samsungce.robotCleanerCleaningMode'?: SamsungRobotCleanerCleaningMode;
    'samsungce.robotCleanerTurboMode'?: RobotCleanerTurboMode;
    'samsungce.robotCleanerMovement'?: RobotCleanerMovement;
    'samsungce.robotCleanerDrivingMode'?: SamsungRobotCleanerDrivingMode;
    'samsungce.robotCleanerCleaningType'?: SamsungRobotCleanerCleaningType;
    audioNotification?: any;
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
  private currentRunMode: number = MatterRvcRunMode.CurrentMode.IDLE;
  private currentBatteryLevel = 100;
  private currentCharging = false;
  private currentPowerOn = false;

  private supportedOperatingCommands: string[] = [];

  private supportedCleaningModes: string[] = [];

  private supportedMovements: string[] = [];

  constructor(platform: API, log: Logger, multiServiceAccessory: MultiServiceAccessory) {
    super(platform, log, multiServiceAccessory);
    this.matterApi = (platform as any).matter || null;
    this.log.info(`[RobotVacuumAdapter] Constructor: currentRunMode=${this.currentRunMode}, currentOperationalState=${this.currentOperationalState}`);
  }

  protected async setupMatterAccessory(): Promise<void> {
    if (!this.matterApi || !this.accessory || !this.context) {
      this.log.warn('[RobotVacuumAdapter] Matter API not available or accessory not initialized');
      return;
    }

    this.log.info(`[RobotVacuumAdapter] setupMatterAccessory: currentRunMode=${this.currentRunMode}, currentOperationalState=${this.currentOperationalState}`);

    try {
      const uuid = this.accessory.UUID;

      // Register with proper cluster configurations matching Homebridge Matter API interfaces
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
          onOff: {
            onOff: this.currentPowerOn,
          },
          identify: {
            identifyTime: 0,
          },
          // rvcOperationalState: operationalStateList must include Error state, no labels for standard states
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
          },
          // rvcCleanMode: supportedModes with Vacuum/Mop mode tags (RVC namespace: Vacuum=16385, Mop=16386, VacuumThenMop=16387)
          rvcCleanMode: {
            currentMode: this.currentCleanMode,
            supportedModes: [
              { mode: MatterRvcCleanMode.SupportedModes.AUTO, label: 'Auto', modeTags: [{ value: MatterRvcCleanMode.ModeTag.VACUUM }] },
              { mode: MatterRvcCleanMode.SupportedModes.QUIET, label: 'Quiet', modeTags: [{ value: MatterRvcCleanMode.ModeTag.VACUUM }] },
              { mode: MatterRvcCleanMode.SupportedModes.DEEP, label: 'Deep', modeTags: [{ value: MatterRvcCleanMode.ModeTag.VACUUM }, { value: MatterRvcCleanMode.ModeTag.VACUUM_THEN_MOP }] },
              { mode: MatterRvcCleanMode.SupportedModes.SPOT, label: 'Spot', modeTags: [{ value: MatterRvcCleanMode.ModeTag.VACUUM }] },
              { mode: MatterRvcCleanMode.SupportedModes.TURBO, label: 'Turbo', modeTags: [{ value: MatterRvcCleanMode.ModeTag.VACUUM }] },
            ],
          },
          // rvcRunMode: need at least one Idle tag (16384) and one Cleaning tag (16385), mutually exclusive
          rvcRunMode: {
            currentMode: this.currentRunMode,
            supportedModes: [
              { mode: MatterRvcRunMode.SupportedModes.IDLE, label: 'Idle', modeTags: [{ value: MatterRvcRunMode.ModeTag.IDLE }] },
              { mode: MatterRvcRunMode.SupportedModes.VACUUM, label: 'Vacuum', modeTags: [{ value: MatterRvcRunMode.ModeTag.CLEANING }] },
              { mode: MatterRvcRunMode.SupportedModes.MOP, label: 'Mop', modeTags: [{ value: MatterRvcRunMode.ModeTag.CLEANING }] },
              { mode: MatterRvcRunMode.SupportedModes.VACUUM_AND_MOP, label: 'Vacuum and Mop', modeTags: [{ value: MatterRvcRunMode.ModeTag.CLEANING }] },
            ],
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
        handlers: {
          onOff: {
            on: async () => {
              await this.handleOnOffCommand('on');
            },
            off: async () => {
              await this.handleOnOffCommand('off');
            },
            toggle: async () => {
              await this.handleOnOffCommand(this.currentPowerOn ? 'off' : 'on');
            },
          },
          rvcOperationalState: {
            start: async () => {
              await this.handleOperationalStateCommand('start');
            },
            pause: async () => {
              await this.handleOperationalStateCommand('pause');
            },
            resume: async () => {
              await this.handleOperationalStateCommand('start');
            },
            goHome: async () => {
              await this.handleOperationalStateCommand('goHome');
            },
          },
          identify: {
            identify: async (args: { identifyTime?: number }) => {
              await this.handleIdentifyCommand(args.identifyTime ?? 10);
            },
            triggerEffect: async (args: { effectId: number; effectVariant?: number }) => {
              await this.handleTriggerEffectCommand(args.effectId);
            },
          },
          rvcCleanMode: {
            changeToMode: async (args: { newMode: number }) => {
              await this.handleCleanModeCommand('changeToMode', [args.newMode]);
            },
          },
          rvcRunMode: {
            changeToMode: async (args: { newMode: number }) => {
              await this.handleRunModeCommand('changeToMode', [args.newMode]);
            },
          },
        },
      }]);

      this.log.info(`[RobotVacuumAdapter] Registered Matter accessory: ${this.context.label} (${uuid})`);
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
    this.log.info(`[RobotVacuumAdapter] handleOperationalStateCommand called: command=${command}`);
    let success = false;

    switch (command) {
      case 'start': {
        // Samsung: use start or setOperatingState with 'cleaning'
        const capability = 'samsungce.robotCleanerOperatingState';
        const commands = ['start', 'setOperatingState'];
        
        for (const cmd of commands) {
          this.log.info(`[RobotVacuumAdapter] Trying start command: ${capability}.${cmd}`);
          let cmdSuccess = false;
          
          if (cmd === 'start') {
            cmdSuccess = await this.sendSmartThingsCommand('main', capability, 'start');
          } else if (cmd === 'setOperatingState') {
            cmdSuccess = await this.sendSmartThingsCommand('main', capability, 'setOperatingState', ['cleaning']);
          }
          
          if (cmdSuccess) {
            this.log.info(`[RobotVacuumAdapter] Start succeeded with command: ${capability}.${cmd}`);
            success = true;
            break;
          }
        }
        if (success) {
          this.currentOperationalState = MatterRvcOperationalState.OperationalState.RUNNING;
        }
        break;
      }
      case 'resume': {
        // Resume after pause
        const capability = 'samsungce.robotCleanerOperatingState';
        const commands = ['resume', 'setOperatingState'];
        
        for (const cmd of commands) {
          this.log.info(`[RobotVacuumAdapter] Trying resume command: ${capability}.${cmd}`);
          let cmdSuccess = false;
          
          if (cmd === 'resume') {
            cmdSuccess = await this.sendSmartThingsCommand('main', capability, 'resume');
          } else if (cmd === 'setOperatingState') {
            cmdSuccess = await this.sendSmartThingsCommand('main', capability, 'setOperatingState', ['cleaning']);
          }
          
          if (cmdSuccess) {
            this.log.info(`[RobotVacuumAdapter] Resume succeeded with command: ${capability}.${cmd}`);
            success = true;
            break;
          }
        }
        if (success) {
          this.currentOperationalState = MatterRvcOperationalState.OperationalState.RUNNING;
        }
        break;
      }
      case 'pause': {
        const capability = 'samsungce.robotCleanerOperatingState';
        const commands = ['pause', 'setOperatingState'];
        
        for (const cmd of commands) {
          this.log.info(`[RobotVacuumAdapter] Trying pause command: ${capability}.${cmd}`);
          let cmdSuccess = false;
          
          if (cmd === 'pause') {
            cmdSuccess = await this.sendSmartThingsCommand('main', capability, 'pause');
          } else if (cmd === 'setOperatingState') {
            cmdSuccess = await this.sendSmartThingsCommand('main', capability, 'setOperatingState', ['paused']);
          }
          
          if (cmdSuccess) {
            this.log.info(`[RobotVacuumAdapter] Pause succeeded with command: ${capability}.${cmd}`);
            success = true;
            break;
          }
        }
        if (success) {
          this.currentOperationalState = MatterRvcOperationalState.OperationalState.PAUSED;
        }
        break;
      }
      case 'on': {
        // Home app might send 'on' command via OnOff cluster
        this.log.info(`[RobotVacuumAdapter] Received 'on' command, treating as start`);
        const capability = 'samsungce.robotCleanerOperatingState';
        const commands = ['start', 'setOperatingState'];
        
        for (const cmd of commands) {
          this.log.info(`[RobotVacuumAdapter] Trying start command (from 'on'): ${capability}.${cmd}`);
          let cmdSuccess = false;
          
          if (cmd === 'start') {
            cmdSuccess = await this.sendSmartThingsCommand('main', capability, 'start');
          } else if (cmd === 'setOperatingState') {
            cmdSuccess = await this.sendSmartThingsCommand('main', capability, 'setOperatingState', ['cleaning']);
          }
          
          if (cmdSuccess) {
            this.log.info(`[RobotVacuumAdapter] Start (from 'on') succeeded with command: ${capability}.${cmd}`);
            success = true;
            break;
          }
        }
        if (success) {
          this.currentOperationalState = MatterRvcOperationalState.OperationalState.RUNNING;
        }
        break;
      }
      case 'goHome':
      case 'stop': {
        // Samsung: use returnToHome command on samsungce.robotCleanerOperatingState
        const capability = 'samsungce.robotCleanerOperatingState';
        const cmd = 'returnToHome';
        
        this.log.info(`[RobotVacuumAdapter] Trying goHome command: ${capability}.${cmd}`);
        success = await this.sendSmartThingsCommand('main', capability, cmd);
        
        if (success) {
          this.log.info(`[RobotVacuumAdapter] GoHome succeeded with command: ${capability}.${cmd}`);
          this.currentOperationalState = MatterRvcOperationalState.OperationalState.SEEKING_CHARGER;
        } else {
          this.log.warn(`[RobotVacuumAdapter] GoHome failed with command: ${capability}.${cmd}`);
        }
        break;
      }
      default:
        this.log.info(`[RobotVacuumAdapter] Unknown operational state command: ${command}`);
        return false;
    }

    if (success) {
      this.pushOperationalState();
    }
    return success;
  }

  private async handleIdentifyCommand(identifyTime: number): Promise<boolean> {
    this.log.info(`[RobotVacuumAdapter] Identify command received, time: ${identifyTime}s`);
    // Samsung robot vacuum locate/find uses audioNotification capability
    const capability = 'audioNotification';
    const cmd = 'playSound';
    
    this.log.info(`[RobotVacuumAdapter] Trying locate command: ${capability}.${cmd}`);
    const success = await this.sendSmartThingsCommand('main', capability, cmd);
    if (success) {
      this.log.info(`[RobotVacuumAdapter] Locate succeeded with command: ${capability}.${cmd}`);
      return true;
    }
    
    this.log.warn('[RobotVacuumAdapter] Locate command failed - device may not support this feature');
    return false;
  }

  private async handleTriggerEffectCommand(effectId: number): Promise<boolean> {
    this.log.info(`[RobotVacuumAdapter] TriggerEffect command received, effectId: ${effectId}`);
    // Effect ID 0 = blink, 1 = breathe, 2 = okay, 3 = channel change, 4 = finish effect, 5 = stop effect
    // For robot vacuum locate, we typically use a custom effect or the locate command
    return this.handleIdentifyCommand(10);
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

    // Check if mode is supported by device
    if (this.supportedCleaningModes.length > 0 && !this.supportedCleaningModes.includes(smartThingsMode)) {
      this.log.warn(`[RobotVacuumAdapter] Cleaning mode ${smartThingsMode} not supported by device. Supported: ${this.supportedCleaningModes.join(', ')}`);
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
    this.log.info(`[RobotVacuumAdapter] handleRunModeCommand called: command=${command}, args=${JSON.stringify(args)}`);
    if (command !== 'changeToMode' || !args || args.length === 0) {
      this.log.warn(`[RobotVacuumAdapter] handleRunModeCommand invalid args: command=${command}, args=${JSON.stringify(args)}`);
      return false;
    }

    const mode = args[0] as number;
    const smartThingsMode = this.mapMatterRunModeToSmartThings(mode);

    if (!smartThingsMode) {
      this.log.warn(`[RobotVacuumAdapter] Unsupported Matter run mode: ${mode}`);
      return false;
    }

    // Check if mode is supported by device
    if (this.supportedMovements.length > 0 && !this.supportedMovements.includes(smartThingsMode)) {
      this.log.warn(`[RobotVacuumAdapter] Movement mode ${smartThingsMode} not supported by device. Supported: ${this.supportedMovements.join(', ')}`);
      return false;
    }

    // Matter spec: ChangeToMode with CLEANING tag mode should start cleaning
    // First change the movement mode
    this.log.info(`[RobotVacuumAdapter] Trying setRobotCleanerMovement: ${smartThingsMode} (Matter mode: ${mode})`);
    const success = await this.sendSmartThingsCommand('main', 'samsungce.robotCleanerMovement', 'setRobotCleanerMovement', [smartThingsMode]);
    
    if (success) {
      this.currentRunMode = mode;
      this.matterApi?.updateAccessoryState(this.context!.deviceId, MatterClusterNames.RvcRunMode, { currentMode: mode });
      this.log.info(`[RobotVacuumAdapter] setRobotCleanerMovement succeeded: ${smartThingsMode}`);
      
      // Matter spec: ChangeToMode with CLEANING tag should start cleaning
      // Send start command to actually begin cleaning
      this.log.info(`[RobotVacuumAdapter] Trying start command after RunMode change`);
      const startSuccess = await this.sendSmartThingsCommand('main', 'samsungce.robotCleanerOperatingState', 'start');
      if (startSuccess) {
        this.log.info(`[RobotVacuumAdapter] RunMode changeToMode -> started cleaning via start command`);
        this.currentOperationalState = MatterRvcOperationalState.OperationalState.RUNNING;
        this.pushOperationalState();
      } else {
        this.log.warn(`[RobotVacuumAdapter] RunMode changed but failed to start cleaning (start command failed)`);
      }
    } else {
      this.log.warn(`[RobotVacuumAdapter] setRobotCleanerMovement FAILED: ${smartThingsMode} (Matter mode: ${mode}) - command returned false`);
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

    // Log all events to understand device capabilities - ALWAYS AT INFO LEVEL
    this.log.info(`[RobotVacuumAdapter] Event: ${capability}.${attribute} = ${JSON.stringify(value)}`);

    switch (capability) {
      case 'samsungce.robotCleanerOperatingState':
        this.handleOperatingStateEvent(attribute, value);
        break;
      case 'samsungce.robotCleanerCleaningMode':
        this.handleCleaningModeEvent(attribute, value);
        break;
      case 'samsungce.robotCleanerTurboMode':
        this.handleTurboModeEvent(attribute, value);
        break;
      case 'samsungce.robotCleanerMovement':
        this.handleMovementEvent(attribute, value);
        break;
      case 'samsungce.robotCleanerDrivingMode':
        this.handleDrivingModeEvent(attribute, value);
        break;
      case 'samsungce.robotCleanerCleaningType':
        this.handleCleaningTypeEvent(attribute, value);
        break;
      case 'audioNotification':
        this.handleAudioNotificationEvent(attribute, value);
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
    // Log ALL attributes for this capability to see what device sends
    this.log.info(`[RobotVacuumAdapter] OperatingState attr: ${attribute} = ${JSON.stringify(value)}`);
    
    if (attribute === 'supportedOperatingStates') {
      const states = value as string[];
      this.log.info(`[RobotVacuumAdapter] Supported operating states: ${states.join(', ')}`);
      return;
    }
    if (attribute === 'supportedCommands') {
      this.supportedOperatingCommands = value as string[];
      this.log.info(`[RobotVacuumAdapter] Supported operating commands: ${this.supportedOperatingCommands.join(', ')}`);
      return;
    }
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
    // Log ALL attributes for this capability to see what device sends
    this.log.info(`[RobotVacuumAdapter] CleaningMode attr: ${attribute} = ${JSON.stringify(value)}`);
    
    if (attribute === 'supportedRobotCleanerCleaningModes') {
      this.supportedCleaningModes = value as string[];
      this.log.info(`[RobotVacuumAdapter] Supported cleaning modes: ${this.supportedCleaningModes.join(', ')}`);
      return;
    }
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
    // Log ALL attributes for this capability to see what device sends
    this.log.info(`[RobotVacuumAdapter] Movement attr: ${attribute} = ${JSON.stringify(value)}`);
    
    if (attribute === 'supportedRobotCleanerMovements') {
      this.supportedMovements = value as string[];
      this.log.info(`[RobotVacuumAdapter] Supported movements: ${this.supportedMovements.join(', ')}`);
      return;
    }
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

  private handleDrivingModeEvent(attribute: string, value: unknown): void {
    this.log.info(`[RobotVacuumAdapter] DrivingMode attr: ${attribute} = ${JSON.stringify(value)}`);
    
    if (attribute === 'supportedDrivingModes') {
      const modes = value as string[];
      this.log.info(`[RobotVacuumAdapter] Supported driving modes: ${modes.join(', ')}`);
      return;
    }
    if (attribute !== 'drivingMode') {
      return;
    }

    const mode = value as string;
    // Map Samsung driving mode to Matter operational state
    const newOperationalState = this.mapSamsungDrivingModeToMatter(mode);
    if (newOperationalState !== undefined && newOperationalState !== this.currentOperationalState) {
      this.currentOperationalState = newOperationalState;
      this.pushOperationalState();
    }
  }

  private handleCleaningTypeEvent(attribute: string, value: unknown): void {
    this.log.info(`[RobotVacuumAdapter] CleaningType attr: ${attribute} = ${JSON.stringify(value)}`);
    
    if (attribute === 'supportedCleaningTypes' || attribute === 'availableCleaningTypes') {
      const types = value as string[];
      this.log.info(`[RobotVacuumAdapter] Supported cleaning types: ${types.join(', ')}`);
      return;
    }
    if (attribute !== 'cleaningType') {
      return;
    }

    const type = value as string;
    const newCleanMode = this.mapSamsungCleaningTypeToMatter(type);
    if (newCleanMode !== undefined && newCleanMode !== this.currentCleanMode) {
      this.currentCleanMode = newCleanMode;
      this.matterApi?.updateAccessoryState(this.context!.deviceId, MatterClusterNames.RvcCleanMode, {
        currentMode: newCleanMode,
      });
      // Also update run mode if needed (vacuum vs mop)
      const newRunMode = this.mapSamsungCleaningTypeToRunMode(type);
      if (newRunMode !== undefined && newRunMode !== this.currentRunMode) {
        this.currentRunMode = newRunMode;
        this.matterApi?.updateAccessoryState(this.context!.deviceId, MatterClusterNames.RvcRunMode, {
          currentMode: newRunMode,
        });
      }
    }
  }

  private handleAudioNotificationEvent(attribute: string, value: unknown): void {
    this.log.info(`[RobotVacuumAdapter] AudioNotification attr: ${attribute} = ${JSON.stringify(value)}`);
    // Audio notification events - could be used for locate/find me
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
      vacuumAndMop: MatterRvcCleanMode.CurrentMode.DEEP,
      'vacuum_and_mop': MatterRvcCleanMode.CurrentMode.DEEP,
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

  private mapSamsungDrivingModeToMatter(mode: string): number | undefined {
    const modeMap: Record<string, number> = {
      idle: MatterRvcOperationalState.OperationalState.STOPPED,
      standby: MatterRvcOperationalState.OperationalState.STOPPED,
      homing: MatterRvcOperationalState.OperationalState.SEEKING_CHARGER,
      cleaning: MatterRvcOperationalState.OperationalState.RUNNING,
      charging: MatterRvcOperationalState.OperationalState.CHARGING,
      chargingForRemainingJob: MatterRvcOperationalState.OperationalState.CHARGING,
      charged: MatterRvcOperationalState.OperationalState.DOCKED,
      creatingMap: MatterRvcOperationalState.OperationalState.RUNNING,
      drainingWater: MatterRvcOperationalState.OperationalState.RUNNING,
      flexCharged: MatterRvcOperationalState.OperationalState.DOCKED,
      moving: MatterRvcOperationalState.OperationalState.RUNNING,
      paused: MatterRvcOperationalState.OperationalState.PAUSED,
      error: MatterRvcOperationalState.OperationalState.ERROR,
      relocal: MatterRvcOperationalState.OperationalState.RUNNING,
      descaling: MatterRvcOperationalState.OperationalState.RUNNING,
      waitingForDescaling: MatterRvcOperationalState.OperationalState.STOPPED,
      exploring: MatterRvcOperationalState.OperationalState.RUNNING,
      emitDust: MatterRvcOperationalState.OperationalState.RUNNING,
      monitoring: MatterRvcOperationalState.OperationalState.RUNNING,
      monitoringAutomation: MatterRvcOperationalState.OperationalState.RUNNING,
      patrol: MatterRvcOperationalState.OperationalState.RUNNING,
      manual: MatterRvcOperationalState.OperationalState.RUNNING,
      processing: MatterRvcOperationalState.OperationalState.RUNNING,
      mediaPlaying: MatterRvcOperationalState.OperationalState.RUNNING,
      messaging: MatterRvcOperationalState.OperationalState.RUNNING,
      findingPet: MatterRvcOperationalState.OperationalState.RUNNING,
      reserved: MatterRvcOperationalState.OperationalState.STOPPED,
      factoryReset: MatterRvcOperationalState.OperationalState.ERROR,
      calibrating: MatterRvcOperationalState.OperationalState.RUNNING,
      welcoming: MatterRvcOperationalState.OperationalState.RUNNING,
      detachingMopPad: MatterRvcOperationalState.OperationalState.STOPPED,
      waitingForChangingMopPad: MatterRvcOperationalState.OperationalState.STOPPED,
      attachingMopPad: MatterRvcOperationalState.OperationalState.STOPPED,
      attachingMopPadForRemainingJob: MatterRvcOperationalState.OperationalState.STOPPED,
      washingMop: MatterRvcOperationalState.OperationalState.RUNNING,
      sterilizingMop: MatterRvcOperationalState.OperationalState.RUNNING,
      dryingMop: MatterRvcOperationalState.OperationalState.RUNNING,
      mopWashingPaused: MatterRvcOperationalState.OperationalState.PAUSED,
      spinDrying: MatterRvcOperationalState.OperationalState.RUNNING,
      preparingWater: MatterRvcOperationalState.OperationalState.RUNNING,
      supplyingWater: MatterRvcOperationalState.OperationalState.RUNNING,
      sabbath: MatterRvcOperationalState.OperationalState.STOPPED,
      powerSaving: MatterRvcOperationalState.OperationalState.STOPPED,
      suspend: MatterRvcOperationalState.OperationalState.PAUSED,
      emptyStation: MatterRvcOperationalState.OperationalState.RUNNING,
      internalWash: MatterRvcOperationalState.OperationalState.RUNNING,
      cleaningStart: MatterRvcOperationalState.OperationalState.RUNNING,
      cleaningEnd: MatterRvcOperationalState.OperationalState.STOPPED,
    };
    return modeMap[mode];
  }

  private mapSamsungCleaningTypeToMatter(type: string): number | undefined {
    const typeMap: Record<string, number> = {
      vacuum: MatterRvcCleanMode.CurrentMode.AUTO,
      mop: MatterRvcCleanMode.CurrentMode.AUTO,
      vacuumAndMopTogether: MatterRvcCleanMode.CurrentMode.DEEP,  // DEEP has VacuumThenMop tag
      mopAfterVacuum: MatterRvcCleanMode.CurrentMode.DEEP,
    };
    return typeMap[type];
  }

  private mapSamsungCleaningTypeToRunMode(type: string): number | undefined {
    const typeMap: Record<string, number> = {
      vacuum: MatterRvcRunMode.CurrentMode.VACUUM,
      mop: MatterRvcRunMode.CurrentMode.MOP,
      vacuumAndMopTogether: MatterRvcRunMode.CurrentMode.VACUUM_AND_MOP,
      mopAfterVacuum: MatterRvcRunMode.CurrentMode.VACUUM_AND_MOP,
    };
    return typeMap[type];
  }

  getInitialState(): NormalizedMatterState {
    const status = this.getDeviceStatus() as SmartThingsRobotVacuumStatus;

    // Log the FULL status to see actual structure
    this.log.info(`[RobotVacuumAdapter] FULL device status: ${JSON.stringify(status)}`);

    const main = status.main || {};

    // Log the FULL main component
    this.log.info(`[RobotVacuumAdapter] FULL main component: ${JSON.stringify(main)}`);

    // Also check ALL components in status
    for (const [compId, compData] of Object.entries(status)) {
      if (compId !== 'main') {
        this.log.info(`[RobotVacuumAdapter] Component '${compId}': ${JSON.stringify(compData)}`);
      }
    }

    // Check Samsung capabilities in main component
    let operatingState = main['samsungce.robotCleanerOperatingState'];
    let cleaningMode = main['samsungce.robotCleanerCleaningMode'];
    let turboMode = main['samsungce.robotCleanerTurboMode'];
    let movement = main['samsungce.robotCleanerMovement'];
    let drivingMode = main['samsungce.robotCleanerDrivingMode'];
    let cleaningType = main['samsungce.robotCleanerCleaningType'];

    // Search other components if not found in main
    if (!operatingState || !movement || !cleaningMode) {
      for (const [, compData] of Object.entries(status)) {
        const comp = compData as any;
        if (!operatingState) operatingState = comp['samsungce.robotCleanerOperatingState'];
        if (!cleaningMode) cleaningMode = comp['samsungce.robotCleanerCleaningMode'];
        if (!turboMode) turboMode = comp['samsungce.robotCleanerTurboMode'];
        if (!movement) movement = comp['samsungce.robotCleanerMovement'];
        if (!drivingMode) drivingMode = comp['samsungce.robotCleanerDrivingMode'];
        if (!cleaningType) cleaningType = comp['samsungce.robotCleanerCleaningType'];
        if (operatingState && cleaningMode && movement) break;
      }
    }

    // Log each capability object
    this.log.info(`[RobotVacuumAdapter] operatingState: ${JSON.stringify(operatingState)}`);
    this.log.info(`[RobotVacuumAdapter] cleaningMode: ${JSON.stringify(cleaningMode)}`);
    this.log.info(`[RobotVacuumAdapter] movement: ${JSON.stringify(movement)}`);
    this.log.info(`[RobotVacuumAdapter] turboMode: ${JSON.stringify(main['samsungce.robotCleanerTurboMode'])}`);
    this.log.info(`[RobotVacuumAdapter] drivingMode: ${JSON.stringify(drivingMode)}`);
    this.log.info(`[RobotVacuumAdapter] cleaningType: ${JSON.stringify(cleaningType)}`);

    // Capture supported commands/modes from device status
    if (operatingState?.supportedCommands?.value) {
      this.supportedOperatingCommands = operatingState.supportedCommands.value;
      this.log.info(`[RobotVacuumAdapter] Initial supported operating commands: ${this.supportedOperatingCommands.join(', ')}`);
    }
    if (cleaningMode?.supportedRobotCleanerCleaningModes?.value) {
      this.supportedCleaningModes = cleaningMode.supportedRobotCleanerCleaningModes.value;
      this.log.info(`[RobotVacuumAdapter] Initial supported cleaning modes: ${this.supportedCleaningModes.join(', ')}`);
    }
    if (movement?.supportedRobotCleanerMovements?.value) {
      this.supportedMovements = movement.supportedRobotCleanerMovements.value;
      this.log.info(`[RobotVacuumAdapter] Initial supported movements: ${this.supportedMovements.join(', ')}`);
    }
    if (drivingMode?.supportedDrivingModes?.value) {
      this.log.info(`[RobotVacuumAdapter] Initial supported driving modes: ${drivingMode.supportedDrivingModes.value.join(', ')}`);
    }
    if (cleaningType?.supportedCleaningTypes?.value) {
      this.log.info(`[RobotVacuumAdapter] Initial supported cleaning types: ${cleaningType.supportedCleaningTypes.value.join(', ')}`);
    }
    if (cleaningType?.availableCleaningTypes?.value) {
      this.log.info(`[RobotVacuumAdapter] Initial available cleaning types: ${cleaningType.availableCleaningTypes.value.join(', ')}`);
    }

    if (operatingState?.operatingState?.value) {
      const mapped = this.mapSmartThingsOperatingStateToMatter(operatingState.operatingState.value);
      if (mapped !== undefined) {
        this.currentOperationalState = mapped;
      }
    }

    if (drivingMode?.drivingMode?.value) {
      const mapped = this.mapSamsungDrivingModeToMatter(drivingMode.drivingMode.value);
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

    if (cleaningType?.cleaningType?.value) {
      const mapped = this.mapSamsungCleaningTypeToMatter(cleaningType.cleaningType.value);
      if (mapped !== undefined) {
        this.currentCleanMode = mapped;
      }
      const runMapped = this.mapSamsungCleaningTypeToRunMode(cleaningType.cleaningType.value);
      if (runMapped !== undefined) {
        this.currentRunMode = runMapped;
      }
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

    this.log.info(`[RobotVacuumAdapter] getInitialState returning: currentRunMode=${this.currentRunMode}, currentOperationalState=${this.currentOperationalState}, currentCleanMode=${this.currentCleanMode}, currentPowerOn=${this.currentPowerOn}`);

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