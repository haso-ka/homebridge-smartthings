import { PlatformAccessory, CharacteristicValue, Service } from 'homebridge';
import { IKHomeBridgeHomebridgePlatform } from '../platform';
import { MultiServiceAccessory } from '../multiServiceAccessory';
import { Command } from './smartThingsCommand';
import { ShortEvent } from '../webhook/subscriptionHandler';
import { BaseService } from './baseService';

enum SwitchState {
  On = 'on',
  Off = 'off',
}

export class DehumidifierService extends BaseService {

  private dehumidifierService: Service;
  private humiditySensorService?: Service;

  constructor(platform: IKHomeBridgeHomebridgePlatform, accessory: PlatformAccessory, componentId: string, capabilities: string[],
    multiServiceAccessory: MultiServiceAccessory,
    name: string, deviceStatus) {
    super(platform, accessory, componentId, capabilities, multiServiceAccessory, name, deviceStatus);

    this.log.debug(`Adding DehumidifierService to ${this.name}`);

    this.dehumidifierService = this.setupDehumidifier(platform, multiServiceAccessory);

    if (this.isCapabilitySupported('relativeHumidityMeasurement')) {
      this.humiditySensorService = this.setupHumiditySensor(platform, multiServiceAccessory);
    }
  }

  private isCapabilitySupported(capability: string): boolean {
    return this.capabilities.find(c => c === capability) !== undefined;
  }

  private setupDehumidifier(platform: IKHomeBridgeHomebridgePlatform, multiServiceAccessory: MultiServiceAccessory): Service {
    this.log.debug(`Expose Dehumidifier for ${this.name}`);

    this.setServiceType(platform.Service.HumidifierDehumidifier);

    this.service.getCharacteristic(platform.Characteristic.Active)
      .onGet(this.getActive.bind(this))
      .onSet(this.setActive.bind(this));

    this.service.getCharacteristic(platform.Characteristic.CurrentHumidifierDehumidifierState)
      .onGet(this.getCurrentHumidifierDehumidifierState.bind(this));

    this.service.getCharacteristic(platform.Characteristic.TargetHumidifierDehumidifierState)
      .onGet(this.getTargetHumidifierDehumidifierState.bind(this))
      .onSet(this.setTargetHumidifierDehumidifierState.bind(this))
      .setProps({
        validValues: [2], // Only DEHUMIDIFIER (2) - makes HomeKit recognize it as dehumidifier-only
      });

    this.service.getCharacteristic(platform.Characteristic.CurrentRelativeHumidity)
      .onGet(this.getCurrentRelativeHumidity.bind(this));

    // Dehumidifier target humidity uses RelativeHumidityDehumidifierThreshold (not TargetRelativeHumidity)
    this.service.getCharacteristic(platform.Characteristic.RelativeHumidityDehumidifierThreshold)
      .onGet(this.getTargetRelativeHumidity.bind(this))
      .onSet(this.setTargetRelativeHumidity.bind(this))
      .setProps({
        minStep: 1,
        minValue: 30,
        maxValue: 80,
      });

    multiServiceAccessory.startPollingState(this.platform.config.PollSensorsSeconds,
      this.getActive.bind(this), this.service, platform.Characteristic.Active);

    multiServiceAccessory.startPollingState(this.platform.config.PollSensorsSeconds,
      this.getCurrentRelativeHumidity.bind(this), this.service, platform.Characteristic.CurrentRelativeHumidity);

    multiServiceAccessory.startPollingState(this.platform.config.PollSensorsSeconds,
      this.getTargetRelativeHumidity.bind(this), this.service, platform.Characteristic.RelativeHumidityDehumidifierThreshold);

    return this.service;
  }

  private setupHumiditySensor(platform: IKHomeBridgeHomebridgePlatform, multiServiceAccessory: MultiServiceAccessory): Service {
    this.log.debug(`Expose Humidity Sensor for ${this.name}`);

    this.setServiceType(platform.Service.HumiditySensor);

    this.service.getCharacteristic(platform.Characteristic.CurrentRelativeHumidity)
      .onGet(this.getCurrentRelativeHumidity.bind(this));

    multiServiceAccessory.startPollingState(this.platform.config.PollSensorsSeconds,
      this.getCurrentRelativeHumidity.bind(this), this.service, platform.Characteristic.CurrentRelativeHumidity);

    this.dehumidifierService.addLinkedService(this.service);

    return this.service;
  }

  private async getActive(): Promise<CharacteristicValue> {
    const deviceStatus = await this.getDeviceStatus();
    return deviceStatus.switch.switch.value === SwitchState.On ? 1 : 0;
  }

  private async setActive(value: CharacteristicValue): Promise<void> {
    const switchState = value ? SwitchState.On : SwitchState.Off;

    if (switchState === SwitchState.On
      && this.deviceStatus?.status?.switch?.switch?.value === SwitchState.On) {
      this.log.info(`[${this.name}] skipping redundant switch on (already on)`);
      return;
    }

    this.log.info(`[${this.name}] set active to ${switchState}`);
    await this.sendCommandsOrFail([new Command(this.componentId, 'switch', switchState)]);
  }

  private async getCurrentHumidifierDehumidifierState(): Promise<CharacteristicValue> {
    const deviceStatus = await this.getDeviceStatus();
    const isOn = deviceStatus.switch.switch.value === SwitchState.On;
    // INACTIVE = 0, DEHUMIDIFYING = 1
    return isOn ? 1 : 0;
  }

  private async getTargetHumidifierDehumidifierState(): Promise<CharacteristicValue> {
    // DEHUMIDIFIER = 2
    return 2;
  }

  private async setTargetHumidifierDehumidifierState(value: CharacteristicValue): Promise<void> {
    // Dehumidifier only supports dehumidifier mode (value 2)
    this.log.debug(`[${this.name}] set target humidifier dehumidifier state to ${value} (ignored, dehumidifier only)`);
  }

  private async getCurrentRelativeHumidity(): Promise<CharacteristicValue> {
    const deviceStatus = await this.getDeviceStatus();
    return deviceStatus.relativeHumidityMeasurement.humidity.value;
  }

  private async getTargetRelativeHumidity(): Promise<CharacteristicValue> {
    const deviceStatus = await this.getDeviceStatus();
    // Try to read target humidity from Samsung official capabilities
    const samsungCaps = [
      'samsungce.dehumidifierTargetHumidity',
      'samsungce.dehumidifierSetpoint',
    ];
    for (const cap of samsungCaps) {
      if (deviceStatus[cap]?.targetHumidity?.value !== undefined) {
        return deviceStatus[cap].targetHumidity.value;
      }
      if (deviceStatus[cap]?.humiditySetpoint?.value !== undefined) {
        return deviceStatus[cap].humiditySetpoint.value;
      }
      if (deviceStatus[cap]?.value !== undefined) {
        return deviceStatus[cap].value;
      }
    }
    // Fallback: return a reasonable default
    return 50;
  }

  private async setTargetRelativeHumidity(value: CharacteristicValue): Promise<void> {
    const targetHumidity = value as number;
    this.log.info(`[${this.name}] set target relative humidity to ${targetHumidity}%`);

    // Try Samsung official capabilities (samsungce namespace)
    const samsungCaps = [
      { capability: 'samsungce.dehumidifierTargetHumidity', command: 'setTargetHumidity', attribute: 'targetHumidity' },
      { capability: 'samsungce.dehumidifierSetpoint', command: 'setHumiditySetpoint', attribute: 'humiditySetpoint' },
    ];

    for (const cap of samsungCaps) {
      if (this.isCapabilitySupported(cap.capability)) {
        try {
          await this.sendCommandsOrFail([
            new Command(this.componentId, cap.capability, cap.command, [targetHumidity]),
          ]);
          this.log.info(`[${this.name}] Set target humidity via ${cap.capability}.${cap.command}`);
          return;
        } catch (error) {
          this.log.warn(`[${this.name}] Failed to set target humidity via ${cap.capability}: ${error}`);
        }
      }
    }

    // If no supported capability found, throw not supported
    throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.RESOURCE_DOES_NOT_EXIST);
  }

  private async sendCommandsOrFail(commands: Command[]) {
    if (!this.multiServiceAccessory.isOnline()) {
      this.log.error(this.name + ' is offline');
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }

    if (!await this.multiServiceAccessory.sendCommands(commands)) {
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }

  private async getDeviceStatus(): Promise<any> {
    this.multiServiceAccessory.forceNextStatusRefresh();
    if (!await this.getStatus()) {
      if (this.deviceStatus?.status) {
        this.log.warn(`[${this.name}] Using cached status due to communication failure`);
        return this.deviceStatus.status;
      }
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
    return this.deviceStatus.status;
  }

  public processEvent(event: ShortEvent): void {
    this.log.info(`[${this.name}] Event updating ${event.capability} capability to ${event.value}`);

    switch (event.capability) {
      case 'switch':
        this.dehumidifierService.updateCharacteristic(this.platform.Characteristic.Active,
          event.value === SwitchState.On ? 1 : 0);
        this.dehumidifierService.updateCharacteristic(this.platform.Characteristic.CurrentHumidifierDehumidifierState,
          event.value === SwitchState.On ? 1 : 0);
        break;

      case 'relativeHumidityMeasurement':
        this.dehumidifierService.updateCharacteristic(this.platform.Characteristic.CurrentRelativeHumidity, event.value);
        this.humiditySensorService?.updateCharacteristic(this.platform.Characteristic.CurrentRelativeHumidity, event.value);
        break;

      case 'samsungce.dehumidifierTargetHumidity':
      case 'samsungce.dehumidifierSetpoint':
        this.dehumidifierService.updateCharacteristic(this.platform.Characteristic.RelativeHumidityDehumidifierThreshold, event.value);
        break;

      default:
        this.log.info(`[${this.name}] Ignore event updating ${event.capability} capability to ${event.value}`);
        break;
    }
  }
}