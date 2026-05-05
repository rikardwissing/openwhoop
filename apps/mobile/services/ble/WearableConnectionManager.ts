import { BleManager, type Device, type Subscription } from 'react-native-ble-plx';

import {
  CMD_FROM_STRAP_UUID,
  CMD_TO_STRAP_UUID,
  DATA_FROM_STRAP_UUID,
  EVENTS_FROM_STRAP_UUID,
  MEMFAULT_UUID,
  WEARABLE_SERVICE_UUID,
} from '@/services/ble/constants';
import { PacketAssembler, base64ToBytes, bytesToBase64, getBatteryLevelPacket, parseNotification, type FramedPacket, type ParsedNotification } from '@/services/ble/codec';
import { createWearableBleManager, getRestoredWearableDevice } from '@/services/ble/bleManager';
import { resolveScanDeviceName } from '@/services/ble/deviceNaming';
import type { DeviceState, SyncProgress, WearableScanResult } from '@/types/device';

const CONNECT_TIMEOUT_MS = 15_000;
const CONNECT_SCAN_TIMEOUT_MS = 8_000;
const COMMAND_WRITE_DELAY_MS = 120;
const LIVE_HEALTH_CHECK_INTERVAL_MS = 10_000;
const LIVE_PACKET_STALE_MS = 30_000;
const LIVE_PROBE_RESPONSE_GRACE_MS = 8_000;
const LIVE_UPDATES_RECONNECT_DELAY_MS = 3_000;

function delay(ms: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export interface RoutedWearablePacket {
  characteristic: string;
  frame: FramedPacket;
  parsed: ParsedNotification;
}

export type WearablePacketConsumer = (packet: RoutedWearablePacket) => void;

export interface WearableConnectionLease {
  device: Device;
  resolvedDeviceId: string;
  resolvedDeviceName: string | null;
  release: (options?: { disconnectIfIdle?: boolean }) => Promise<void>;
}

interface AcquireConnectionOptions {
  allowDiscoveryScan?: boolean;
  allowRescan?: boolean;
  requireExistingConnection?: boolean;
}

interface LiveConnectionCallbacks {
  onConnected?: (lease: WearableConnectionLease) => Promise<void> | void;
  onDisconnected?: () => Promise<void> | void;
  onError?: (error: unknown) => Promise<void> | void;
}

interface LiveConnectionSession {
  callbacks: LiveConnectionCallbacks;
  selected: DeviceState;
  stopped: boolean;
}

export interface LiveConnectionHandle {
  stop: () => Promise<void>;
}

export class WearableConnectionManager {
  private activeLeases = 0;
  private commandQueue = Promise.resolve();
  private connectionQueue = Promise.resolve();
  private device: Device | null = null;
  private disposed = false;
  private lastPacketAt: number | null = null;
  private liveHealthTimer: ReturnType<typeof setInterval> | null = null;
  private liveLease: WearableConnectionLease | null = null;
  private liveProbeStartedAt: number | null = null;
  private liveReconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private liveSession: LiveConnectionSession | null = null;
  private packetConsumers = new Set<WearablePacketConsumer>();
  private resolvedDeviceId: string | null = null;
  private resolvedDeviceName: string | null = null;
  private subscriptions: Subscription[] = [];

  constructor(private readonly manager: BleManager = createWearableBleManager()) {}

  async dispose() {
    this.disposed = true;
    this.clearLiveReconnect();
    this.stopLiveHealthWatch();
    this.removeMonitors();
    await this.disconnectCurrentDevice().catch(() => {});
    this.manager.destroy();
  }

  async scan(): Promise<WearableScanResult[]> {
    await this.ensurePoweredOn();

    const found = new Map<string, WearableScanResult>();

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.manager.stopDeviceScan();
        resolve(
          [...found.values()].sort((left, right) => (right.rssi ?? -999) - (left.rssi ?? -999)),
        );
      }, 5000);

      this.manager.startDeviceScan([WEARABLE_SERVICE_UUID], null, (error, device) => {
        if (error) {
          clearTimeout(timeout);
          this.manager.stopDeviceScan();
          reject(error);
          return;
        }

        if (!device) {
          return;
        }

        found.set(device.id, {
          id: device.id,
          name: resolveScanDeviceName(device),
          rssi: device.rssi ?? null,
        });
      });
    });
  }

  addPacketConsumer(consumer: WearablePacketConsumer) {
    this.packetConsumers.add(consumer);

    return () => {
      this.packetConsumers.delete(consumer);
    };
  }

  async startLiveConnection(
    selected: DeviceState,
    callbacks: LiveConnectionCallbacks,
  ): Promise<LiveConnectionHandle> {
    await this.stopLiveConnection();

    const session: LiveConnectionSession = {
      callbacks,
      selected,
      stopped: false,
    };
    this.liveSession = session;

    await this.connectLiveSession(session);

    return {
      stop: async () => {
        if (session.stopped) {
          return;
        }

        session.stopped = true;
        if (this.liveSession === session) {
          this.liveSession = null;
        }
        this.clearLiveReconnect();
        this.stopLiveHealthWatch();

        const lease = this.liveLease;
        this.liveLease = null;
        await lease?.release({ disconnectIfIdle: true });
      },
    };
  }

  async acquireConnection(
    selected: DeviceState,
    onProgress?: (progress: SyncProgress) => void,
    options?: AcquireConnectionOptions,
  ): Promise<WearableConnectionLease> {
    const connection = await this.withConnectionQueue(async () => {
      this.assertNotDisposed();
      await this.ensurePoweredOn();

      if (options?.requireExistingConnection) {
        const existing = await this.getConnectedCandidate(this.device);
        if (!existing || !this.matchesSelectedDevice(existing, selected)) {
          throw new Error('Live wearable connection is not active.');
        }

        const device = this.subscriptions.length > 0
          ? existing
          : await existing.discoverAllServicesAndCharacteristics();
        this.device = device;
        this.resolvedDeviceId = device.id;
        this.resolvedDeviceName = resolveScanDeviceName(device) ?? selected.name;
        this.installMonitors();
        return {
          device,
          resolvedDeviceId: this.resolvedDeviceId,
          resolvedDeviceName: this.resolvedDeviceName,
        };
      }

      const existing = await this.getConnectedCandidate(this.device);
      if (existing && this.matchesSelectedDevice(existing, selected)) {
        const device = this.subscriptions.length > 0
          ? existing
          : await existing.discoverAllServicesAndCharacteristics();
        this.device = device;
        this.resolvedDeviceId = device.id;
        this.resolvedDeviceName = resolveScanDeviceName(device) ?? this.resolvedDeviceName ?? selected.name;
        this.installMonitors();
        return {
          device,
          resolvedDeviceId: this.resolvedDeviceId,
          resolvedDeviceName: this.resolvedDeviceName,
        };
      }

      await this.disconnectCurrentDevice().catch(() => {});
      const connected = await this.connectSelectedWearable(selected, onProgress, options);
      this.device = connected.device;
      this.resolvedDeviceId = connected.resolvedDeviceId;
      this.resolvedDeviceName = connected.resolvedDeviceName;
      this.installMonitors();
      return connected;
    });

    let released = false;
    this.activeLeases += 1;

    return {
      ...connection,
      release: async (releaseOptions) => {
        if (released) {
          return;
        }

        released = true;
        this.activeLeases = Math.max(0, this.activeLeases - 1);

        if (releaseOptions?.disconnectIfIdle) {
          await this.disconnectIfIdle();
        }
      },
    };
  }

  async sendCommand(bytes: Uint8Array) {
    const task = this.commandQueue
      .catch(() => {})
      .then(async () => {
        this.assertNotDisposed();
        const device = await this.getConnectedCandidate(this.device);
        if (!device) {
          throw new Error('Device is not connected.');
        }

        await device.writeCharacteristicWithoutResponseForService(
          WEARABLE_SERVICE_UUID,
          CMD_TO_STRAP_UUID,
          bytesToBase64(bytes),
        );
        await delay(COMMAND_WRITE_DELAY_MS);
      });

    this.commandQueue = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }

  async disconnect() {
    this.clearLiveReconnect();
    this.stopLiveHealthWatch();
    this.liveSession = null;
    this.liveLease = null;
    this.activeLeases = 0;
    await this.disconnectCurrentDevice();
  }

  private async stopLiveConnection() {
    const session = this.liveSession;
    if (session) {
      session.stopped = true;
    }
    this.liveSession = null;
    this.clearLiveReconnect();
    this.stopLiveHealthWatch();

    const lease = this.liveLease;
    this.liveLease = null;
    await lease?.release({ disconnectIfIdle: true });
  }

  private async connectLiveSession(session: LiveConnectionSession) {
    if (this.disposed || session.stopped || this.liveSession !== session) {
      return;
    }

    try {
      const lease = await this.acquireConnection(session.selected, undefined, {
        allowDiscoveryScan: true,
        allowRescan: true,
      });

      if (this.disposed || session.stopped || this.liveSession !== session) {
        await lease.release({ disconnectIfIdle: true });
        return;
      }

      const previousLease = this.liveLease;
      this.liveLease = lease;

      try {
        await session.callbacks.onConnected?.(lease);
      } catch (error) {
        if (this.liveLease === lease) {
          this.liveLease = null;
        }
        await lease.release({ disconnectIfIdle: false });
        await this.disconnectCurrentDevice().catch(() => {});
        throw error;
      }

      await previousLease?.release({ disconnectIfIdle: false });
      this.startLiveHealthWatch(session);
    } catch (error) {
      if (session.stopped || this.liveSession !== session) {
        return;
      }

      await session.callbacks.onError?.(error);
      this.scheduleLiveReconnect(session);
    }
  }

  private scheduleLiveReconnect(session: LiveConnectionSession) {
    if (this.disposed || session.stopped || this.liveSession !== session || this.liveReconnectTimer) {
      return;
    }

    this.liveReconnectTimer = setTimeout(() => {
      this.liveReconnectTimer = null;
      void this.connectLiveSession(session);
    }, LIVE_UPDATES_RECONNECT_DELAY_MS);
  }

  private clearLiveReconnect() {
    if (!this.liveReconnectTimer) {
      return;
    }

    clearTimeout(this.liveReconnectTimer);
    this.liveReconnectTimer = null;
  }

  private startLiveHealthWatch(session: LiveConnectionSession) {
    this.stopLiveHealthWatch();
    this.lastPacketAt = Date.now();
    this.liveProbeStartedAt = null;
    this.liveHealthTimer = setInterval(() => {
      void this.runLiveHealthCheck(session);
    }, LIVE_HEALTH_CHECK_INTERVAL_MS);
  }

  private stopLiveHealthWatch() {
    if (this.liveHealthTimer) {
      clearInterval(this.liveHealthTimer);
      this.liveHealthTimer = null;
    }
    this.liveProbeStartedAt = null;
  }

  private async runLiveHealthCheck(session: LiveConnectionSession) {
    if (
      this.disposed ||
      session.stopped ||
      this.liveSession !== session ||
      this.liveReconnectTimer
    ) {
      return;
    }

    const device = await this.getConnectedCandidate(this.device);
    if (!device) {
      this.handleMonitorError(new Error('Live wearable connection was lost.'));
      return;
    }

    const lastPacketAt = this.lastPacketAt ?? 0;
    const staleForMs = Date.now() - lastPacketAt;
    if (staleForMs < LIVE_PACKET_STALE_MS) {
      this.liveProbeStartedAt = null;
      return;
    }

    if (this.liveProbeStartedAt === null) {
      this.liveProbeStartedAt = Date.now();
      await this.sendCommand(getBatteryLevelPacket()).catch((error) => {
        this.handleMonitorError(error);
      });
      return;
    }

    if (Date.now() - this.liveProbeStartedAt >= LIVE_PROBE_RESPONSE_GRACE_MS) {
      this.handleMonitorError(new Error('Live wearable updates stalled.'));
    }
  }

  private installMonitors() {
    if (!this.device || this.subscriptions.length > 0) {
      return;
    }

    this.lastPacketAt = Date.now();
    this.liveProbeStartedAt = null;

    const monitor = (characteristic: string, assembler: PacketAssembler) =>
      this.device!.monitorCharacteristicForService(WEARABLE_SERVICE_UUID, characteristic, (error, value) => {
        if (this.disposed) {
          return;
        }

        if (error) {
          this.handleMonitorError(error);
          return;
        }

        if (!value?.value) {
          return;
        }

        const frames = assembler.push(base64ToBytes(value.value));
        for (const frame of frames) {
          this.dispatchPacket({
            characteristic,
            frame,
            parsed: parseNotification(frame),
          });
        }
      });

    this.subscriptions.push(monitor(CMD_FROM_STRAP_UUID, new PacketAssembler()));
    this.subscriptions.push(monitor(EVENTS_FROM_STRAP_UUID, new PacketAssembler()));
    this.subscriptions.push(monitor(DATA_FROM_STRAP_UUID, new PacketAssembler()));
    this.subscriptions.push(monitor(MEMFAULT_UUID, new PacketAssembler()));
  }

  private dispatchPacket(packet: RoutedWearablePacket) {
    this.lastPacketAt = Date.now();
    this.liveProbeStartedAt = null;

    for (const consumer of [...this.packetConsumers]) {
      try {
        consumer(packet);
      } catch {}
    }
  }

  private handleMonitorError(error: unknown) {
    this.stopLiveHealthWatch();
    this.removeMonitors();
    this.device = null;
    this.resolvedDeviceId = null;
    this.resolvedDeviceName = null;

    const liveLease = this.liveLease;
    this.liveLease = null;
    void liveLease?.release({ disconnectIfIdle: false });

    const session = this.liveSession;
    if (!session || session.stopped) {
      return;
    }

    void session.callbacks.onDisconnected?.();
    void session.callbacks.onError?.(error);
    this.scheduleLiveReconnect(session);
  }

  private removeMonitors() {
    while (this.subscriptions.length > 0) {
      const subscription = this.subscriptions.pop();
      try {
        subscription?.remove();
      } catch {}
    }
  }

  private async disconnectIfIdle() {
    if (this.activeLeases > 0 || this.liveSession) {
      return;
    }

    await this.disconnectCurrentDevice().catch(() => {});
  }

  private async disconnectCurrentDevice() {
    this.manager.stopDeviceScan();
    this.removeMonitors();

    const device = this.device;
    this.device = null;
    this.resolvedDeviceId = null;
    this.resolvedDeviceName = null;

    if (device) {
      await device.cancelConnection().catch(() => {});
    }
  }

  private async ensurePoweredOn() {
    const current = await this.manager.state();
    if (current === 'PoweredOn') {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        subscription.remove();
        reject(new Error('Bluetooth did not power on in time.'));
      }, 8000);

      const subscription = this.manager.onStateChange((state) => {
        if (state === 'PoweredOn') {
          clearTimeout(timer);
          subscription.remove();
          resolve();
        }
      }, true);
    });
  }

  private async connectWithRetry(
    deviceId: string,
    deviceName: string,
    options?: {
      avoidDisconnectOnFirstAttempt?: boolean;
    },
  ) {
    let lastError: unknown = null;

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        if (!(options?.avoidDisconnectOnFirstAttempt && attempt === 1)) {
          await this.manager.cancelDeviceConnection(deviceId).catch(() => {});
        }
        return await this.manager.connectToDevice(deviceId, { timeout: CONNECT_TIMEOUT_MS });
      } catch (error) {
        lastError = error;
        if (attempt < 2) {
          await delay(400);
        }
      }
    }

    const message = lastError instanceof Error ? lastError.message : 'Unknown Bluetooth error.';
    throw new Error(`Unable to connect to ${deviceName}. ${message}`);
  }

  private async findKnownConnectionCandidate(
    selected: DeviceState,
  ) {
    const selectedId = selected.id;
    if (!selectedId) {
      throw new Error('No wearable selected.');
    }

    this.manager.stopDeviceScan();

    const restored = getRestoredWearableDevice(selectedId);
    if (restored && this.matchesSelectedDevice(restored, selected)) {
      return restored;
    }

    const knownById = await this.manager.devices([selectedId]).catch(() => []);
    if (knownById[0]) {
      return knownById[0];
    }

    const connected = await this.manager.connectedDevices([WEARABLE_SERVICE_UUID]).catch(() => []);
    const connectedMatch = connected.find((device) => this.matchesSelectedDevice(device, selected));
    if (connectedMatch) {
      return connectedMatch;
    }

    return null;
  }

  private async findConnectionCandidate(
    selected: DeviceState,
    options: {
      allowDiscoveryScan: boolean;
    },
    onProgress?: (progress: SyncProgress) => void,
  ) {
    const known = await this.findKnownConnectionCandidate(selected);
    if (known) {
      return known;
    }

    if (!options.allowDiscoveryScan) {
      return null;
    }

    onProgress?.({
      status: 'connecting',
      message: `Re-discovering ${selected.name ?? 'wearable'} before connecting...`,
    });

    const scanned = await this.scanForMatchingDevice(selected);
    if (scanned) {
      return scanned;
    }

    throw new Error(
      `Could not find ${selected.name ?? 'the selected wearable'} nearby. Scan again and keep the wearable awake.`,
    );
  }

  private async scanForMatchingDevice(selected: DeviceState) {
    return new Promise<Device | null>((resolve, reject) => {
      let fallbackMatch: Device | null = null;

      const finish = (device: Device | null) => {
        clearTimeout(timeout);
        this.manager.stopDeviceScan();
        resolve(device);
      };

      const timeout = setTimeout(() => {
        finish(fallbackMatch);
      }, CONNECT_SCAN_TIMEOUT_MS);

      this.manager.startDeviceScan([WEARABLE_SERVICE_UUID], null, (error, device) => {
        if (error) {
          clearTimeout(timeout);
          this.manager.stopDeviceScan();
          reject(error);
          return;
        }

        if (!device) {
          return;
        }

        if (device.id === selected.id) {
          finish(device);
          return;
        }

        if (this.matchesSelectedDevice(device, selected)) {
          if (!fallbackMatch || (device.rssi ?? -999) > (fallbackMatch.rssi ?? -999)) {
            fallbackMatch = device;
          }
        }
      });
    });
  }

  private matchesSelectedDevice(device: Device, selected: DeviceState) {
    if (selected.id && device.id === selected.id) {
      return true;
    }

    const candidateName = resolveScanDeviceName(device);
    return Boolean(selected.name && candidateName === selected.name);
  }

  private async getConnectedCandidate(candidate: Device | null) {
    if (!candidate) {
      return null;
    }

    try {
      return (await candidate.isConnected()) ? candidate : null;
    } catch {
      return null;
    }
  }

  private async connectSelectedWearable(
    selected: DeviceState,
    onProgress?: (progress: SyncProgress) => void,
    options?: {
      allowDiscoveryScan?: boolean;
      allowRescan?: boolean;
    },
  ) {
    const allowDiscoveryScan = options?.allowDiscoveryScan ?? true;
    const allowRescan = options?.allowRescan ?? true;
    let candidate = await this.findConnectionCandidate(selected, { allowDiscoveryScan }, onProgress);
    let resolvedDeviceId = candidate?.id ?? selected.id!;
    let resolvedDeviceName = (candidate ? resolveScanDeviceName(candidate) : null) ?? selected.name;
    let device = await this.getConnectedCandidate(candidate);

    if (!device) {
      try {
        device = await this.connectWithRetry(resolvedDeviceId, resolvedDeviceName ?? 'wearable', {
          avoidDisconnectOnFirstAttempt: candidate != null,
        });
      } catch (error) {
        if (!allowRescan) {
          throw error;
        }

        onProgress?.({
          status: 'connecting',
          message: `Direct connect failed. Re-scanning for ${resolvedDeviceName ?? 'wearable'}...`,
        });

        const rescanned = await this.scanForMatchingDevice({
          ...selected,
          id: resolvedDeviceId,
          name: resolvedDeviceName,
        });

        if (!rescanned) {
          throw error;
        }

        candidate = rescanned;
        resolvedDeviceId = rescanned.id;
        resolvedDeviceName = resolveScanDeviceName(rescanned) ?? resolvedDeviceName;
        device = await this.getConnectedCandidate(rescanned);

        if (!device) {
          device = await this.connectWithRetry(rescanned.id, resolvedDeviceName ?? 'wearable', {
            avoidDisconnectOnFirstAttempt: true,
          });
        }
      }
    }

    device = await device.discoverAllServicesAndCharacteristics();
    resolvedDeviceName = resolveScanDeviceName(device) ?? resolvedDeviceName;

    return {
      device,
      resolvedDeviceId,
      resolvedDeviceName,
    };
  }

  private async withConnectionQueue<T>(task: () => Promise<T>) {
    const next = this.connectionQueue
      .catch(() => {})
      .then(task);

    this.connectionQueue = next.then(
      () => undefined,
      () => undefined,
    );

    return next;
  }

  private assertNotDisposed() {
    if (this.disposed) {
      throw new Error('Wearable connection manager has been disposed.');
    }
  }
}
