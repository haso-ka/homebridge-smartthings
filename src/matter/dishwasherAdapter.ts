import { API, Logger } from 'homebridge';
import { MultiServiceAccessory } from '../multiServiceAccessory';
import type { ShortEvent } from '../webhook/subscriptionHandler';
import { PLATFORM_NAME, PLUGIN_NAME } from '../settings';
import { BaseMatterAdapter } from './baseMatterAdapter';
import {
  DishwasherCourseTagMap,
  MatterAdapter,
  MatterClusterNames,
  MatterDishwasherMode,
  MatterOperationalState,
  NormalizedMatterCommand,
  NormalizedMatterState,
} from './matterTypes';

const SMARTTHINGS_DISHWASHER_CAPABILITIES = [
  'dishwasherOperatingState',
  'samsungce.dishwasherOperation',
  'samsungce.dishwasherWashingCourse',
  'samsungce.dishwasherJobState',
  'samsungce.dishwasherWashingOptions',
  'samsungce.dishwasherWashingCourseDetails',
  'custom.dishwasherOperatingProgress',
  'custom.dishwasherOperatingPercentage',
  'custom.dishwasherDelayStartTime',
  'switch',
  'samsungce.kidsLock',
  'remoteControlStatus',
  'execute',
  'powerConsumptionReport',
  'samsungce.waterConsumptionReport',
] as const;

export class DishwasherAdapter extends BaseMatterAdapter implements MatterAdapter {
  readonly deviceType = 'Dishwasher';
  readonly supportedCapabilities = [...SMARTTHINGS_DISHWASHER_CAPABILITIES];

  private matterApi: any = null;
  private currentOperationalState: number = MatterOperationalState.OperationalState.STOPPED;
  private currentPhaseList: string[] = [];
  private currentPhase: number | null = null;
  private currentCountdownTime: number | null = null;
  private currentDishwasherMode: number = 0;
  private currentSwitchOn = false;
  private currentJobState = 'none';
  private currentCourse = '';
  private supportedCourses: string[] = [];
  private scheduledJobs: Array<{ jobName: string; timeInSec: number }> = [];
  private progressPercentage = 0;
  private remainingTimeMin: number | null = null;
  private completionTime: string | null = null;
  private pollingInterval: NodeJS.Timeout | null = null;
  private lastFirmwareRevision: string | null = null;
  private lastModel: string | null = null;
  private lastManufacturer: string | null = null;
  private pollCount = 0;

  constructor(platform: API, log: Logger, multiServiceAccessory: MultiServiceAccessory) {
    super(platform, log, multiServiceAccessory);
    this.matterApi = (platform as any).matter || null;
  }

  private startPolling(): void {
    if (this.pollingInterval) return;
    const platform: any = (this.multiServiceAccessory as any).platform;
    const intervalSec = platform?.config?.matterPollingInterval;
    const intervalMs = (typeof intervalSec === 'number' ? intervalSec : 10) * 1000;
    if (intervalMs === 0) {
      this.log.info('[DishwasherAdapter] Polling disabled (matterPollingInterval=0)');
      return;
    }
    this.pollingInterval = setInterval(async () => {
      try {
        await this.multiServiceAccessory.refreshStatus();
        this.syncStateFromStatus();
        this.pushOperationalStateUpdate();
        this.pollCount++;
        if (this.pollCount % 6 === 0) {
          await this.syncBasicInformationIfChanged();
        }
      } catch (e) {
        this.log.debug(`[DishwasherAdapter] Polling refresh failed: ${e}`);
      }
    }, intervalMs);
  }

  private stopPolling(): void {
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = null;
    }
  }

  private getCapabilityStatus(capabilityId: string): any {
    for (const comp of this.multiServiceAccessory.components) {
      const status = comp.status as Record<string, any>;
      if (status && status[capabilityId]) return status[capabilityId];
    }
    const mainStatus = this.getDeviceStatus() as Record<string, any>;
    return mainStatus[capabilityId];
  }

  private getMainStatus(): Record<string, any> {
    const mainComp = this.multiServiceAccessory.components.find(c => c.componentId === 'main');
    if (mainComp?.status) return mainComp.status as Record<string, any>;
    return this.getDeviceStatus() as Record<string, any>;
  }

  protected async setupMatterAccessory(): Promise<void> {
    if (!this.matterApi || !this.accessory || !this.context) {
      this.log.warn('[DishwasherAdapter] Matter API not available or accessory not initialized');
      return;
    }

    try {
      await this.multiServiceAccessory.refreshStatus();
      this.currentState = this.getInitialState();
      this.log.info(`[DishwasherAdapter] Refreshed initial state: OpState=${this.currentOperationalState} Mode=${this.currentDishwasherMode} Phase=${this.currentPhase} Countdown=${this.currentCountdownTime}`);
    } catch (e) {
      this.log.warn(`[DishwasherAdapter] Initial refreshStatus failed: ${e}`);
    }

    const platform: any = (this.multiServiceAccessory as any).platform;
    const serverUrl = platform?.config?.server_url;
    const hasWebhook = typeof serverUrl === 'string' && serverUrl.trim() !== '';
    if (!hasWebhook) {
      this.startPolling();
      this.log.info('[DishwasherAdapter] Webhook not configured, polling enabled for state updates');
    }

    this.log.info(`[DishwasherAdapter] setupMatterAccessory: OpState=${this.currentOperationalState} Mode=${this.currentDishwasherMode} Switch=${this.currentSwitchOn}`);

    try {
      const uuid = this.accessory.UUID;
      const vendorName = this.context.manufacturerName || 'Samsung Electronics';
      const productName = this.context.label;
      const model = this.context.model || 'Samsung Dishwasher';
      const serialNumber = this.context.serialNumber || this.context.deviceId;
      const firmwareRevision = this.context.firmwareRevision || 'Unknown';
      this.log.info(`[MatterRegister] vendorName=${vendorName} model=${model} productName=${productName} serial=${serialNumber} firmware=${firmwareRevision}`);

      const operationalStateCluster = this.buildOperationalStateCluster();
      const dishwasherModeCluster = this.buildDishwasherModeCluster();

      const deviceType = this.matterApi.deviceTypes?.Dishwasher ?? this.matterApi.deviceTypes?.['Dishwasher'] ?? 0x0075;

      await this.matterApi.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [{
        UUID: uuid,
        displayName: productName,
        deviceType,
        manufacturer: vendorName,
        model,
        serialNumber,
        firmwareRevision,
        clusters: {
          basicInformation: {
            vendorName,
            productName,
            productId: 0x800B,
            vendorId: 0x10AF,
            deviceTypeId: 0x0075,
            softwareVersion: 1,
            softwareVersionString: firmwareRevision,
          },
          identify: { identifyTime: 0 },
          onOff: { onOff: this.currentSwitchOn },
          operationalState: operationalStateCluster,
          dishwasherMode: dishwasherModeCluster,
          dishwasherAlarm: {
            mask: 0,
            latch: 0,
            state: 0,
            supported: 0,
          },
        },
        handlers: {
          identify: {
            identify: async (args: { identifyTime?: number }) => {
              await this.handleIdentifyCommand(args.identifyTime ?? 10);
            },
          },
          onOff: {
            on: async () => { await this.handleOnOffCommand(true); },
            off: async () => { await this.handleOnOffCommand(false); },
            toggle: async () => { await this.handleOnOffCommand(!this.currentSwitchOn); },
          },
          operationalState: {
            start: async () => { await this.handleOperationalCommand('start'); },
            stop: async () => { await this.handleOperationalCommand('stop'); },
            pause: async () => { await this.handleOperationalCommand('pause'); },
            resume: async () => { await this.handleOperationalCommand('resume'); },
          },
          dishwasherMode: {
            changeToMode: async (args: { newMode: number }) => {
              await this.handleDishwasherModeCommand('changeToMode', [args.newMode]);
            },
          },
        },
      }]);

      this.log.info(`[DishwasherAdapter] Registered Matter accessory: ${this.context.label} (${uuid})`);
      await this.updateMatterClustersAfterRegistration();
    } catch (error) {
      this.log.error(`[DishwasherAdapter] Failed to register Matter accessory: ${error}`);
    }
  }

  private buildOperationalStateCluster(): any {
    const phaseList = this.currentPhaseList.length > 0 ? [...this.currentPhaseList] : ['washing', 'rinsing', 'drying'];
    const operationalStateList = [
      { operationalStateId: MatterOperationalState.OperationalState.STOPPED, operationalStateLabel: 'Stopped' },
      { operationalStateId: MatterOperationalState.OperationalState.RUNNING, operationalStateLabel: 'Running' },
      { operationalStateId: MatterOperationalState.OperationalState.PAUSED, operationalStateLabel: 'Paused' },
      { operationalStateId: MatterOperationalState.OperationalState.ERROR, operationalStateLabel: 'Error' },
    ];
    return {
      phaseList,
      currentPhase: this.currentPhase,
      countdownTime: this.currentCountdownTime,
      operationalStateList,
      operationalState: this.currentOperationalState,
      operationalError: { errorStateId: MatterOperationalState.OperationalError.NO_ERROR },
    };
  }

  private buildDishwasherModeCluster(): any {
    let supportedCourses = this.supportedCourses;
    if (supportedCourses.length === 0) {
      const details: any = this.getCapabilityStatus('samsungce.dishwasherWashingCourseDetails');
      const predefined = details?.predefinedCourses?.value;
      if (Array.isArray(predefined) && predefined.length > 0) {
        supportedCourses = predefined.map((c: any) => c.courseName).filter(Boolean);
      }
      if (supportedCourses.length === 0 && this.currentCourse) {
        supportedCourses = [this.currentCourse];
      }
    }
    if (supportedCourses.length === 0) {
      return { supportedModes: [], currentMode: 0 };
    }
    const supportedModes = supportedCourses.map((course, idx) => {
      const tag = DishwasherCourseTagMap[course] ?? MatterDishwasherMode.Tag.NORMAL;
      return {
        mode: idx,
        label: course,
        modeTags: [{ value: tag }],
      };
    });
    let currentMode = this.currentDishwasherMode;
    if (currentMode >= supportedModes.length) currentMode = 0;
    return {
      supportedModes,
      currentMode,
    };
  }

  private async updateMatterClustersAfterRegistration(): Promise<void> {
    if (!this.matterApi || !this.context) return;
    try {
      const op = this.buildOperationalStateCluster();
      await this.matterApi.updateAccessoryState(this.accessory!.UUID, MatterClusterNames.OperationalState, op);
      await this.matterApi.updateAccessoryState(this.accessory!.UUID, MatterClusterNames.DishwasherMode, this.buildDishwasherModeCluster());
      await this.matterApi.updateAccessoryState(this.accessory!.UUID, MatterClusterNames.OnOff, { onOff: this.currentSwitchOn });
      this.log.debug('[DishwasherAdapter] Updated Matter cluster states after registration');
    } catch (error) {
      this.log.error(`[DishwasherAdapter] Failed to update Matter cluster states: ${error}`);
    }
  }

  private pushOperationalStateUpdate(): void {
    if (!this.matterApi || !this.context) return;
    const op = this.buildOperationalStateCluster();
    this.matterApi.updateAccessoryState(this.accessory!.UUID, MatterClusterNames.OperationalState, op);
    this.matterApi.updateAccessoryState(this.accessory!.UUID, MatterClusterNames.OnOff, { onOff: this.currentSwitchOn });
  }

  protected async handleMatterCommand(command: NormalizedMatterCommand): Promise<boolean> {
    if (!this.context) return false;
    try {
      switch (command.cluster) {
        case MatterClusterNames.OnOff: return await this.handleOnOffCommand(command.command === 'on' || command.arguments?.[0] === true);
        case MatterClusterNames.OperationalState: return await this.handleOperationalCommand(command.command);
        case MatterClusterNames.DishwasherMode: return await this.handleDishwasherModeCommand(command.command, command.arguments);
        case MatterClusterNames.Identify: await this.handleIdentifyCommand(10); return true;
        default: this.log.debug(`[DishwasherAdapter] Unhandled cluster: ${command.cluster}`); return false;
      }
    } catch (error) {
      this.log.error(`[DishwasherAdapter] Error handling ${command.cluster}.${command.command}: ${error}`);
      return false;
    }
  }

  private async handleOnOffCommand(turnOn: boolean): Promise<boolean> {
    this.log.info(`[DishwasherAdapter] OnOff ${turnOn ? 'on' : 'off'} requested currentSwitch=${this.currentSwitchOn} opState=${this.currentOperationalState}`);
    if (turnOn === this.currentSwitchOn) return true;
    if (turnOn) {
      return this.handleOperationalCommand('start');
    } else {
      return this.handleOperationalCommand('stop');
    }
  }

  private async handleOperationalCommand(command: string): Promise<boolean> {
    this.log.info(`[DishwasherAdapter] Operational command ${command} opState=${this.currentOperationalState}`);
    let success = false;
    let newState = this.currentOperationalState;
    switch (command) {
      case 'start': {
        success = await this.sendDishwasherStart();
        if (success) newState = MatterOperationalState.OperationalState.RUNNING;
        break;
      }
      case 'stop': {
        success = await this.sendDishwasherStop();
        if (success) newState = MatterOperationalState.OperationalState.STOPPED;
        break;
      }
      case 'pause': {
        success = await this.sendDishwasherPause();
        if (success) newState = MatterOperationalState.OperationalState.PAUSED;
        break;
      }
      case 'resume': {
        success = await this.sendDishwasherResume();
        if (success) newState = MatterOperationalState.OperationalState.RUNNING;
        break;
      }
      default:
        this.log.error(`[DishwasherAdapter] Unknown operational command: ${command}`);
        return false;
    }
    if (success) {
      this.currentOperationalState = newState;
      this.currentSwitchOn = newState !== MatterOperationalState.OperationalState.STOPPED;
      this.pushOperationalStateUpdate();
    }
    return success;
  }

  private async handleDishwasherModeCommand(command: string, args?: unknown[]): Promise<boolean> {
    if (command !== 'changeToMode' || !args || args.length === 0) return false;
    const mode = args[0] as number;
    this.log.info(`[DishwasherAdapter] DishwasherMode changeToMode ${mode}`);
    const course = this.supportedCourses[mode];
    if (!course) {
      this.log.error(`[DishwasherAdapter] Mode ${mode} out of range (0..${this.supportedCourses.length - 1})`);
      return false;
    }
    const success = await this.sendSetWashingCourse(course);
    if (success) {
      this.currentDishwasherMode = mode;
      this.currentCourse = course;
      this.matterApi?.updateAccessoryState(this.accessory!.UUID, MatterClusterNames.DishwasherMode, { currentMode: mode });
    } else {
      this.log.error('[DishwasherAdapter] Failed to set washing course');
    }
    return success;
  }

  private async handleIdentifyCommand(identifyTime: number): Promise<boolean> {
    this.log.info(`[DishwasherAdapter] Identify ${identifyTime}s`);
    return true;
  }

  private async sendDishwasherStart(): Promise<boolean> {
    const mainStatus = this.getMainStatus();
    const remote = mainStatus['remoteControlStatus']?.remoteControlEnabled?.value;
    if (remote === 'false') {
      this.log.warn('[DishwasherAdapter] Remote control disabled, start may fail');
    }
    // Try samsungce.dishwasherOperation start first, fallback to setMachineState run
    let ok = await this.sendSmartThingsCommand('main', 'samsungce.dishwasherOperation', 'start', []);
    if (!ok) ok = await this.sendSmartThingsCommand('main', 'dishwasherOperatingState', 'setMachineState', ['run']);
    if (ok) this.log.info('[DishwasherAdapter] Start succeeded');
    else this.log.error('[DishwasherAdapter] Start failed');
    return ok;
  }

  private async sendDishwasherStop(): Promise<boolean> {
    let ok = await this.sendSmartThingsCommand('main', 'samsungce.dishwasherOperation', 'cancel', []);
    if (!ok) ok = await this.sendSmartThingsCommand('main', 'dishwasherOperatingState', 'setMachineState', ['stop']);
    if (!ok) ok = await this.sendSmartThingsCommand('main', 'samsungce.dishwasherOperation', 'setOperatingState', ['ready']);
    return ok;
  }

  private async sendDishwasherPause(): Promise<boolean> {
    let ok = await this.sendSmartThingsCommand('main', 'samsungce.dishwasherOperation', 'pause', []);
    if (!ok) ok = await this.sendSmartThingsCommand('main', 'dishwasherOperatingState', 'setMachineState', ['pause']);
    if (!ok) ok = await this.sendSmartThingsCommand('main', 'samsungce.dishwasherOperation', 'setOperatingState', ['paused']);
    return ok;
  }

  private async sendDishwasherResume(): Promise<boolean> {
    let ok = await this.sendSmartThingsCommand('main', 'samsungce.dishwasherOperation', 'resume', []);
    if (!ok) ok = await this.sendSmartThingsCommand('main', 'dishwasherOperatingState', 'setMachineState', ['run']);
    if (!ok) ok = await this.sendSmartThingsCommand('main', 'samsungce.dishwasherOperation', 'setOperatingState', ['running']);
    return ok;
  }

  private async sendSetWashingCourse(course: string): Promise<boolean> {
    this.log.info(`[DishwasherAdapter] setWashingCourse ${course}`);
    let ok = await this.sendSmartThingsCommand('main', 'samsungce.dishwasherWashingCourse', 'setWashingCourse', [course]);
    if (!ok) ok = await this.sendSmartThingsCommand('main', 'samsungce.dishwasherWashingCourse', 'setCustomCourse', [course]);
    return ok;
  }

  protected pushStateToMatter(state: NormalizedMatterState): void {
    if (!this.matterApi || !this.context) return;
    const uuid = this.accessory!.UUID;
    if (state[MatterClusterNames.OnOff]) this.matterApi.updateAccessoryState(uuid, MatterClusterNames.OnOff, state[MatterClusterNames.OnOff]);
    if (state[MatterClusterNames.OperationalState]) this.matterApi.updateAccessoryState(uuid, MatterClusterNames.OperationalState, state[MatterClusterNames.OperationalState]);
    if (state[MatterClusterNames.DishwasherMode]) this.matterApi.updateAccessoryState(uuid, MatterClusterNames.DishwasherMode, state[MatterClusterNames.DishwasherMode]);
    if (state[MatterClusterNames.DishwasherAlarm]) this.matterApi.updateAccessoryState(uuid, MatterClusterNames.DishwasherAlarm, state[MatterClusterNames.DishwasherAlarm]);
  }

  protected handleSmartThingsEvent(event: ShortEvent): void {
    const capability = event.capability as string;
    const attribute = event.attribute;
    const value = event.value;
    this.log.debug(`[DishwasherAdapter] Event ${capability}.${attribute}=${JSON.stringify(value)}`);
    switch (capability) {
      case 'samsungce.dishwasherOperation': this.handleDishwasherOperationEvent(attribute, value); break;
      case 'dishwasherOperatingState': this.handleDishwasherOperatingStateEvent(attribute, value); break;
      case 'samsungce.dishwasherWashingCourse': this.handleWashingCourseEvent(attribute, value); break;
      case 'samsungce.dishwasherJobState': this.handleJobStateEvent(attribute, value); break;
      case 'custom.dishwasherOperatingProgress': this.handleProgressEvent(attribute, value); break;
      case 'custom.dishwasherOperatingPercentage': this.handlePercentageEvent(attribute, value); break;
      case 'switch': this.handleSwitchEvent(attribute, value); break;
      case 'samsungce.kidsLock': this.log.debug(`[DishwasherAdapter] kidsLock ${value}`); break;
      case 'remoteControlStatus': this.log.debug(`[DishwasherAdapter] remoteControl ${value}`); break;
      case 'samsungce.dishwasherWashingOptions': this.log.debug(`[DishwasherAdapter] washingOptions ${attribute}=${JSON.stringify(value)}`); break;
      default: this.log.debug(`[DishwasherAdapter] Unhandled event ${capability}.${attribute}`);
    }
  }

  private handleDishwasherOperationEvent(attribute: string, value: unknown): void {
    switch (attribute) {
      case 'operatingState': {
        const mapped = this.mapSamsungOperatingStateToMatter(value as string);
        if (mapped !== undefined && mapped !== this.currentOperationalState) {
          this.currentOperationalState = mapped;
          this.pushOperationalStateUpdate();
        }
        break;
      }
      case 'remainingTime': {
        const obj: any = value;
        if (obj && typeof obj.value === 'number') {
          const unit = obj.unit || 'min';
          let mins = obj.value;
          if (unit === 'hour') mins *= 60;
          else if (unit === 'sec') mins /= 60;
          this.remainingTimeMin = mins;
          const secs = Math.round(mins * 60);
          this.currentCountdownTime = secs > 0 ? secs : null;
          if (this.currentOperationalState === MatterOperationalState.OperationalState.RUNNING) {
            this.pushOperationalStateUpdate();
          }
        } else if (typeof value === 'number') {
          this.remainingTimeMin = value;
          this.currentCountdownTime = Math.round(value * 60);
          this.pushOperationalStateUpdate();
        }
        break;
      }
      case 'progressPercentage': {
        this.progressPercentage = typeof value === 'number' ? value : parseInt(String(value), 10) || 0;
        this.updatePhaseFromProgress();
        break;
      }
      case 'supportedOperatingState':
        this.log.debug(`[DishwasherAdapter] supportedOperatingState ${JSON.stringify(value)}`);
        break;
    }
  }

  private handleDishwasherOperatingStateEvent(attribute: string, value: unknown): void {
    switch (attribute) {
      case 'machineState': {
        const mapped = this.mapMachineStateToMatter(value as string);
        if (mapped !== undefined && mapped !== this.currentOperationalState) {
          this.currentOperationalState = mapped;
          this.currentSwitchOn = value !== 'stop';
          this.pushOperationalStateUpdate();
        }
        break;
      }
      case 'dishwasherJobState': {
        this.currentJobState = value as string;
        this.updatePhaseFromJobState();
        break;
      }
      case 'completionTime': {
        this.completionTime = value as string;
        this.updateCountdownFromCompletionTime();
        break;
      }
      case 'supportedMachineStates':
        this.log.debug(`[DishwasherAdapter] supportedMachineStates ${JSON.stringify(value)}`);
        break;
    }
  }

  private handleWashingCourseEvent(attribute: string, value: unknown): void {
    if (attribute === 'supportedCourses') {
      this.supportedCourses = (value as string[]) ?? [];
      this.matterApi?.updateAccessoryState(this.accessory!.UUID, MatterClusterNames.DishwasherMode, this.buildDishwasherModeCluster());
      return;
    }
    if (attribute !== 'washingCourse') return;
    const course = value as string;
    this.currentCourse = course;
    const idx = this.supportedCourses.indexOf(course);
    if (idx >= 0 && idx !== this.currentDishwasherMode) {
      this.currentDishwasherMode = idx;
      this.matterApi?.updateAccessoryState(this.accessory!.UUID, MatterClusterNames.DishwasherMode, { currentMode: idx });
    } else if (idx === -1) {
      // course not in supported list (custom), update anyway
      this.log.debug(`[DishwasherAdapter] washingCourse ${course} not in supported list`);
    }
  }

  private handleJobStateEvent(attribute: string, value: unknown): void {
    if (attribute === 'supportedJobState' || attribute === 'scheduledJobs') {
      if (attribute === 'scheduledJobs') {
        this.scheduledJobs = (value as any[]) ?? [];
        const jobNames = this.scheduledJobs.map(j => j.jobName);
        if (jobNames.length > 0) {
          this.currentPhaseList = jobNames;
          this.updatePhaseFromJobState();
          this.matterApi?.updateAccessoryState(this.accessory!.UUID, MatterClusterNames.OperationalState, this.buildOperationalStateCluster());
        }
      }
      return;
    }
    if (attribute !== 'dishwasherJobState') return;
    this.currentJobState = value as string;
    this.updatePhaseFromJobState();
  }

  private handleProgressEvent(attribute: string, value: unknown): void {
    if (attribute !== 'dishwasherOperatingProgress') return;
    this.currentJobState = value as string;
    this.updatePhaseFromJobState();
  }

  private handlePercentageEvent(attribute: string, value: unknown): void {
    if (attribute !== 'dishwasherOperatingPercentage') return;
    this.progressPercentage = typeof value === 'number' ? value : parseInt(String(value), 10) || 0;
    this.updatePhaseFromProgress();
  }

  private handleSwitchEvent(attribute: string, value: unknown): void {
    if (attribute !== 'switch') return;
    const on = value === 'on';
    if (on !== this.currentSwitchOn) {
      this.currentSwitchOn = on;
      this.matterApi?.updateAccessoryState(this.accessory!.UUID, MatterClusterNames.OnOff, { onOff: on });
      if (!on) {
        this.currentOperationalState = MatterOperationalState.OperationalState.STOPPED;
        this.currentCountdownTime = null;
        this.currentPhase = null;
        this.pushOperationalStateUpdate();
      }
    }
  }

  private updatePhaseFromJobState(): void {
    if (this.currentPhaseList.length === 0) {
      // fallback default phases
      this.currentPhaseList = ['washing', 'rinsing', 'drying'];
    }
    // Map jobState variations to phase index: washing ->0, rinsing->1, drying->2 etc
    const lower = this.currentJobState.toLowerCase();
    let idx: number | null = null;
    for (let i = 0; i < this.currentPhaseList.length; i++) {
      if (this.currentPhaseList[i].toLowerCase() === lower) { idx = i; break; }
    }
    if (idx === null) {
      // fuzzy match
      if (lower.includes('wash') && this.currentPhaseList.some(p => p.toLowerCase().includes('wash'))) {
        idx = this.currentPhaseList.findIndex(p => p.toLowerCase().includes('wash'));
      } else if (lower.includes('rins') && this.currentPhaseList.some(p => p.toLowerCase().includes('rins'))) {
        idx = this.currentPhaseList.findIndex(p => p.toLowerCase().includes('rins'));
      } else if (lower.includes('dry') && this.currentPhaseList.some(p => p.toLowerCase().includes('dry'))) {
        idx = this.currentPhaseList.findIndex(p => p.toLowerCase().includes('dry'));
      } else if (lower === 'none' || lower === 'finished' || lower === 'ready' || lower === 'delaywashing') {
        idx = null;
      }
    }
    if (idx !== this.currentPhase) {
      this.currentPhase = idx;
      this.pushOperationalStateUpdate();
    }
  }

  private updatePhaseFromProgress(): void {
    // if scheduledJobs not available, infer phase via progress percentage
    if (this.scheduledJobs.length === 0) return;
    // scheduledJobs have timeInSec, compute cumulative
    const total = this.scheduledJobs.reduce((s, j) => s + (j.timeInSec || 0), 0);
    if (total === 0) return;
    const progressed = (this.progressPercentage / 100) * total;
    let cum = 0;
    for (let i = 0; i < this.scheduledJobs.length; i++) {
      cum += this.scheduledJobs[i].timeInSec;
      if (progressed < cum) {
        if (this.currentPhase !== i) {
          this.currentPhase = i;
          this.pushOperationalStateUpdate();
        }
        return;
      }
    }
    if (this.currentPhase !== this.scheduledJobs.length - 1) {
      this.currentPhase = this.scheduledJobs.length - 1;
      this.pushOperationalStateUpdate();
    }
  }

  private updateCountdownFromCompletionTime(): void {
    if (!this.completionTime) {
      this.currentCountdownTime = this.remainingTimeMin !== null ? Math.round(this.remainingTimeMin * 60) : null;
    } else {
      const parsed = Date.parse(this.completionTime);
      if (!isNaN(parsed)) {
        const secs = Math.max(0, Math.floor((parsed - Date.now()) / 1000));
        this.currentCountdownTime = secs > 0 ? Math.min(secs, 259200) : null;
      }
    }
    this.pushOperationalStateUpdate();
  }

  private mapSamsungOperatingStateToMatter(state: string): number | undefined {
    const map: Record<string, number> = {
      ready: MatterOperationalState.OperationalState.STOPPED,
      idle: MatterOperationalState.OperationalState.STOPPED,
      running: MatterOperationalState.OperationalState.RUNNING,
      paused: MatterOperationalState.OperationalState.PAUSED,
      error: MatterOperationalState.OperationalState.ERROR,
    };
    return map[state];
  }

  private mapMachineStateToMatter(state: string): number | undefined {
    const map: Record<string, number> = {
      stop: MatterOperationalState.OperationalState.STOPPED,
      run: MatterOperationalState.OperationalState.RUNNING,
      pause: MatterOperationalState.OperationalState.PAUSED,
      error: MatterOperationalState.OperationalState.ERROR,
    };
    return map[state];
  }

  private syncStateFromStatus(): void {
    // operatingState and machineState will update operationalState via handle methods in getInitialState
    // For polling sync we re-parse similar to getInitialState but without rebuilding supported lists
    const opStateStatus: any = this.getCapabilityStatus('samsungce.dishwasherOperation');
    const machineStatus: any = this.getCapabilityStatus('dishwasherOperatingState');
    const courseStatus: any = this.getCapabilityStatus('samsungce.dishwasherWashingCourse');
    const jobStatus: any = this.getCapabilityStatus('samsungce.dishwasherJobState');
    const switchStatus: any = this.getCapabilityStatus('switch');

    if (opStateStatus?.operatingState?.value) {
      const mapped = this.mapSamsungOperatingStateToMatter(opStateStatus.operatingState.value);
      if (mapped !== undefined) this.currentOperationalState = mapped;
    } else if (machineStatus?.machineState?.value) {
      const mapped = this.mapMachineStateToMatter(machineStatus.machineState.value);
      if (mapped !== undefined) this.currentOperationalState = mapped;
    }

    if (switchStatus?.switch?.value) {
      this.currentSwitchOn = switchStatus.switch.value === 'on';
    }

    if (courseStatus?.washingCourse?.value) {
      this.currentCourse = courseStatus.washingCourse.value;
      const idx = this.supportedCourses.indexOf(this.currentCourse);
      if (idx >= 0) this.currentDishwasherMode = idx;
    }

    if (jobStatus?.dishwasherJobState?.value) {
      this.currentJobState = jobStatus.dishwasherJobState.value;
    } else if (machineStatus?.dishwasherJobState?.value) {
      this.currentJobState = machineStatus.dishwasherJobState.value;
    }

    if (opStateStatus?.remainingTime?.value !== undefined) {
      const rt: any = opStateStatus.remainingTime.value;
      const unit: string = opStateStatus.remainingTime.unit || 'min';
      let mins = typeof rt === 'number' ? rt : rt.value ?? rt;
      if (typeof mins === 'number') {
        if (unit === 'hour') mins *= 60;
        else if (unit === 'sec') mins /= 60;
        this.remainingTimeMin = mins;
        this.currentCountdownTime = mins > 0 ? Math.round(mins * 60) : null;
      }
    } else if (machineStatus?.completionTime?.value) {
      this.completionTime = machineStatus.completionTime.value;
      if (this.completionTime) {
        const parsed = Date.parse(this.completionTime);
        if (!isNaN(parsed)) {
          const secs = Math.max(0, Math.floor((parsed - Date.now()) / 1000));
          this.currentCountdownTime = secs > 0 ? Math.min(secs, 259200) : null;
        }
      }
    }

    if (jobStatus?.scheduledJobs?.value) {
      this.scheduledJobs = jobStatus.scheduledJobs.value;
      const jobNames = this.scheduledJobs.map(j => j.jobName);
      if (jobNames.length > 0) this.currentPhaseList = jobNames;
    }

    if (opStateStatus?.progressPercentage?.value !== undefined) {
      this.progressPercentage = opStateStatus.progressPercentage.value;
    }

    this.updatePhaseFromJobState();
  }

  private async syncBasicInformationIfChanged(): Promise<void> {
    if (!this.matterApi || !this.accessory || !this.context) return;
    try {
      const platform: any = (this.multiServiceAccessory as any).platform;
      const axInstance = platform?.axInstance;
      if (!axInstance || !this.context.deviceId) return;
      const res = await axInstance.get(`devices/${this.context.deviceId}`);
      const device = res.data;
      const ocf = device?.ocf || {};
      const manufacturer = device?.manufacturerName || device?.mnmn || ocf.manufacturerName || 'Samsung Electronics';
      const model = device?.modelNumber || device?.modelName || ocf.modelNumber || device?.vid || 'Samsung Dishwasher';
      const firmware = device?.firmwareVersion || ocf.firmwareVersion || ocf.mnfv || 'Unknown';
      const serial = device?.deviceId || this.context.deviceId;
      if (this.lastManufacturer === null) this.lastManufacturer = this.context.manufacturerName || null;
      if (this.lastModel === null) this.lastModel = this.context.model || null;
      if (this.lastFirmwareRevision === null) this.lastFirmwareRevision = this.context.firmwareRevision || null;
      const changed = manufacturer !== this.lastManufacturer || model !== this.lastModel || firmware !== this.lastFirmwareRevision;
      if (!changed) return;
      this.log.info(`[DishwasherAdapter] BasicInformation changed: manufacturer ${this.lastManufacturer}->${manufacturer}, model ${this.lastModel}->${model}, firmware ${this.lastFirmwareRevision}->${firmware}`);
      this.lastManufacturer = manufacturer;
      this.lastModel = model;
      this.lastFirmwareRevision = firmware;
      this.context.manufacturerName = manufacturer;
      this.context.model = model;
      this.context.firmwareRevision = firmware;
      this.context.serialNumber = serial;
      await this.matterApi.updateAccessoryState(this.accessory.UUID, MatterClusterNames.BasicInformation, {
        vendorName: manufacturer,
        productName: this.context.label,
        productId: 0x800B,
        vendorId: 0x10AF,
        serialNumber: serial,
        softwareVersionString: firmware,
      });
      this.log.info(`[DishwasherAdapter] BasicInformation synced to Matter (firmware ${firmware})`);
    } catch (e) {
      this.log.debug(`[DishwasherAdapter] syncBasicInformation failed: ${e}`);
    }
  }

  getInitialState(): NormalizedMatterState {
    this.log.debug(`[DishwasherAdapter] getInitialState fetching from ${this.multiServiceAccessory.components.length} components`);
    const mainStatus = this.getMainStatus();
    this.log.debug(`[DishwasherAdapter] FULL main status keys: ${Object.keys(mainStatus).join(',')}`);

    const opStateStatus: any = this.getCapabilityStatus('samsungce.dishwasherOperation');
    const dishOpStatus: any = this.getCapabilityStatus('dishwasherOperatingState');
    const courseStatus: any = this.getCapabilityStatus('samsungce.dishwasherWashingCourse');
    const jobStateStatus: any = this.getCapabilityStatus('samsungce.dishwasherJobState');
    const progressStatus: any = this.getCapabilityStatus('custom.dishwasherOperatingProgress');
    const percStatus: any = this.getCapabilityStatus('custom.dishwasherOperatingPercentage');
    const switchStatus: any = this.getCapabilityStatus('switch');

    this.log.debug(`[DishwasherAdapter] opState=${JSON.stringify(opStateStatus?.operatingState)} machineState=${JSON.stringify(dishOpStatus?.machineState)} course=${JSON.stringify(courseStatus?.washingCourse)} job=${JSON.stringify(dishOpStatus?.dishwasherJobState)} samsungJob=${JSON.stringify(jobStateStatus?.dishwasherJobState)} switch=${JSON.stringify(switchStatus?.switch)} remainingTime=${JSON.stringify(opStateStatus?.remainingTime)} completionTime=${JSON.stringify(dishOpStatus?.completionTime)}`);

    if (courseStatus?.supportedCourses?.value) {
      this.supportedCourses = courseStatus.supportedCourses.value;
      this.log.debug(`[DishwasherAdapter] supportedCourses: ${this.supportedCourses.join(',')}`);
    }

    if (jobStateStatus?.scheduledJobs?.value) {
      this.scheduledJobs = jobStateStatus.scheduledJobs.value;
      const jobNames = this.scheduledJobs.map((j: any) => j.jobName);
      if (jobNames.length > 0) this.currentPhaseList = jobNames;
      this.log.debug(`[DishwasherAdapter] scheduledJobs: ${JSON.stringify(jobNames)} phaseList=${this.currentPhaseList.join(',')}`);
    }
    if (this.currentPhaseList.length === 0) {
      this.currentPhaseList = ['washing', 'rinsing', 'drying'];
    }

    if (this.lastFirmwareRevision === null && this.context) {
      this.lastFirmwareRevision = this.context.firmwareRevision || null;
      this.lastModel = this.context.model || null;
      this.lastManufacturer = this.context.manufacturerName || null;
    }

    // OperationalState: prefer samsungce operatingState, fallback to machineState
    if (opStateStatus?.operatingState?.value) {
      const mapped = this.mapSamsungOperatingStateToMatter(opStateStatus.operatingState.value);
      if (mapped !== undefined) this.currentOperationalState = mapped;
    } else if (dishOpStatus?.machineState?.value) {
      const mapped = this.mapMachineStateToMatter(dishOpStatus.machineState.value);
      if (mapped !== undefined) this.currentOperationalState = mapped;
    }

    if (switchStatus?.switch?.value) {
      this.currentSwitchOn = switchStatus.switch.value === 'on';
    }

    // remainingTime / countdown
    if (opStateStatus?.remainingTime?.value !== undefined) {
      const rt = opStateStatus.remainingTime.value;
      const unit = opStateStatus.remainingTime.unit || 'min';
      let mins: number | null = null;
      if (typeof rt === 'number') mins = rt;
      else if (rt && typeof rt.value === 'number') mins = rt.value;
      else mins = rt;
      if (typeof mins === 'number') {
        if (unit === 'hour') mins *= 60;
        else if (unit === 'sec') mins /= 60;
        this.remainingTimeMin = mins;
        this.currentCountdownTime = mins > 0 ? Math.round(mins * 60) : null;
      }
    }
    if (dishOpStatus?.completionTime?.value) {
      this.completionTime = dishOpStatus.completionTime.value;
      if (this.completionTime) {
        const parsed = Date.parse(this.completionTime);
        if (!isNaN(parsed)) {
          const secs = Math.max(0, Math.floor((parsed - Date.now()) / 1000));
          if (this.currentOperationalState === MatterOperationalState.OperationalState.RUNNING && secs > 0) {
            this.currentCountdownTime = Math.min(secs, 259200);
          } else if (this.currentCountdownTime === null || this.currentOperationalState !== MatterOperationalState.OperationalState.RUNNING) {
            if (this.currentOperationalState === MatterOperationalState.OperationalState.RUNNING) this.currentCountdownTime = Math.min(secs, 259200);
          }
        }
      }
    }
    // if still null and progress indicates running, keep remaining
    if (this.currentOperationalState !== MatterOperationalState.OperationalState.RUNNING) {
      this.currentCountdownTime = null;
      this.currentPhase = null;
    } else {
      // determine currentPhase from jobState
      if (dishOpStatus?.dishwasherJobState?.value) this.currentJobState = dishOpStatus.dishwasherJobState.value;
      else if (jobStateStatus?.dishwasherJobState?.value) this.currentJobState = jobStateStatus.dishwasherJobState.value;
      else if (progressStatus?.dishwasherOperatingProgress?.value) this.currentJobState = progressStatus.dishwasherOperatingProgress.value;
      this.updatePhaseFromJobState();
      // fallback progress-based phase if not resolved
      if (percStatus?.dishwasherOperatingPercentage?.value !== undefined) {
        this.progressPercentage = percStatus.dishwasherOperatingPercentage.value;
      } else if (opStateStatus?.progressPercentage?.value !== undefined) {
        this.progressPercentage = opStateStatus.progressPercentage.value;
      }
      if (this.currentPhase === null && this.progressPercentage) this.updatePhaseFromProgress();
    }

    if (courseStatus?.washingCourse?.value) {
      this.currentCourse = courseStatus.washingCourse.value;
      const idx = this.supportedCourses.indexOf(this.currentCourse);
      if (idx >= 0) this.currentDishwasherMode = idx;
      else {
        // if not found, add it dynamically? keep 0
        this.log.debug(`[DishwasherAdapter] washingCourse ${this.currentCourse} not in supported list`);
      }
    }

    this.log.debug(`[DishwasherAdapter] getInitialState -> OpState=${this.currentOperationalState} Mode=${this.currentDishwasherMode}(${this.currentCourse}) Phase=${this.currentPhase}/${JSON.stringify(this.currentPhaseList)} Countdown=${this.currentCountdownTime} Switch=${this.currentSwitchOn}`);

    return {
      [MatterClusterNames.OnOff]: { onOff: this.currentSwitchOn },
      [MatterClusterNames.OperationalState]: this.buildOperationalStateCluster(),
      [MatterClusterNames.DishwasherMode]: this.buildDishwasherModeCluster(),
      [MatterClusterNames.DishwasherAlarm]: {
        mask: 0,
        latch: 0,
        state: 0,
        supported: 0,
      },
    };
  }
}
