import { API, Logger, PlatformAccessory } from 'homebridge';
import { MultiServiceAccessory } from '../multiServiceAccessory';
import type { ShortEvent } from '../webhook/subscriptionHandler';
import {
  MatterAdapter,
  MatterDeviceContext,
  NormalizedMatterCommand,
  NormalizedMatterState,
} from './matterTypes';

export abstract class BaseMatterAdapter implements MatterAdapter {
  protected readonly platform: API;
  protected readonly log: Logger;
  protected readonly multiServiceAccessory: MultiServiceAccessory;
  protected accessory: PlatformAccessory | null = null;
  protected context: MatterDeviceContext | null = null;
  protected currentState: NormalizedMatterState = {};

  abstract readonly deviceType: string;
  abstract readonly supportedCapabilities: string[];

  constructor(platform: API, log: Logger, multiServiceAccessory: MultiServiceAccessory) {
    this.platform = platform;
    this.log = log;
    this.multiServiceAccessory = multiServiceAccessory;
  }

  async initialize(accessory: PlatformAccessory, context: MatterDeviceContext): Promise<void> {
    this.accessory = accessory;
    this.context = context;
    this.currentState = this.getInitialState();
    await this.setupMatterAccessory();
  }

  protected abstract setupMatterAccessory(): Promise<void>;

  handleCommand(command: NormalizedMatterCommand): Promise<boolean> {
    this.log.debug(`[${this.deviceType}] Received Matter command: ${command.cluster}.${command.command}`, command.arguments);
    return this.handleMatterCommand(command);
  }

  protected abstract handleMatterCommand(command: NormalizedMatterCommand): Promise<boolean>;

  updateState(state: NormalizedMatterState): void {
    this.currentState = { ...this.currentState, ...state };
    this.pushStateToMatter(state);
  }

  protected abstract pushStateToMatter(state: NormalizedMatterState): void;

  processEvent(event: ShortEvent): void {
    this.log.debug(`[${this.deviceType}] Processing event: ${event.capability}.${event.attribute} = ${event.value}`);
    this.handleSmartThingsEvent(event);
  }

  protected abstract handleSmartThingsEvent(event: ShortEvent): void;

  getInitialState(): NormalizedMatterState {
    return this.currentState;
  }

  protected sendSmartThingsCommand(componentId: string, capability: string, command: string, args?: unknown[]): Promise<boolean> {
    return this.multiServiceAccessory.sendCommand(componentId, capability, command, args);
  }

  protected getDeviceStatus(): Record<string, unknown> {
    const component = this.multiServiceAccessory.components.find(c => c.componentId === 'main');
    return component?.status || {};
  }

  protected isOnline(): boolean {
    return this.multiServiceAccessory.isOnline();
  }
}