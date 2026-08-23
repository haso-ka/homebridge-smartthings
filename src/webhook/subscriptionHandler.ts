import { IKHomeBridgeHomebridgePlatform } from '../platform';
import { Logger } from 'homebridge';
import { MultiServiceAccessory } from '../multiServiceAccessory';
import { WebhookServer } from './webhookServer';
import { matterRegistry } from '../matter';

export interface ShortEvent {
  deviceId: string;
  value: any;
  componentId: string;
  capability: string;
  attribute: string;
}

export class SubscriptionHandler {
  private devices: MultiServiceAccessory[] = [];
  private log: Logger;

  constructor(
    platform: IKHomeBridgeHomebridgePlatform,
    devices: MultiServiceAccessory[],
    private readonly webhookServer: WebhookServer,
  ) {
    this.log = platform.log;
    this.devices = devices;

    // Register event handler with webhook server
    this.webhookServer.addEventHandler(this.handleDeviceEvent.bind(this));
  }

  public updateDevices(devices: MultiServiceAccessory[]): void {
    this.devices = devices;
  }

  private handleDeviceEvent(event: ShortEvent): void {
    // Forward to HomeKit services
    const device = this.devices.find(device => device.id === event.deviceId);
    if (device) {
      device.processEvent(event);
    }

    // Forward to Matter adapters
    matterRegistry.processEvent(event.deviceId, event);
  }
}
