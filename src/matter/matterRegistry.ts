import { API, Logger, PlatformAccessory } from 'homebridge';
import { MultiServiceAccessory } from '../multiServiceAccessory';
import type { ShortEvent } from '../webhook/subscriptionHandler';
import {
  MatterAdapter,
  MatterAdapterConstructor,
  MatterDeviceContext,
  NormalizedMatterCommand,
  NormalizedMatterState,
} from './matterTypes';

export class MatterRegistry {
  private adapters: Map<string, MatterAdapterConstructor> = new Map();
  private activeAdapters: Map<string, MatterAdapter> = new Map();

  registerAdapter(deviceType: string, adapterConstructor: MatterAdapterConstructor): void {
    if (this.adapters.has(deviceType)) {
      throw new Error(`Matter adapter for device type '${deviceType}' is already registered`);
    }
    this.adapters.set(deviceType, adapterConstructor);
  }

  getAdapterConstructor(deviceType: string): MatterAdapterConstructor | undefined {
    return this.adapters.get(deviceType);
  }

  getSupportedDeviceTypes(): string[] {
    return Array.from(this.adapters.keys());
  }

  async createAdapter(
    deviceType: string,
    platform: API,
    log: Logger,
    multiServiceAccessory: MultiServiceAccessory,
    accessory: PlatformAccessory,
    context: MatterDeviceContext,
  ): Promise<MatterAdapter | null> {
    const AdapterConstructor = this.adapters.get(deviceType);
    if (!AdapterConstructor) {
      return null;
    }

    const adapter = new AdapterConstructor(platform, log, multiServiceAccessory);
    await adapter.initialize(accessory, context);
    this.activeAdapters.set(context.deviceId, adapter);
    return adapter;
  }

  getAdapter(deviceId: string): MatterAdapter | undefined {
    return this.activeAdapters.get(deviceId);
  }

  removeAdapter(deviceId: string): void {
    this.activeAdapters.delete(deviceId);
  }

  handleCommand(deviceId: string, command: NormalizedMatterCommand): Promise<boolean> {
    const adapter = this.activeAdapters.get(deviceId);
    if (!adapter) {
      return Promise.resolve(false);
    }
    return adapter.handleCommand(command);
  }

  updateState(deviceId: string, state: NormalizedMatterState): void {
    const adapter = this.activeAdapters.get(deviceId);
    if (adapter) {
      adapter.updateState(state);
    }
  }

  processEvent(deviceId: string, event: ShortEvent): void {
    const adapter = this.activeAdapters.get(deviceId);
    if (adapter) {
      adapter.processEvent(event);
    }
  }

  getInitialState(deviceId: string): NormalizedMatterState | null {
    const adapter = this.activeAdapters.get(deviceId);
    if (adapter) {
      return adapter.getInitialState();
    }
    return null;
  }
}

export const matterRegistry = new MatterRegistry();