import { PlatformAccessory, CharacteristicValue, Service } from 'homebridge';
import { IKHomeBridgeHomebridgePlatform } from '../platform';
import { MultiServiceAccessory } from '../multiServiceAccessory';
import { Command } from './smartThingsCommand';
import { ShortEvent } from '../webhook/subscriptionHandler';
import { BaseService } from './baseService';

enum DehumidifierMode {
  Auto = 'auto',
  Low = 'low',
  Medium = 'medium',
  High = 'high',
  Dehumidify = 'dehumidify',
}

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
      .onSet(this.setTargetHumidifierDehumidifierState.bind(this));

    this.service.getCharacteristic(platform.Characteristic.CurrentRelativeHumidity)
      .onGet(this.getCurrentRelativeHumidity.bind(this));

    this.service.getCharacteristic(platform.Characteristic.TargetRelativeHumidity)
      .onGet(this.getTargetRelativeHumidity.bind(this))
      .onSet(this.setTargetRelativeHumidity.bind(this))
      .setProps({
        minStep: 1,
        minValue: 30,
        maxValue: 80,
      });

    if (this.isCapabilitySupported('airConditionerFanMode') || this.isCapabilitySupported('fanSpeed')) {
      this.service.getCharacteristic(platform.Characteristic.RotationSpeed)
        .onGet(this.getRotationSpeed.bind(this))
        .onSet(this.setRotationSpeed.bind(this));
    }

    multiServiceAccessory.startPollingState(this.platform.config.PollSensorsSeconds,
      this.getActive.bind(this), this.service, platform.Characteristic.Active);

    multiServiceAccessory.startPollingState(this.platform.config.PollSensorsSeconds,
      this.getCurrentRelativeHumidity.bind(this), this.service, platform.Characteristic.CurrentRelativeHumidity);

    multiServiceAccessory.startPollingState(this.platform.config.PollSensorsSeconds,
      this.getTargetRelativeHumidity.bind(this), this.service, platform.Characteristic.TargetRelativeHumidity);

    if (this.isCapabilitySupported('airConditionerFanMode') || this.isCapabilitySupported('fanSpeed')) {
      multiServiceAccessory.startPollingState(this.platform.config.PollSensorsSeconds,
        this.getRotationSpeed.bind(this), this.service, platform.Characteristic.RotationSpeed);
    }

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
    // This is a read-only characteristic for dehumidifiers
    this.log.debug(`[${this.name}] set target humidifier dehumidifier state to ${value} (ignored, dehumidifier only)`);
  }

  private async getCurrentRelativeHumidity(): Promise<CharacteristicValue> {
    const deviceStatus = await this.getDeviceStatus();
    return deviceStatus.relativeHumidityMeasurement.humidity.value;
  }

  private async getTargetRelativeHumidity(): Promise<CharacteristicValue> {
    const deviceStatus = await this.getDeviceStatus();
    // Try to get target humidity from humidifierMode capability or custom capability
    // Some Samsung dehumidifiers might expose a target humidity setpoint
    if (deviceStatus.humidifierMode?.humidifierMode?.value) {
      // If there's a specific target humidity capability, use it
      // For now, check if there's a custom capability or use a default
    }
    // Fallback: try to get from thermostatCoolingSetpoint or similar
    // Most dehumidifiers don't expose a settable target via standard capabilities
    // Return a reasonable default
    return 50;
  }

  private async setTargetRelativeHumidity(value: CharacteristicValue): Promise<void> {
    const targetHumidity = value as number;
    this.log.info(`[${this.name}] set target relative humidity to ${targetHumidity}%`);

    // Try to set via humidifierMode if it supports humidity setpoint
    // Some Samsung devices might use a custom capability for this
    // For now, we'll attempt to use the humidifierMode capability if it has a setHumidity command
    // or a custom capability
    try {
      // Check if device supports setting target humidity via humidifierMode
      // This is device-specific; some may not support it
      await this.sendCommandsOrFail([
        new Command(this.componentId, 'humidifierMode', 'setHumidifierMode', [targetHumidity.toString()]),
      ]);
    } catch (error) {
      this.log.warn(`[${this.name}] Failed to set target humidity via humidifierMode: ${error}`);
      // Some devices may not support setting target humidity via standard capabilities
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.RESOURCE_DOES_NOT_EXIST);
    }
  }

  private async getRotationSpeed(): Promise<CharacteristicValue> {
    const deviceStatus = await this.getDeviceStatus();

    if (this.isCapabilitySupported('airConditionerFanMode')) {
      const fanMode = deviceStatus.airConditionerFanMode.fanMode.value as DehumidifierMode;
      return this.fanModeToLevel(fanMode);
    }

    if (this.isCapabilitySupported('fanSpeed')) {
      return deviceStatus.fanSpeed.value;
    }

    return 50;
  }

  private async setRotationSpeed(value: CharacteristicValue): Promise<void> {
    const level = value as number;
    const fanMode = this.levelToFanMode(level);
    this.log.info(`[${this.name}] set rotation speed to ${fanMode} (from level ${level})`);

    if (this.isCapabilitySupported('airConditionerFanMode')) {
      await this.sendCommandsOrFail([new Command(this.componentId, 'airConditionerFanMode', 'setFanMode', [fanMode])]);
    } else if (this.isCapabilitySupported('fanSpeed')) {
      await this.sendCommandsOrFail([new Command(this.componentId, 'fanSpeed', 'setFanSpeed', [level])]);
    }
  }

  private fanModeToLevel(fanMode: DehumidifierMode): number {
    switch (fanMode) {
      case DehumidifierMode.Low:
        return 25;
      case DehumidifierMode.Medium:
        return 50;
      case DehumidifierMode.High:
        return 75;
      case DehumidifierMode.Dehumidify:
      case DehumidifierMode.Auto:
      default:
        return 100;
    }
  }

  private levelToFanMode(level: number): DehumidifierMode {
    if (level <= 0) {
      return DehumidifierMode.Auto;
    }
    if (level <= 30) {
      return DehumidifierMode.Low;
    }
    if (level <= 60) {
      return DehumidifierMode.Medium;
    }
    return DehumidifierMode.High;
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

      case 'airConditionerFanMode':
        this.dehumidifierService.updateCharacteristic(this.platform.Characteristic.RotationSpeed,
          this.fanModeToLevel(event.value as DehumidifierMode));
        break;

      case 'fanSpeed':
        this.dehumidifierService.updateCharacteristic(this.platform.Characteristic.RotationSpeed, event.value);
        break;

      case 'relativeHumidityMeasurement':
        this.dehumidifierService.updateCharacteristic(this.platform.Characteristic.CurrentRelativeHumidity, event.value);
        this.humiditySensorService?.updateCharacteristic(this.platform.Characteristic.CurrentRelativeHumidity, event.value);
        break;

      default:
        this.log.info(`[${this.name}] Ignore event updating ${event.capability} capability to ${event.value}`);
        break;
    }
  }
}