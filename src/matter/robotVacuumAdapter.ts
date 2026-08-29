/* eslint-disable @typescript-eslint/no-unused-vars */
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
  MatterRvcRequiredRunMode,
  MatterRvcOptionalRunMode,
  MatterRvcCleanModeMap,
  MatterRvcRunModeMap,
  MatterPowerSource,
} from './matterTypes';

const SMARTTHINGS_ROBOT_VACUUM_CAPABILITIES = [
  'samsungce.robotCleanerOperatingState',
  'samsungce.robotCleanerCleaningMode',
  'robotCleanerCleaningMode',
  'robotCleanerMovement',
  'robotCleanerTurboMode',
  'samsungce.robotCleanerCleaningType',
  'samsungce.robotCleanerDrivingMode',
  'samsungce.robotCleanerWaterSprayLevel',
  'samsungce.robotCleanerMapList',
  'samsungce.robotCleanerMapAreaInfo',
  'samsungce.robotCleanerMapCleaningInfo',
  'samsungce.robotCleanerMapMetadata',
  'battery',
  'switch',
  'audioNotification',
  'audioVolume',
  'audioMute',
] as const;

type SmartThingsRobotVacuumCapability = typeof SMARTTHINGS_ROBOT_VACUUM_CAPABILITIES[number];

interface SamsungRobotCleanerOperatingState {
  operatingState?: { value: string };
  supportedOperatingState?: { value: string[] };
  cleaningStep?: { value: string };
  homingReason?: { value: string };
}

interface SamsungRobotCleanerCleaningMode {
  cleaningMode?: { value: string };
  supportedCleaningMode?: { value: string[] };
  supportRepeatMode?: { value: boolean };
  repeatModeEnabled?: { value: boolean };
}

interface StandardRobotCleanerCleaningMode {
  robotCleanerCleaningMode?: { value: string };
}

interface SamsungRobotCleanerDrivingMode {
  drivingMode?: { value: string };
  supportedDrivingModes?: { value: string[] };
}

interface SamsungRobotCleanerCleaningType {
  cleaningType?: { value: string };
  supportedCleaningTypes?: { value: string[] };
  availableCleaningTypes?: { value: string[] };
}

interface RobotCleanerTurboMode {
  robotCleanerTurboMode?: { value: string };
}

interface RobotCleanerMovement {
  robotCleanerMovement?: { value: string };
}

interface BatteryCapability {
  battery?: { value: number };
}

interface SwitchCapability {
  switch?: { value: string };
}

interface WaterSprayLevel {
  waterSprayLevel?: { value: string };
  supportedWaterSprayLevels?: { value: string[] };
  availableWaterSprayLevels?: { value: string[] };
}

interface MapList {
  maps?: { value: any[] };
  currentMapId?: { value: string | null };
}

export class RobotVacuumAdapter extends BaseMatterAdapter implements MatterAdapter {
  readonly deviceType = 'RoboticVacuumCleaner';
  readonly supportedCapabilities = [...SMARTTHINGS_ROBOT_VACUUM_CAPABILITIES];

  private matterApi: any = null;
  private currentOperationalState: number = MatterRvcOperationalState.OperationalState.STOPPED;
  private currentCleanMode: number = MatterRvcCleanMode.Type.VACUUM;
  private currentRunMode: number = MatterRvcRunMode.Type.IDLE;
  private currentBatteryLevel = 100;
  private currentCharging = false;
  private currentPowerOn = false;
  private currentWaterSprayLevel = 'medium';
  private currentDrivingMode = 'areaThenWalls';

  private supportedCleaningTypes: string[] = [];
  private supportedCleaningModes: string[] = [];
  private supportedDrivingModes: string[] = [];
  private supportedWaterLevels: string[] = [];
  private supportedOperatingStates: string[] = [];
  private pollingInterval: NodeJS.Timeout | null = null;
  // Matter side selected rooms (kept separately, not overwritten by polling)
  private selectedAreas: number[] = [];
  private lastMapSignature: string | null = null;
  private lastFirmwareRevision: string | null = null;
  private lastModel: string | null = null;
  private lastManufacturer: string | null = null;
  private pollCount = 0;

  constructor(platform: API, log: Logger, multiServiceAccessory: MultiServiceAccessory) {
    super(platform, log, multiServiceAccessory);
    this.matterApi = (platform as any).matter || null;
  }

  private startPolling(): void {
    if (this.pollingInterval) {
      return;
    }
    const platform: any = (this.multiServiceAccessory as any).platform;
    const intervalSec = platform?.config?.matterPollingInterval;
    const intervalMs = (typeof intervalSec === 'number' ? intervalSec : 10) * 1000;
    if (intervalMs === 0) {
      this.log.info('[RobotVacuumAdapter] Polling disabled (matterPollingInterval=0)');
      return;
    }
    this.pollingInterval = setInterval(async () => {
      try {
        await this.multiServiceAccessory.refreshStatus();
        // Detect map itself changed -> re-initialize selected map/room from polled data
        const newSig = this.getMapSignature();
        if (this.lastMapSignature !== null && newSig !== this.lastMapSignature) {
          this.log.info(`[RobotVacuumAdapter] Map changed detected via polling: ${this.lastMapSignature} -> ${newSig}, resetting selectedAreas`);
          this.selectedAreas = [];
          this.lastMapSignature = newSig;
          const serviceArea = this.buildServiceAreaCluster();
          if (serviceArea) {
            await this.matterApi?.updateAccessoryState(this.accessory!.UUID, MatterClusterNames.ServiceArea, serviceArea);
          }
        } else if (this.lastMapSignature === null) {
          this.lastMapSignature = newSig;
        }
        // Note: selectedAreas is NOT synced from polling otherwise (kept separately on Matter side)
        // Detect manufacturer/model/firmware changes via SmartThings device API during polling
        this.pollCount++;
        if (this.pollCount % 6 === 0) { // every ~60s (6 * 10s)
          await this.syncBasicInformationIfChanged();
        }
      } catch (e) {
        this.log.debug(`[RobotVacuumAdapter] Polling refresh failed: ${e}`);
      }
    }, intervalMs);
  }

  private stopPolling(): void {
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = null;
    }
  }

  // Helper: get capability status from any component
  private getCapabilityStatus(capabilityId: string): any {
    for (const comp of this.multiServiceAccessory.components) {
      const status = comp.status as Record<string, any>;
      if (status && status[capabilityId]) {
        return status[capabilityId];
      }
    }
    // fallback to main via getDeviceStatus
    const mainStatus = this.getDeviceStatus() as Record<string, any>;
    return mainStatus[capabilityId];
  }

  private getMainStatus(): Record<string, any> {
    const mainComp = this.multiServiceAccessory.components.find(c => c.componentId === 'main');
    if (mainComp?.status) {
      return mainComp.status as Record<string, any>;
    }
    return this.getDeviceStatus() as Record<string, any>;
  }

  protected async setupMatterAccessory(): Promise<void> {
    if (!this.matterApi || !this.accessory || !this.context) {
      this.log.warn('[RobotVacuumAdapter] Matter API not available or accessory not initialized');
      return;
    }

    try {
      await this.multiServiceAccessory.refreshStatus();
      this.currentState = this.getInitialState();
      this.log.info(`[RobotVacuumAdapter] Refreshed initial state for Matter: RunMode=${this.currentRunMode} OpState=${this.currentOperationalState} CleanMode=${this.currentCleanMode}`);
    } catch (e) {
      this.log.warn(`[RobotVacuumAdapter] Initial refreshStatus failed: ${e}`);
    }

    const platform: any = (this.multiServiceAccessory as any).platform;
    const serverUrl = platform?.config?.server_url;
    const hasWebhook = typeof serverUrl === 'string' && serverUrl.trim() !== '';
    if (!hasWebhook) {
      this.startPolling();
      this.log.info('[RobotVacuumAdapter] Webhook not configured, polling enabled for state updates');
    }

    this.log.info(`[RobotVacuumAdapter] setupMatterAccessory: RunMode=${this.currentRunMode} OpState=${this.currentOperationalState} CleanMode=${this.currentCleanMode}`);

    try {
      const uuid = this.accessory.UUID;

      const serviceAreaCluster = this.buildServiceAreaCluster();

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
            productId: 0x800A,
            vendorId: 0x10AF, // Samsung vendor
            deviceTypeId: 0x0074, // RVC device type 116
            softwareVersion: 1,
            softwareVersionString: this.context.firmwareRevision || '1.0',
          },
          onOff: {
            // Read-only: reports SmartThings switch state to Matter, but Matter cannot control it
            onOff: this.currentPowerOn,
          },
          identify: {
            identifyTime: 0,
          },
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
              { operationalStateId: MatterRvcOperationalState.OperationalState.EMPTYING_DUST_BIN },
              { operationalStateId: MatterRvcOperationalState.OperationalState.CLEANING_MOP },
              { operationalStateId: MatterRvcOperationalState.OperationalState.FILLING_WATER_TANK },
              { operationalStateId: MatterRvcOperationalState.OperationalState.UPDATING_MAPS },
            ],
          },
          rvcRunMode: {
            currentMode: this.currentRunMode,
            supportedModes: this.buildRunModeSupportedModes(),
          },
          rvcCleanMode: {
            currentMode: this.currentCleanMode,
            supportedModes: this.buildCleanModeSupportedModes(),
          },
          powerSource: {
            batChargeLevel: this.batteryLevelToMatterEnum(this.currentBatteryLevel),
            batPercentRemaining: this.currentBatteryLevel * 2,
            batChargeState: this.getMatterBatChargeState(),
            batReplacementNeeded: MatterPowerSource.BatReplacementNeeded,
            batReplaceability: MatterPowerSource.BatReplaceability.NOT_REPLACEABLE,
          },
          ...(serviceAreaCluster ? { serviceArea: serviceAreaCluster } : {}),
        },
        handlers: {
          onOff: {
            // Read-only: reject all OnOff commands from Matter/Home app
            on: async () => {
              this.log.warn('[RobotVacuumAdapter] OnOff is read-only — ignoring Matter command: on');
            },
            off: async () => {
              this.log.warn('[RobotVacuumAdapter] OnOff is read-only — ignoring Matter command: off');
            },
            toggle: async () => {
              this.log.warn('[RobotVacuumAdapter] OnOff is read-only — ignoring Matter command: toggle');
            },
          },
          rvcOperationalState: {
            pause: async () => {
              await this.handleOperationalStateCommand('pause');
            },
            resume: async () => {
              await this.handleOperationalStateCommand('resume');
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
          ...(serviceAreaCluster ? {
            serviceArea: {
              selectAreas: async (args: { newAreas: number[] }) => {
                await this.handleServiceAreaSelectAreas(args.newAreas);
              },
              skipArea: async (args: { skippedArea: number }) => {
                await this.handleServiceAreaSkipArea(args.skippedArea);
              },
            },
          } : {}),
        },
      }]);

      this.log.info(`[RobotVacuumAdapter] Registered Matter accessory: ${this.context.label} (${uuid}) with ${serviceAreaCluster ? 'ServiceArea' : 'no ServiceArea'}`);
      await this.updateMatterClustersAfterRegistration();
    } catch (error) {
      this.log.error(`[RobotVacuumAdapter] Failed to register Matter accessory: ${error}`);
    }
  }

  private buildRunModeSupportedModes(): any[] {
    // Recommended: expose only stable, non-area modes to Apple Home.
    // Area/object cleaning must go via ServiceArea cluster (Matter 1.4), not RunMode.
    // This prevents Home's "Start" button from sending random area(3)/object(4)/uncleanedObject(6).
    // Always ensure idle+auto are present for a usable vacuum
    let modes: string[] = [...MatterRvcRequiredRunMode];
    // Deterministic order = ALLOWED order, intersection with what device actually supports
    modes.push(
      ...(MatterRvcOptionalRunMode as readonly string[]).filter(
        m => this.supportedCleaningModes.includes(m)
      )
    );

    const mk = (mode: number, label: string, tags: string[]) => ({
      mode,
      label,
      modeTags: tags.map(v => ({ value: v })),
    });
    const out: any[] = [];
    for (const m of modes) {
      const e = (MatterRvcRunModeMap as any)[m];
      if (e) out.push(mk(e.mode, e.label, e.tags));
    }
    this.log.debug(`[RobotVacuumAdapter] buildRunModeSupportedModes: device=${this.supportedCleaningModes.join(',')} -> advertised=${modes.join(',')} modes=${JSON.stringify(out.map(o => o.mode))}`);
    return out;
  }

  private buildCleanModeSupportedModes(): any[] {
    const types = this.supportedCleaningTypes;
    if (types.length === 0) return [];
    const mk = (mode: number, label: string, tags: number[]) => ({
      mode,
      label,
      modeTags: tags.map(v => ({ value: v })),
    });
    const out: any[] = [];
    for (const t of types) {
      const e = MatterRvcCleanModeMap[t];
      if (e) out.push(mk(e.mode, e.label, e.tags));
    }
    return out;
  }

  private buildServiceAreaCluster(): any | null {
    try {
      const mapListStatus: any = this.getCapabilityStatus('samsungce.robotCleanerMapList');
      let maps: any[] = [];
      if (mapListStatus?.maps?.value) {
        maps = mapListStatus.maps.value;
      } else {
        // fallback try main status
        const main = this.getMainStatus();
        maps = main['samsungce.robotCleanerMapList']?.maps?.value || [];
      }
      if (!maps || maps.length === 0) {
        return {
          supportedMaps: [],
          supportedAreas: [],
          selectedAreas: [],
          currentArea: null,
          estimatedEndTime: null,
          progress: [],
        };
      }
      let targetMaps = maps;
      const currentMapId = (mapListStatus as any)?.currentMapId?.value
        || (this.getMainStatus() as any)['samsungce.robotCleanerMapList']?.currentMapId?.value;
      if (currentMapId) {
        const found = maps.find((m: any) => String(m.id) === String(currentMapId));
        if (found) {
          targetMaps = [found];
        }
      } else {
        targetMaps = [...maps].sort((a: any, b: any) => {
          const aTime = new Date(a.updatedTime || a.createdTime || 0).getTime();
          const bTime = new Date(b.updatedTime || b.createdTime || 0).getTime();
          return bTime - aTime;
        }).slice(0, 1);
      }
      const supportedMaps = targetMaps.map((m: any) => ({
        mapId: parseInt(m.id, 10) || 0,
        name: m.name || `Map ${m.id}`,
      }));
      const supportedAreas: any[] = [];
      for (const map of targetMaps) {
        const mapId = parseInt(map.id, 10) || 0;
        const areaInfos = map.areaInfo || [];
        for (const area of areaInfos) {
          const areaId = parseInt(area.id, 10) || 0;
          supportedAreas.push({
            areaId: mapId * 100 + areaId,
            mapId: mapId,
            areaInfo: {
              locationInfo: {
                locationName: area.name,
                floorNumber: null,
                areaType: 0,
              },
              landmarkInfo: null,
            },
          });
        }
        if (map.objectInfo) {
          for (const obj of map.objectInfo) {
            const objId = parseInt(obj.id, 10) || 0;
            supportedAreas.push({
              areaId: mapId * 1000 + objId + 500,
              mapId: mapId,
              areaInfo: {
                locationInfo: {
                  locationName: obj.name,
                  floorNumber: null,
                  areaType: 1,
                },
                landmarkInfo: {
                  landmarkTag: 0,
                },
              },
            });
          }
        }
      }
      this.log.debug(`[RobotVacuumAdapter] ServiceArea supportedAreas: ${supportedAreas.length} areas from ${targetMaps.length} maps (selected from ${maps.length} total)`);
      return {
        supportedMaps,
        supportedAreas,
        selectedAreas: [...this.selectedAreas],
        currentArea: null,
        estimatedEndTime: null,
        progress: [],
      };
    } catch (e) {
      this.log.warn(`[RobotVacuumAdapter] Failed to build ServiceArea cluster: ${e}`);
      return null;
    }
  }

  private getMapSignature(): string {
    try {
      const mapListStatus: any = this.getCapabilityStatus('samsungce.robotCleanerMapList');
      const maps: any[] = mapListStatus?.maps?.value || this.getMainStatus()['samsungce.robotCleanerMapList']?.maps?.value || [];
      const currentMapId = (mapListStatus as any)?.currentMapId?.value || this.getMainStatus()['samsungce.robotCleanerMapList']?.currentMapId?.value || '';
      const ids = maps.map((m: any) => String(m.id)).sort().join(',');
      const areaSig = maps.map((m: any) => `${m.id}:${(m.areaInfo || []).map((a: any) => a.id).join(',')}`).join('|');
      return `${currentMapId}#${ids}#${areaSig}`;
    } catch {
      return '';
    }
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
      const model = device?.modelNumber || device?.modelName || ocf.modelNumber || device?.vid || 'Samsung Robot Vacuum';
      const firmware = device?.firmwareVersion || ocf.firmwareVersion || ocf.mnfv || 'Unknown';
      const serial = device?.deviceId || this.context.deviceId;

      // Init trackers on first run
      if (this.lastManufacturer === null) this.lastManufacturer = this.context.manufacturerName || null;
      if (this.lastModel === null) this.lastModel = this.context.model || null;
      if (this.lastFirmwareRevision === null) this.lastFirmwareRevision = this.context.firmwareRevision || null;

      const changed = manufacturer !== this.lastManufacturer || model !== this.lastModel || firmware !== this.lastFirmwareRevision;
      if (!changed) return;

      this.log.info(`[RobotVacuumAdapter] BasicInformation changed: manufacturer ${this.lastManufacturer}->${manufacturer}, model ${this.lastModel}->${model}, firmware ${this.lastFirmwareRevision}->${firmware}`);
      this.lastManufacturer = manufacturer;
      this.lastModel = model;
      this.lastFirmwareRevision = firmware;
      // Update context for future
      this.context.manufacturerName = manufacturer;
      this.context.model = model;
      this.context.firmwareRevision = firmware;
      this.context.serialNumber = serial;

      await this.matterApi.updateAccessoryState(this.accessory.UUID, MatterClusterNames.BasicInformation, {
        vendorName: manufacturer,
        productName: this.context.label,
        productId: 0x800A,
        vendorId: 0x10AF,
        serialNumber: serial,
        softwareVersionString: firmware,
      });
      this.log.info(`[RobotVacuumAdapter] BasicInformation synced to Matter`);
    } catch (e) {
      this.log.debug(`[RobotVacuumAdapter] syncBasicInformation failed: ${e}`);
    }
  }

  private getMatterBatChargeState(): number {
    // Samsung reports many dock-stay states (washingMop/dryingMop/emptyStation etc.) while actually charging.
    // Consider any docked-at-station state as charging/charged based on battery level.
    const dockedStates = new Set<number>([
      MatterRvcOperationalState.OperationalState.CHARGING,
      MatterRvcOperationalState.OperationalState.DOCKED,
      MatterRvcOperationalState.OperationalState.EMPTYING_DUST_BIN,
      MatterRvcOperationalState.OperationalState.CLEANING_MOP,
      MatterRvcOperationalState.OperationalState.FILLING_WATER_TANK,
      MatterRvcOperationalState.OperationalState.UPDATING_MAPS,
    ]);
    if (this.currentOperationalState === MatterRvcOperationalState.OperationalState.CHARGING) {
      return MatterPowerSource.BatChargeState.CHARGING;
    }
    if (this.currentOperationalState === MatterRvcOperationalState.OperationalState.DOCKED) {
      return this.currentBatteryLevel >= 100 ? MatterPowerSource.BatChargeState.CHARGED : MatterPowerSource.BatChargeState.CHARGING;
    }
    if (dockedStates.has(this.currentOperationalState)) {
      // At station (e.g., dryingMop/washingMop) -> charging if not full
      return this.currentBatteryLevel >= 100 ? MatterPowerSource.BatChargeState.CHARGED : MatterPowerSource.BatChargeState.CHARGING;
    }
    return MatterPowerSource.BatChargeState.NOT_CHARGING;
  }

  private async updateMatterClustersAfterRegistration(): Promise<void> {
    if (!this.matterApi || !this.context) {
      return;
    }
    const deviceId = this.accessory!.UUID;
    try {
      await this.matterApi.updateAccessoryState(this.accessory!.UUID, MatterClusterNames.RvcOperationalState, {
        operationalState: this.currentOperationalState,
        operationalError: { errorStateId: MatterRvcOperationalState.OperationalError.NO_ERROR },
      });
      await this.matterApi.updateAccessoryState(this.accessory!.UUID, MatterClusterNames.RvcCleanMode, { currentMode: this.currentCleanMode });
      await this.matterApi.updateAccessoryState(this.accessory!.UUID, MatterClusterNames.RvcRunMode, { currentMode: this.currentRunMode });
      await this.matterApi.updateAccessoryState(this.accessory!.UUID, MatterClusterNames.PowerSource, {
        batChargeLevel: this.batteryLevelToMatterEnum(this.currentBatteryLevel),
        batPercentRemaining: this.currentBatteryLevel * 2,
        batChargeState: this.getMatterBatChargeState(),
        batReplacementNeeded: MatterPowerSource.BatReplacementNeeded,
        batReplaceability: MatterPowerSource.BatReplaceability.NOT_REPLACEABLE,
      });
      const serviceArea = this.buildServiceAreaCluster();
      if (serviceArea) {
        await this.matterApi.updateAccessoryState(this.accessory!.UUID, MatterClusterNames.ServiceArea, serviceArea);
      }
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
          this.log.warn(`[RobotVacuumAdapter] OnOff cluster is read-only — rejecting command: ${command.command}`);
          return false;
        case MatterClusterNames.RvcOperationalState: return await this.handleOperationalStateCommand(command.command);
        case MatterClusterNames.RvcCleanMode: return await this.handleCleanModeCommand(command.command, command.arguments);
        case MatterClusterNames.RvcRunMode: return await this.handleRunModeCommand(command.command, command.arguments);
        case MatterClusterNames.ServiceArea: return await this.handleServiceAreaCommand(command.command, command.arguments);
        default: this.log.debug(`[RobotVacuumAdapter] Unhandled cluster: ${command.cluster}`); return false;
      }
    } catch (error) {
      this.log.error(`[RobotVacuumAdapter] Error handling command ${command.cluster}.${command.command}: ${error}`);
      return false;
    }
  }

  private getSelectedAreaPayload(): { mapId: string; areaIds: string[] } | null {
    if (this.selectedAreas.length === 0) return null;
    const mapGroups = new Map<string, string[]>();
    for (const aid of this.selectedAreas) {
      const mapId = String(Math.floor(aid / 100));
      const areaId = String(aid % 100);
      if (!mapGroups.has(mapId)) mapGroups.set(mapId, []);
      mapGroups.get(mapId)!.push(areaId);
    }
    const firstMapId = [...mapGroups.keys()][0];
    const areaIds = mapGroups.get(firstMapId)!;
    return { mapId: firstMapId, areaIds };
  }

  private async handleOperationalStateCommand(command: string): Promise<boolean> {
    this.log.info(`[RobotVacuumAdapter] handleOperationalStateCommand: ${command} selectedAreas=${JSON.stringify(this.selectedAreas)}`);
    let success = false;
    let state = 0;
    const cap = 'samsungce.robotCleanerOperatingState';
    switch (command) {
      case 'start':
      case 'resume': {
        const areaPayload = this.getSelectedAreaPayload();
        if (areaPayload) {
          this.log.info(`[RobotVacuumAdapter] start/resume with selectedAreas -> setCleaningMode area ${JSON.stringify(areaPayload)} + movement`);
          const modeOk = await this.sendSmartThingsCommand('main', 'samsungce.robotCleanerCleaningMode', 'setCleaningMode', ['area', areaPayload]);
          if (!modeOk) {
            this.log.error(`[RobotVacuumAdapter] setCleaningMode area failed`);
            success = false;
          } else {
            // Small delay to let mode settle, then trigger actual cleaning
            await new Promise(r => setTimeout(r, 500));
            success = await this.sendSmartThingsCommand('main', 'robotCleanerMovement', 'setRobotCleanerMovement', ['cleaning']);
          }
        } else {
          success = await this.sendSmartThingsCommand('main', 'robotCleanerMovement', 'setRobotCleanerMovement', ['cleaning']);
        }
        state = MatterRvcOperationalState.OperationalState.RUNNING;
        break;
      }
      case 'goHome':
        success = await this.sendSmartThingsCommand('main', 'robotCleanerMovement', 'setRobotCleanerMovement', ['homing']);
        state = MatterRvcOperationalState.OperationalState.SEEKING_CHARGER;
        break;
      case 'pause':
      case 'stop':
        success = await this.sendSmartThingsCommand('main', 'robotCleanerMovement', 'setRobotCleanerMovement', ['pause']);
        state = MatterRvcOperationalState.OperationalState.PAUSED;
        break;
      default:
        this.log.error(`[RobotVacuumAdapter] Unknown operational state command: ${command}`);
        return false;
    }
    if (success) {
      this.currentOperationalState = state;
      this.pushOperationalState();
    }
    return success;
  }

  private async handleIdentifyCommand(identifyTime: number): Promise<boolean> {
    this.log.info(`[RobotVacuumAdapter] Identify locate request time=${identifyTime}s`);
    // Try multiple strategies for Samsung locate
    const strategies: Array<[string, string, any[]?]> = [
      ['main', 'execute', ['findMyRobot', {}]],
      ['main', 'execute', ['find', {}]],
      ['main', 'samsungce.robotCleanerOperatingState', ['setOperatingState', ['findingPet']]],
      ['main', 'audioNotification', ['playTrack', ['https://example.com/locate.mp3', 80]]],
    ];
    for (const [comp, cap, args] of strategies) {
      const cmd = args?.[0] as string || cap;
      const cmdArgs = args?.slice(1) as any[] | undefined;
      this.log.info(`[RobotVacuumAdapter] Trying locate: ${cap}.${cmd}`);
      const ok = await this.sendSmartThingsCommand(comp, cap, cmd, cmdArgs);
      if (ok) {
        this.log.info(`[RobotVacuumAdapter] Locate succeeded via ${cap}.${cmd}`);
        return true;
      }
    }
    this.log.warn('[RobotVacuumAdapter] Locate failed - all strategies exhausted');
    // Still return true to satisfy Matter (device will blink in Home app even if no sound)
    return true;
  }

  private async handleTriggerEffectCommand(effectId: number): Promise<boolean> {
    this.log.info(`[RobotVacuumAdapter] TriggerEffect effectId=${effectId}`);
    return this.handleIdentifyCommand(10);
  }

  private async handleCleanModeCommand(command: string, args?: unknown[]): Promise<boolean> {
    if (command !== 'changeToMode' || !args || args.length === 0) {
      return false;
    }
    const mode = args[0] as number;
    this.log.info(`[RobotVacuumAdapter] handleCleanModeCommand mode=${mode}`);

    let stType = this.mapMatterCleanModeToCleaningType(mode);
    if (!stType) {
      this.log.error(`[RobotVacuumAdapter] CleanMode ${mode} not mapped to cleaningType`);
      this.log.warn(`[RobotVacuumAdapter] cleaningType ${stType} not in supported ${this.supportedCleaningTypes.join(',')} - trying anyway`);
      return false;
    }

    const success = await this.sendSmartThingsCommand('main', 'samsungce.robotCleanerCleaningType', 'setCleaningType', [stType]);
    if (success) {
      this.currentCleanMode = mode;
      this.matterApi?.updateAccessoryState(this.accessory!.UUID, MatterClusterNames.RvcCleanMode, { currentMode: mode });
    } else {
      this.log.error(`[RobotVacuumAdapter] Failed to execute setCleaningType`)
    }
    return success;
  }

  private async handleRunModeCommand(command: string, args?: unknown[]): Promise<boolean> {
    this.log.info(`[RobotVacuumAdapter] handleRunModeCommand command=${command} args=${JSON.stringify(args)}`);
    if (command !== 'changeToMode' || !args || args.length === 0) return false;
    const mode = args[0] as number;
    const stMode = this.mapMatterRunModeToCleaningMode(mode);
    if (!stMode) {
      this.log.error(`[RobotVacuumAdapter] Unsupported Matter RunMode: ${mode}`);
      this.log.warn(`[RobotVacuumAdapter] Supported RunModes: ${this.supportedCleaningModes.join(',')} - trying anyway`);
      return false;
    }

    this.log.info(`[RobotVacuumAdapter] setCleaningMode ${stMode} for Matter mode ${mode} selectedAreas=${JSON.stringify(this.selectedAreas)}`);
    // If rooms are selected, send area cleaning together with runmode change
    let success = false;
    const areaPayload = this.getSelectedAreaPayload();
    if (areaPayload && stMode !== 'stop' && stMode !== 'idle') {
      this.log.info(`[RobotVacuumAdapter] RunMode change with selectedAreas -> setCleaningMode area ${JSON.stringify(areaPayload)} + movement`);
      const modeOk = await this.sendSmartThingsCommand('main', 'samsungce.robotCleanerCleaningMode', 'setCleaningMode', ['area', areaPayload]);
      if (!modeOk) {
        success = false;
      } else {
        await new Promise(r => setTimeout(r, 500));
        success = await this.sendSmartThingsCommand('main', 'robotCleanerMovement', 'setRobotCleanerMovement', ['cleaning']);
      }
    } else {
      success = await this.sendSmartThingsCommand('main', 'samsungce.robotCleanerCleaningMode', 'setCleaningMode', [stMode]);
    }
    if (success) {
      this.currentRunMode = mode;
      this.matterApi?.updateAccessoryState(this.accessory!.UUID, MatterClusterNames.RvcRunMode, { currentMode: mode });

      if (mode === MatterRvcRunMode.Type.IDLE) {
        this.currentOperationalState = MatterRvcOperationalState.OperationalState.STOPPED;
        this.pushOperationalState();
      }
    } else {
      this.log.error(`[RobotVacuumAdapter] Failed to execute setCleaningMode`)
    }
    return success;
  }

  private async handleServiceAreaCommand(command: string, args?: unknown[]): Promise<boolean> {
    this.log.info(`[RobotVacuumAdapter] ServiceArea command ${command} args=${JSON.stringify(args)}`);
    if (command === 'selectAreas' || command === 'selectAreasRequest') {
      const areaIds = (args?.[0] as number[]) || [];
      return this.handleServiceAreaSelectAreas(areaIds);
    }
    if (command === 'skipArea') {
      const areaId = args?.[0] as number;
      return this.handleServiceAreaSkipArea(areaId);
    }
    return false;
  }

  private async handleServiceAreaSelectAreas(areaIds: number[]): Promise<boolean> {
    this.log.info(`[RobotVacuumAdapter] SelectAreas ${areaIds} (store for next run/start)`);
    // Validate against visible map and store separately on Matter side
    const mapListStatus: any = this.getCapabilityStatus('samsungce.robotCleanerMapList');
    const maps: any[] = mapListStatus?.maps?.value || this.getMainStatus()['samsungce.robotCleanerMapList']?.maps?.value || [];
    if (!maps || maps.length === 0) {
      this.log.warn('[RobotVacuumAdapter] No maps available for SelectAreas');
      return false;
    }
    const currentMapId = (mapListStatus as any)?.currentMapId?.value || this.getMainStatus()['samsungce.robotCleanerMapList']?.currentMapId?.value;
    let visibleMapId: string | null = currentMapId ? String(currentMapId) : null;
    if (!visibleMapId) {
      const targetMaps = [...maps].sort((a: any, b: any) => {
        const aTime = new Date(a.updatedTime || a.createdTime || 0).getTime();
        const bTime = new Date(b.updatedTime || b.createdTime || 0).getTime();
        return bTime - aTime;
      });
      visibleMapId = targetMaps[0]?.id ? String(targetMaps[0].id) : String(maps[0].id);
    }
    const validAreaIds: number[] = [];
    for (const aid of areaIds) {
      const mapId = Math.floor(aid / 100);
      if (String(mapId) !== String(visibleMapId)) {
        this.log.warn(`[RobotVacuumAdapter] Ignoring area ${aid} from non-visible map ${mapId} (visible=${visibleMapId})`);
        continue;
      }
      const map = maps.find((m: any) => parseInt(m.id, 10) === mapId);
      const areaId = aid % 100;
      const area = map?.areaInfo?.find((a: any) => parseInt(a.id, 10) === areaId);
      if (!area) {
        this.log.warn(`[RobotVacuumAdapter] Ignoring unknown area ${aid}`);
        continue;
      }
      validAreaIds.push(aid);
    }
    this.selectedAreas = validAreaIds;
    this.log.info(`[RobotVacuumAdapter] Stored selectedAreas=${JSON.stringify(this.selectedAreas)} for visible map ${visibleMapId}`);
    this.matterApi?.updateAccessoryState(this.accessory!.UUID, MatterClusterNames.ServiceArea, { selectedAreas: [...this.selectedAreas] });
    return true;
  }

  private async handleServiceAreaSkipArea(areaId: number): Promise<boolean> {
    this.log.info(`[RobotVacuumAdapter] SkipArea ${areaId} - not directly supported, ignoring`);
    return true;
  }

  protected pushStateToMatter(state: NormalizedMatterState): void {
    if (!this.matterApi || !this.context) {
      return;
    }
    const uuid = this.accessory!.UUID;
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
    if (state[MatterClusterNames.ServiceArea]) {
      this.matterApi?.updateAccessoryState(uuid, MatterClusterNames.ServiceArea, state[MatterClusterNames.ServiceArea]);
    }
  }

  private pushOperationalState(): void {
    if (!this.matterApi || !this.context) {
      return;
    }
    this.matterApi?.updateAccessoryState(this.accessory!.UUID, MatterClusterNames.RvcOperationalState, {
      operationalState: this.currentOperationalState,
      operationalError: { errorStateId: MatterRvcOperationalState.OperationalError.NO_ERROR },
    });
  }

  private updateOperationalStateFromPower(powerOn: boolean): void {
    this.currentOperationalState = powerOn ? MatterRvcOperationalState.OperationalState.RUNNING : MatterRvcOperationalState.OperationalState.STOPPED;
    this.pushOperationalState();
  }

  protected handleSmartThingsEvent(event: ShortEvent): void {
    const capability = event.capability as string;
    const attribute = event.attribute;
    const value = event.value;
    this.log.debug(`[RobotVacuumAdapter] Event: ${capability}.${attribute} = ${JSON.stringify(value)}`);
    switch (capability) {
      case 'samsungce.robotCleanerOperatingState': this.handleOperatingStateEvent(attribute, value); break;
      case 'samsungce.robotCleanerCleaningMode': this.handleSamsungCleaningModeEvent(attribute, value); break;
      case 'robotCleanerCleaningMode': this.handleStandardCleaningModeEvent(attribute, value); break;
      case 'robotCleanerTurboMode': this.handleTurboModeEvent(attribute, value); break;
      case 'robotCleanerMovement': this.handleMovementEvent(attribute, value); break;
      case 'samsungce.robotCleanerCleaningType': this.handleCleaningTypeEvent(attribute, value); break;
      case 'samsungce.robotCleanerDrivingMode': this.handleDrivingModeEvent(attribute, value); break;
      case 'samsungce.robotCleanerWaterSprayLevel': this.handleWaterSprayEvent(attribute, value); break;
      case 'battery': this.handleBatteryEvent(attribute, value); break;
      case 'switch': this.handleSwitchEvent(attribute, value); break;
      case 'samsungce.robotCleanerMapList': this.handleMapListEvent(attribute, value); break;
      case 'audioNotification': this.handleAudioNotificationEvent(attribute, value); break;
      default: this.log.debug(`[RobotVacuumAdapter] Unhandled event ${capability}.${attribute}`);
    }
  }

  private handleOperatingStateEvent(attribute: string, value: unknown): void {
    this.log.debug(`[RobotVacuumAdapter] OperatingState attr ${attribute}=${JSON.stringify(value)}`);
    if (attribute === 'supportedOperatingState') {
      this.supportedOperatingStates = value as string[];
      this.log.debug(`[RobotVacuumAdapter] Supported operating states: ${this.supportedOperatingStates.join(',')}`);
      return;
    }
    if (attribute !== 'operatingState') {
      return;
    }
    const state = value as string;
    const mapped = this.mapSamsungOperatingStateToMatter(state);
    if (mapped !== undefined && mapped !== this.currentOperationalState) {
      this.currentOperationalState = mapped;
      this.pushOperationalState();
      // update PowerSource charge state as well
      this.matterApi?.updateAccessoryState(this.accessory!.UUID, MatterClusterNames.PowerSource, {
        batChargeLevel: this.batteryLevelToMatterEnum(this.currentBatteryLevel),
        batPercentRemaining: this.currentBatteryLevel * 2,
        batChargeState: this.getMatterBatChargeState(),
      });
    }
    // Also handle charging state for PowerSource
    if (state === 'charging' || state === 'chargingForRemainingJob') {
      this.currentCharging = true;
    } else if (state === 'charged' || state === 'flexCharged' || state === 'docked') {
      this.currentCharging = false;
    }
  }

  private handleSamsungCleaningModeEvent(attribute: string, value: unknown): void {
    this.log.debug(`[RobotVacuumAdapter] SamsungCleaningMode attr ${attribute}=${JSON.stringify(value)}`);
    if (attribute === 'supportedCleaningMode') {
      this.supportedCleaningModes = value as string[];
      this.log.debug(`[RobotVacuumAdapter] Supported cleaning modes: ${this.supportedCleaningModes.join(',')}`);
      return;
    }
    if (attribute !== 'cleaningMode') return;
    const mode = value as string;
    const mapped = this.normalizeCleaningModeToRunMode(mode);
    if (mapped === undefined || mapped === this.currentRunMode) return;
    const isRunning = this.currentOperationalState === MatterRvcOperationalState.OperationalState.RUNNING
      || this.currentOperationalState === MatterRvcOperationalState.OperationalState.PAUSED;
    if (!isRunning && this.currentRunMode === MatterRvcRunMode.Type.IDLE) {
      this.log.debug(`[RobotVacuumAdapter] cleaningMode ${mode} -> RunMode ${mapped} but idle, keep Idle`);
      return;
    }
    this.currentRunMode = mapped;
    this.matterApi?.updateAccessoryState(this.accessory!.UUID, MatterClusterNames.RvcRunMode, { currentMode: mapped });
  }

  private handleStandardCleaningModeEvent(attribute: string, value: unknown): void {
    if (attribute !== 'robotCleanerCleaningMode') return;
    const mode = value as string;
    const mapped = this.mapStandardCleaningModeToMatter(mode);
    if (mapped === undefined) return;
    const runMapped = this.normalizeCleaningModeToRunMode(mode);
    if (runMapped !== undefined && runMapped !== this.currentRunMode) {
      const isRunning = this.currentOperationalState === MatterRvcOperationalState.OperationalState.RUNNING
        || this.currentOperationalState === MatterRvcOperationalState.OperationalState.PAUSED;
      if (!isRunning && this.currentRunMode === MatterRvcRunMode.Type.IDLE) return;
      this.currentRunMode = runMapped;
      this.matterApi?.updateAccessoryState(this.accessory!.UUID, MatterClusterNames.RvcRunMode, { currentMode: runMapped });
    }
  }

  private handleTurboModeEvent(attribute: string, value: unknown): void {
    if (attribute !== 'robotCleanerTurboMode') {
      return;
    }
    // Turbo mode is not exposed in Matter CleanMode (handled separately if needed)
    this.log.debug(`[RobotVacuumAdapter] TurboMode updated: ${value}`);
  }

  private handleMovementEvent(attribute: string, value: unknown): void {
    this.log.debug(`[RobotVacuumAdapter] Movement attr ${attribute}=${JSON.stringify(value)}`);
    if (attribute !== 'robotCleanerMovement') {
      return;
    }
    const mode = value as string;
    const mapped = this.mapRobotCleanerMovementToMatter(mode);
    if (mapped !== undefined && mapped !== this.currentOperationalState) {
      // Movement is operational state, not RunMode
      this.currentOperationalState = mapped;
      this.pushOperationalState();
    }
  }

  private handleCleaningTypeEvent(attribute: string, value: unknown): void {
    this.log.debug(`[RobotVacuumAdapter] CleaningType attr ${attribute}=${JSON.stringify(value)}`);
    if (attribute === 'supportedCleaningTypes' || attribute === 'availableCleaningTypes') {
      this.supportedCleaningTypes = value as string[];
      this.log.debug(`[RobotVacuumAdapter] Supported cleaning types: ${this.supportedCleaningTypes.join(',')}`);
      return;
    }
    if (attribute !== 'cleaningType') return;
    const type = value as string;
    const cleanMode = this.mapSamsungCleaningTypeToCleanMode(type);
    if (cleanMode !== undefined && cleanMode !== this.currentCleanMode) {
      this.currentCleanMode = cleanMode;
      this.matterApi?.updateAccessoryState(this.accessory!.UUID, MatterClusterNames.RvcCleanMode, { currentMode: cleanMode });
    }
  }

  private handleDrivingModeEvent(attribute: string, value: unknown): void {
    this.log.debug(`[RobotVacuumAdapter] DrivingMode attr ${attribute}=${JSON.stringify(value)}`);
    if (attribute === 'supportedDrivingModes') {
      this.supportedDrivingModes = value as string[];
      return;
    }
    if (attribute !== 'drivingMode') {
      return;
    }
    const mode = value as string;
    this.currentDrivingMode = mode;
    // DrivingMode not directly mapped to Matter, but could affect CleanMode label
    this.log.debug(`[RobotVacuumAdapter] DrivingMode updated to ${mode}`);
  }

  private handleWaterSprayEvent(attribute: string, value: unknown): void {
    this.log.debug(`[RobotVacuumAdapter] WaterSpray attr ${attribute}=${JSON.stringify(value)}`);
    if (attribute === 'supportedWaterSprayLevels' || attribute === 'availableWaterSprayLevels') {
      this.supportedWaterLevels = value as string[];
      return;
    }
    if (attribute !== 'waterSprayLevel') {
      return;
    }
    this.currentWaterSprayLevel = value as string;
    this.log.debug(`[RobotVacuumAdapter] WaterSprayLevel updated to ${this.currentWaterSprayLevel}`);
  }

  private handleBatteryEvent(attribute: string, value: unknown): void {
    if (attribute !== 'battery') {
      return;
    }
    const level = value as number;
    if (typeof level === 'number' && level !== this.currentBatteryLevel) {
      this.currentBatteryLevel = Math.max(0, Math.min(100, level));
      this.matterApi?.updateAccessoryState(this.accessory!.UUID, MatterClusterNames.PowerSource, {
        batChargeLevel: this.batteryLevelToMatterEnum(this.currentBatteryLevel),
        batPercentRemaining: this.currentBatteryLevel * 2,
        batChargeState: this.getMatterBatChargeState(),
      });
    }
  }

  private handleMapListEvent(attribute: string, value: unknown): void {
    this.log.debug(`[RobotVacuumAdapter] MapList attr ${attribute}=${JSON.stringify(value).substring(0, 500)}`);
    // Rebuild ServiceArea when maps change
    const serviceArea = this.buildServiceAreaCluster();
    if (serviceArea) {
      this.matterApi?.updateAccessoryState(this.accessory!.UUID, MatterClusterNames.ServiceArea, serviceArea);
    }
  }

  private handleAudioNotificationEvent(attribute: string, value: unknown): void {
    this.log.debug(`[RobotVacuumAdapter] AudioNotification attr ${attribute}=${JSON.stringify(value)}`);
  }

  private batteryLevelToMatterEnum(level: number): number {
    if (level >= 50) {
      return MatterPowerSource.BatChargeLevel.OK;
    }
    if (level >= 20) {
      return MatterPowerSource.BatChargeLevel.WARNING;
    }
    return MatterPowerSource.BatChargeLevel.CRITICAL;
  }

  private handleSwitchEvent(attribute: string, value: unknown): void {
    if (attribute !== 'switch') {
      return;
    }
    const state = value as string;
    const powerOn = state === 'on';
    if (powerOn !== this.currentPowerOn) {
      this.currentPowerOn = powerOn;
      this.matterApi?.updateAccessoryState(this.accessory!.UUID, MatterClusterNames.OnOff, { onOff: powerOn });
      this.updateOperationalStateFromPower(powerOn);
    }
  }

  // === Matter -> SmartThings mappings ===

  private mapSamsungOperatingStateToMatter(state: string): number | undefined {
    const m = MatterRvcOperationalState.OperationalState;
    const map: Record<string, number> = {
      idle: m.STOPPED, standby: m.STOPPED, homing: m.SEEKING_CHARGER, cleaning: m.RUNNING,
      charging: m.CHARGING, chargingForRemainingJob: m.CHARGING, charged: m.DOCKED, creatingMap: m.UPDATING_MAPS,
      drainingWater: m.RUNNING, flexCharged: m.DOCKED, moving: m.RUNNING, paused: m.PAUSED, error: m.ERROR,
      relocal: m.RUNNING, descaling: m.RUNNING, waitingForDescaling: m.PAUSED, exploring: m.RUNNING,
      emitDust: m.EMPTYING_DUST_BIN, monitoring: m.RUNNING, monitoringAutomation: m.RUNNING, patrol: m.RUNNING,
      manual: m.RUNNING, processing: m.RUNNING, mediaPlaying: m.RUNNING, messaging: m.RUNNING, findingPet: m.RUNNING,
      reserved: m.STOPPED, factoryReset: m.ERROR, calibrating: m.RUNNING, welcoming: m.RUNNING,
      detachingMopPad: m.STOPPED, waitingForChangingMopPad: m.PAUSED, attachingMopPad: m.STOPPED, attachingMopPadForRemainingJob: m.STOPPED,
      washingMop: m.CLEANING_MOP, sterilizingMop: m.CLEANING_MOP, dryingMop: m.CLEANING_MOP, mopWashingPaused: m.PAUSED,
      spinDrying: m.CLEANING_MOP, preparingWater: m.FILLING_WATER_TANK, supplyingWater: m.FILLING_WATER_TANK,
      sabbath: m.STOPPED, powerSaving: m.STOPPED, suspend: m.PAUSED, emptyStation: m.EMPTYING_DUST_BIN,
      internalWash: m.CLEANING_MOP, cleaningStart: m.RUNNING, cleaningEnd: m.STOPPED,
    };
    return map[state];
  }

  private mapRobotCleanerMovementToMatter(state: string): number | undefined {
    const m = MatterRvcOperationalState.OperationalState;
    const map: Record<string, number> = {
      homing: m.SEEKING_CHARGER, idle: m.STOPPED, charging: m.CHARGING, alarm: m.ERROR, powerOff: m.STOPPED,
      reserve: m.STOPPED, point: m.RUNNING, after: m.RUNNING, cleaning: m.RUNNING, pause: m.PAUSED, washingMop: m.CLEANING_MOP,
    };
    return map[state];
  }

  private mapSamsungCleaningModeToMatter(mode: string): number | undefined {
    // Legacy cleaningMode not used for CleanMode (now mapped to cleaningType); fallback to VACUUM
    return MatterRvcCleanMode.Type.VACUUM;
  }

  private mapStandardCleaningModeToMatter(mode: string): number | undefined {
    return MatterRvcCleanMode.Type.VACUUM;
  }

  private mapMatterCleanModeToSmartThings(mode: number): string | null {
    // Not used (CleanMode now uses cleaningType); keep for compat
    return 'auto';
  }

  private mapMatterRunModeToSmartThings(mode: number): string | null {
    // Deprecated: RunMode now maps to cleaningMode, use mapMatterRunModeToCleaningMode
    return this.mapMatterRunModeToCleaningMode(mode);
  }

  private mapSamsungCleaningTypeToRunMode(type: string): number | undefined {
    // RunMode now represents cleaningMode patterns, not cleaningType; fallback to AUTO
    return MatterRvcRunMode.Type.AUTO;
  }

  private mapSamsungCleaningTypeToCleanMode(type: string): number | undefined {
    return MatterRvcCleanModeMap[type]?.mode;
  }

  private mapMatterCleanModeToCleaningType(mode: number): string | null {
    for (const [k, v] of Object.entries(MatterRvcCleanModeMap)) if (v.mode === mode) return k;
    return null;
  }

  private mapMatterRunModeToCleaningMode(mode: number): string | null {
    for (const [k, v] of Object.entries(MatterRvcRunModeMap)) if (v.mode === mode) return k;
    return null;
  }

  private mapCleaningModeToRunMode(mode: string): number | undefined {
    return MatterRvcRunModeMap[mode]?.mode;
  }

  private normalizeCleaningModeToRunMode(mode: string): number | undefined {
    const ALLOWED = new Set([...MatterRvcRequiredRunMode, ...MatterRvcOptionalRunMode]);
    if (ALLOWED.has(mode)) {
      return (MatterRvcRunModeMap as any)[mode]?.mode;
    }
    const entry = (MatterRvcRunModeMap as any)[mode];
    if (entry?.tags?.includes(MatterRvcRunMode.Tag.CLEANING)) {
      this.log.info(`[RobotVacuumAdapter] cleaningMode ${mode} is CLEANING -> normalizing RunMode to AUTO`);
      return MatterRvcRunMode.Type.AUTO;
    }
    return MatterRvcRunMode.Type.IDLE;
  }

  private mapCleaningTypeToCleanMode(type: string): number | undefined {
    return this.mapSamsungCleaningTypeToCleanMode(type);
  }

  getInitialState(): NormalizedMatterState {
    this.log.debug(`[RobotVacuumAdapter] getInitialState fetching from ${this.multiServiceAccessory.components.length} components`);
    const mainStatus = this.getMainStatus();
    this.log.debug(`[RobotVacuumAdapter] FULL main status keys: ${Object.keys(mainStatus).join(',')}`);

    // Extract each capability
    const opStateStatus: any = this.getCapabilityStatus('samsungce.robotCleanerOperatingState');
    const sCleanModeStatus: any = this.getCapabilityStatus('samsungce.robotCleanerCleaningMode');
    const stdCleanModeStatus: any = this.getCapabilityStatus('robotCleanerCleaningMode');
    const movementStatus: any = this.getCapabilityStatus('robotCleanerMovement');
    const turboStatus: any = this.getCapabilityStatus('robotCleanerTurboMode');
    const cleaningTypeStatus: any = this.getCapabilityStatus('samsungce.robotCleanerCleaningType');
    const drivingStatus: any = this.getCapabilityStatus('samsungce.robotCleanerDrivingMode');
    const waterStatus: any = this.getCapabilityStatus('samsungce.robotCleanerWaterSprayLevel');
    const batteryStatus: any = this.getCapabilityStatus('battery');
    const switchStatus: any = this.getCapabilityStatus('switch');
    const mapListStatus: any = this.getCapabilityStatus('samsungce.robotCleanerMapList');

    this.log.debug(`[RobotVacuumAdapter] opState=${JSON.stringify(opStateStatus?.operatingState)} cleaningType=${JSON.stringify(cleaningTypeStatus?.cleaningType)} sCleanMode=${JSON.stringify(sCleanModeStatus?.cleaningMode)} movement=${JSON.stringify(movementStatus?.robotCleanerMovement)} turbo=${JSON.stringify(turboStatus?.robotCleanerTurboMode)} driving=${JSON.stringify(drivingStatus?.drivingMode)} water=${JSON.stringify(waterStatus?.waterSprayLevel)} battery=${JSON.stringify(batteryStatus?.battery)} switch=${JSON.stringify(switchStatus?.switch)}`);

    // Capture supported values
    if (opStateStatus?.supportedOperatingState?.value) {
      this.supportedOperatingStates = opStateStatus.supportedOperatingState.value;
      this.log.debug(`[RobotVacuumAdapter] supportedOperatingStates: ${this.supportedOperatingStates.length}`);
    }
    if (sCleanModeStatus?.supportedCleaningMode?.value) {
      this.supportedCleaningModes = sCleanModeStatus.supportedCleaningMode.value;
      this.log.debug(`[RobotVacuumAdapter] supportedCleaningModes: ${this.supportedCleaningModes.join(',')}`);
    }
    if (cleaningTypeStatus?.supportedCleaningTypes?.value) {
      this.supportedCleaningTypes = cleaningTypeStatus.supportedCleaningTypes.value;
      this.log.debug(`[RobotVacuumAdapter] supportedCleaningTypes: ${this.supportedCleaningTypes.join(',')}`);
    }
    if (drivingStatus?.supportedDrivingModes?.value) {
      this.supportedDrivingModes = drivingStatus.supportedDrivingModes.value;
      this.log.debug(`[RobotVacuumAdapter] supportedDrivingModes: ${this.supportedDrivingModes.join(',')}`);
    }
    if (waterStatus?.supportedWaterSprayLevels?.value) {
      this.supportedWaterLevels = waterStatus.supportedWaterSprayLevels.value;
      this.log.debug(`[RobotVacuumAdapter] supportedWaterLevels: ${this.supportedWaterLevels.join(',')}`);
    }
    if (mapListStatus?.maps?.value) {
      this.log.debug(`[RobotVacuumAdapter] maps: ${mapListStatus.maps.value.length} maps`);
    }
    // Init Matter selected areas once at init; after that keep separately (not synced via polling)
    if (this.lastMapSignature === null) {
      this.selectedAreas = [];
      this.lastMapSignature = this.getMapSignature();
      this.log.debug(`[RobotVacuumAdapter] init selectedAreas=${JSON.stringify(this.selectedAreas)} mapSig=${this.lastMapSignature}`);
    }
    // Init basic info trackers for firmware/model/manufacturer change detection
    if (this.lastFirmwareRevision === null && this.context) {
      this.lastFirmwareRevision = this.context.firmwareRevision || null;
      this.lastModel = this.context.model || null;
      this.lastManufacturer = this.context.manufacturerName || null;
    }

    // Determine operational state - priority: samsungce operatingState > movement
    if (opStateStatus?.operatingState?.value) {
      const mapped = this.mapSamsungOperatingStateToMatter(opStateStatus.operatingState.value);
      if (mapped !== undefined) {
        this.currentOperationalState = mapped;
      }
      if (opStateStatus.operatingState.value === 'charging' || opStateStatus.operatingState.value === 'chargingForRemainingJob') {
        this.currentCharging = true;
      } else if (['charged', 'flexCharged', 'docked'].includes(opStateStatus.operatingState.value)) {
        this.currentCharging = false;
      }
    } else if (movementStatus?.robotCleanerMovement?.value) {
      const mapped = this.mapRobotCleanerMovementToMatter(movementStatus.robotCleanerMovement.value);
      if (mapped !== undefined) {
        this.currentOperationalState = mapped;
      }
    }

    // DrivingMode and Water are not operational, just stored
    if (drivingStatus?.drivingMode?.value) {
      this.currentDrivingMode = drivingStatus.drivingMode.value;
    }
    if (waterStatus?.waterSprayLevel?.value) {
      this.currentWaterSprayLevel = waterStatus.waterSprayLevel.value;
    }

    // CleanMode -> cleaningType (no auto-start), RunMode -> cleaningMode (stored)
    if (cleaningTypeStatus?.cleaningType?.value) {
      const cleanMapped = this.mapSamsungCleaningTypeToCleanMode(cleaningTypeStatus.cleaningType.value);
      if (cleanMapped !== undefined) this.currentCleanMode = cleanMapped;
    } else if (sCleanModeStatus?.cleaningMode?.value) {
      const mapped = this.mapSamsungCleaningModeToMatter(sCleanModeStatus.cleaningMode.value);
      if (mapped !== undefined) this.currentCleanMode = mapped;
    } else if (stdCleanModeStatus?.robotCleanerCleaningMode?.value) {
      const mapped = this.mapStandardCleaningModeToMatter(stdCleanModeStatus.robotCleanerCleaningMode.value);
      if (mapped !== undefined) this.currentCleanMode = mapped;
    }

    if (sCleanModeStatus?.cleaningMode?.value) {
      const runMapped = this.normalizeCleaningModeToRunMode(sCleanModeStatus.cleaningMode.value);
      if (runMapped !== undefined) {
        const isRunning = this.currentOperationalState === MatterRvcOperationalState.OperationalState.RUNNING || this.currentOperationalState === MatterRvcOperationalState.OperationalState.PAUSED;
        if (isRunning) this.currentRunMode = runMapped;
        else if (this.currentRunMode !== MatterRvcRunMode.Type.IDLE) this.currentRunMode = runMapped;
        else this.log.debug(`[RobotVacuumAdapter] cleaningMode ${sCleanModeStatus.cleaningMode.value} -> RunMode ${runMapped} but idle, keep Idle`);
      }
    }
    if (movementStatus?.robotCleanerMovement?.value && this.currentRunMode === MatterRvcRunMode.Type.IDLE) {
      // movement also could indicate run mode, but we treat as operational state already
    }

    if (batteryStatus?.battery?.value !== undefined) {
      this.currentBatteryLevel = Math.max(0, Math.min(100, batteryStatus.battery.value));
    }
    if (switchStatus?.switch?.value) {
      this.currentPowerOn = switchStatus.switch.value === 'on';
      // Don't override operational state if we already have more specific state
      if (this.currentOperationalState === MatterRvcOperationalState.OperationalState.STOPPED && this.currentPowerOn) {
        this.currentOperationalState = MatterRvcOperationalState.OperationalState.RUNNING;
      } else if (!this.currentPowerOn) {
        this.currentOperationalState = MatterRvcOperationalState.OperationalState.STOPPED;
      }
    }
    this.currentCharging = this.currentOperationalState === MatterRvcOperationalState.OperationalState.CHARGING;

    this.log.debug(`[RobotVacuumAdapter] getInitialState -> OpState=${this.currentOperationalState} RunMode=${this.currentRunMode} CleanMode=${this.currentCleanMode} Battery=${this.currentBatteryLevel} PowerOn=${this.currentPowerOn} Charging=${this.currentCharging}`);

    return {
      [MatterClusterNames.OnOff]: { onOff: this.currentPowerOn },
      [MatterClusterNames.RvcOperationalState]: { operationalState: this.currentOperationalState, operationalError: { errorStateId: MatterRvcOperationalState.OperationalError.NO_ERROR } },
      [MatterClusterNames.RvcCleanMode]: { currentMode: this.currentCleanMode },
      [MatterClusterNames.RvcRunMode]: { currentMode: this.currentRunMode },
      [MatterClusterNames.PowerSource]: {
        batChargeLevel: this.batteryLevelToMatterEnum(this.currentBatteryLevel),
        batPercentRemaining: this.currentBatteryLevel * 2,
        batChargeState: this.getMatterBatChargeState(),
      },
      ...(this.buildServiceAreaCluster() ? { [MatterClusterNames.ServiceArea]: this.buildServiceAreaCluster() } : {}),
    };
  }
}
