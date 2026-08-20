import { PlatformAccessory, CharacteristicValue } from 'homebridge';
import { IKHomeBridgeHomebridgePlatform } from '../platform';
import { BaseService } from './baseService';
import { MultiServiceAccessory } from '../multiServiceAccessory';
import { ShortEvent } from '../webhook/subscriptionHandler';

export class RobotCleanerService extends BaseService {

  constructor(platform: IKHomeBridgeHomebridgePlatform, accessory: PlatformAccessory, componentId: string, capabilities: string[],
    multiServiceAccessory: MultiServiceAccessory,
    name: string, deviceStatus) {
    super(platform, accessory, componentId, capabilities, multiServiceAccessory, name, deviceStatus);

    this.removeStaleValveService();
    this.setServiceType(platform.Service.Switch);
    this.log.debug(`Adding RobotCleanerService to ${this.name}`);

    this.service.setPrimaryService();

    this.service.getCharacteristic(platform.Characteristic.On)
      .onGet(this.getActive.bind(this))
      .onSet(this.setActive.bind(this));

    this.service.addOptionalCharacteristic(platform.Characteristic.StatusFault);
    this.service.getCharacteristic(platform.Characteristic.StatusFault)
      .onGet(this.getStatusFault.bind(this));

    let pollSeconds = 10;
    if (this.platform.config.PollSwitchesAndLightsSeconds !== undefined) {
      pollSeconds = this.platform.config.PollSwitchesAndLightsSeconds;
    }

    if (pollSeconds > 0) {
      multiServiceAccessory.startPollingState(pollSeconds, this.pollSwitchState.bind(this), this.service,
        platform.Characteristic.On);
    }
  }

  async setActive(value: CharacteristicValue) {
    const success = await this.sendActiveCommand(value);
    if (!success) {
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }

  async pollSwitchState(): Promise<CharacteristicValue> {
    const success = await this.getStatus();
    if (!success) {
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }

    const state = this.getRobotCleanerState();
    if (!state) {
      this.log.error(`Missing robot cleaner state from ${this.name}`);
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }

    this.log.debug(`Robot cleaner state=${state} for ${this.name}`);
    this.service.updateCharacteristic(this.platform.Characteristic.StatusFault, this.robotStateToStatusFault(state));

    return this.robotStateToOn(state);
  }

  async getActive(): Promise<CharacteristicValue> {
    return new Promise((resolve, reject) => {
      this.getStatus().then(success => {
        if (!success) {
          reject(new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE));
          return;
        }
        const state = this.getRobotCleanerState();
        if (!state) {
          this.log.error(`Missing robot cleaner state from ${this.name}`);
          reject(new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE));
          return;
        }
        resolve(this.robotStateToOn(state));
      });
    });
  }

  async getStatusFault(): Promise<CharacteristicValue> {
    return new Promise((resolve, reject) => {
      this.getStatus().then(success => {
        if (!success) {
          reject(new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE));
          return;
        }
        const state = this.getRobotCleanerState();
        if (!state) {
          this.log.error(`Missing robot cleaner state from ${this.name}`);
          reject(new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE));
          return;
        }
        resolve(this.robotStateToStatusFault(state));
      });
    });
  }

  private async sendActiveCommand(value: CharacteristicValue): Promise<boolean> {
    const active = value === true || value === this.platform.Characteristic.Active.ACTIVE;

    if (this.capabilities.includes('robotCleanerOperatingState')) {
      const command = active ? 'start' : 'pause';
      this.log.debug(`RobotCleanerService setActive(${value}) sending ${command} for ${this.name}`);
      return this.multiServiceAccessory.sendCommand(this.componentId, 'robotCleanerOperatingState', command);
    }

    if (this.capabilities.includes('robotCleanerCleaningMode')) {
      const mode = active ? 'auto' : 'stop';
      this.log.debug(`RobotCleanerService setActive(${value}) sending cleaning mode ${mode} for ${this.name}`);
      return this.multiServiceAccessory.sendCommand(
        this.componentId,
        'robotCleanerCleaningMode',
        'setRobotCleanerCleaningMode',
        [mode],
      );
    }

    if (!active && this.capabilities.includes('robotCleanerMovement')) {
      this.log.debug(`RobotCleanerService setActive(${value}) sending movement homing for ${this.name}`);
      return this.multiServiceAccessory.sendCommand(
        this.componentId,
        'robotCleanerMovement',
        'setRobotCleanerMovement',
        ['homing'],
      );
    }

    this.log.warn(`RobotCleanerService cannot start ${this.name}: no supported start command capability`);
    return false;
  }

  private getRobotCleanerState(): string | undefined {
    return this.deviceStatus.status.robotCleanerOperatingState?.operatingState?.value ||
      this.deviceStatus.status.robotCleanerMovement?.robotCleanerMovement?.value ||
      this.deviceStatus.status.robotCleanerCleaningMode?.robotCleanerCleaningMode?.value;
  }

  private removeStaleValveService(): void {
    if (this.deviceHasCapability('valve')) {
      return;
    }

    const staleValve = this.accessory.getService(this.platform.Service.Valve);
    if (staleValve) {
      this.log.info(`Removing stale Valve service from robot cleaner ${this.name}`);
      this.accessory.removeService(staleValve);
    }
  }

  private deviceHasCapability(capabilityId: string): boolean {
    return this.accessory.context.device.components?.some(component =>
      component.capabilities?.some(capability => capability.id === capabilityId),
    ) ?? false;
  }

  private robotStateToOn(state: string): boolean {
    switch (state) {
    case 'running':
    case 'paused':
    case 'seekingCharger':
    case 'cleaning':
    case 'pause':
    case 'washingMop':
    case 'auto':
    case 'part':
    case 'repeat':
    case 'manual':
    case 'map':
      return true;
    default:
      return false;
    }
  }

  private robotStateToStatusFault(state: string): number {
    switch (state) {
    case 'unableToStartOrResume':
    case 'unableToCompleteOperation':
    case 'commandInvalidInState':
    case 'failedToFindChargingDock':
    case 'stuck':
    case 'dustBinMissing':
    case 'dustBinFull':
    case 'waterTankEmpty':
    case 'waterTankMissing':
    case 'waterTankLidOpen':
    case 'mopCleaningPadMissing':
    case 'alarm':
      return this.platform.Characteristic.StatusFault.GENERAL_FAULT;
    default:
      return this.platform.Characteristic.StatusFault.NO_FAULT;
    }
  }

  public processEvent(event: ShortEvent): void {
    if (this.isRobotCleanerStateEvent(event)) {
      this.log.debug(`Event updating robot cleaner state for ${this.name} to ${event.value}`);
      this.service.updateCharacteristic(
        this.platform.Characteristic.On,
        this.robotStateToOn(event.value),
      );
      this.service.updateCharacteristic(this.platform.Characteristic.StatusFault, this.robotStateToStatusFault(event.value));
    }
  }

  private isRobotCleanerStateEvent(event: ShortEvent): boolean {
    return (event.capability === 'robotCleanerOperatingState' && event.attribute === 'operatingState') ||
      (event.capability === 'robotCleanerMovement' && event.attribute === 'robotCleanerMovement') ||
      (event.capability === 'robotCleanerCleaningMode' && event.attribute === 'robotCleanerCleaningMode');
  }
}
