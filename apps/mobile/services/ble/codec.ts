import { decode as decodeBase64, encode as encodeBase64 } from 'base-64';

import { CommandNumber, EventNumber, MetadataType, PacketType } from '@/services/ble/constants';

export interface SensorDataPacket {
  ppg_green: number;
  ppg_red_ir: number;
  spo2_red: number;
  spo2_ir: number;
  skin_temp_raw: number;
  ambient_light: number;
  led_drive_1: number;
  led_drive_2: number;
  resp_rate_raw: number;
  signal_quality: number;
  skin_contact: number;
  accel_gravity: [number, number, number];
}

export interface HistoryReadingPacket {
  unix: number;
  bpm: number;
  rr: number[];
  sensorData: SensorDataPacket | null;
  imuSampleCount: number;
}

export interface MetadataPacket {
  kind: MetadataType;
  unix: number;
  data: number;
}

export interface VersionInfoPacket {
  harvard: string;
  boylston: string;
}

export interface DeviceNamePacket {
  command: number;
  name: string;
}

export interface BatteryLevelPacket {
  command: number;
  chargeTenthsPercent: number;
  percent: number;
}

export interface BodyStatusPacket {
  command: number;
  rawStatus: number;
  bodyStatus: 'on-body' | 'off-body';
}

export interface RealtimeHeartRatePacket {
  unix: number;
  bpm: number;
}

export interface DeviceBatteryEventPacket {
  event: EventNumber.BatteryLevel;
  unix: number;
  chargeTenthsPercent: number;
  percent: number;
}

export interface DeviceChargingEventPacket {
  event:
    | EventNumber.External5vOn
    | EventNumber.External5vOff
    | EventNumber.ChargingOn
    | EventNumber.ChargingOff;
  unix: number;
  chargingStatus: 'charging' | 'not_charging';
}

export interface DeviceBodyEventPacket {
  event: EventNumber.WristOn | EventNumber.WristOff;
  unix: number;
  bodyStatus: 'on-body' | 'off-body';
}

export interface DeviceSimpleEventPacket {
  event:
    | EventNumber.DoubleTap
    | EventNumber.ExtendedBatteryInformation
    | EventNumber.HighFreqSyncPrompt;
  unix: number;
}

export interface DeviceAlarmEventPacket {
  event:
    | EventNumber.StrapDrivenAlarmSet
    | EventNumber.StrapDrivenAlarmExecuted
    | EventNumber.AppDrivenAlarmExecuted
    | EventNumber.StrapDrivenAlarmDisabled;
  unix: number;
}

export type DeviceEventPacket =
  | DeviceBatteryEventPacket
  | DeviceChargingEventPacket
  | DeviceBodyEventPacket
  | DeviceSimpleEventPacket
  | DeviceAlarmEventPacket;

export interface RawCommandResponsePacket {
  command: number;
  payload: Uint8Array;
}

export interface FramedPacket {
  packetType: PacketType;
  seq: number;
  cmd: number;
  data: Uint8Array;
}

export type ParsedNotification =
  | { type: 'history'; reading: HistoryReadingPacket }
  | { type: 'metadata'; metadata: MetadataPacket }
  | { type: 'realtimeHr'; heartRate: RealtimeHeartRatePacket }
  | { type: 'version'; version: VersionInfoPacket }
  | { type: 'deviceName'; device: DeviceNamePacket }
  | { type: 'battery'; battery: BatteryLevelPacket }
  | { type: 'bodyStatus'; body: BodyStatusPacket }
  | { type: 'event'; event: DeviceEventPacket }
  | { type: 'command'; response: RawCommandResponsePacket }
  | { type: 'unknown' };

function readU16LE(bytes: Uint8Array, offset: number) {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function readU32LE(bytes: Uint8Array, offset: number) {
  return (
    bytes[offset] |
    (bytes[offset + 1] << 8) |
    (bytes[offset + 2] << 16) |
    (bytes[offset + 3] << 24)
  ) >>> 0;
}

function readI16BE(bytes: Uint8Array, offset: number) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return view.getInt16(offset, false);
}

function readF32LE(bytes: Uint8Array, offset: number) {
  const view = new DataView(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  return view.getFloat32(offset, true);
}

function crc8(bytes: Uint8Array) {
  let crc = 0;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 0x80) !== 0 ? ((crc << 1) ^ 0x07) & 0xff : (crc << 1) & 0xff;
    }
  }
  return crc;
}

function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 1) !== 0 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (~crc) >>> 0;
}

function concatBytes(left: Uint8Array, right: Uint8Array) {
  const bytes = new Uint8Array(left.length + right.length);
  bytes.set(left, 0);
  bytes.set(right, left.length);
  return bytes;
}

export function bytesToBase64(bytes: Uint8Array) {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return encodeBase64(binary);
}

export function base64ToBytes(value: string) {
  const binary = decodeBase64(value);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

export function framePacket(packetType: PacketType, seq: number, cmd: number, payload: Uint8Array = new Uint8Array()) {
  const inner = new Uint8Array(3 + payload.length);
  inner[0] = packetType;
  inner[1] = seq;
  inner[2] = cmd;
  inner.set(payload, 3);

  const length = inner.length + 4;
  const frame = new Uint8Array(1 + 2 + 1 + inner.length + 4);
  frame[0] = 0xaa;
  frame[1] = length & 0xff;
  frame[2] = (length >> 8) & 0xff;
  frame[3] = crc8(frame.slice(1, 3));
  frame.set(inner, 4);
  const checksum = crc32(inner);
  frame[frame.length - 4] = checksum & 0xff;
  frame[frame.length - 3] = (checksum >> 8) & 0xff;
  frame[frame.length - 2] = (checksum >> 16) & 0xff;
  frame[frame.length - 1] = (checksum >> 24) & 0xff;
  return frame;
}

export function helloHarvardPacket() {
  return framePacket(PacketType.Command, 0, CommandNumber.GetHelloHarvard, Uint8Array.from([0x00]));
}

export function setClockPacket(unixSeconds: number) {
  const payload = new Uint8Array(9);
  payload[0] = unixSeconds & 0xff;
  payload[1] = (unixSeconds >> 8) & 0xff;
  payload[2] = (unixSeconds >> 16) & 0xff;
  payload[3] = (unixSeconds >> 24) & 0xff;
  return framePacket(PacketType.Command, 0, CommandNumber.SetClock, payload);
}

export function restartPacket() {
  return framePacket(PacketType.Command, 0, CommandNumber.RebootStrap, Uint8Array.from([0x00]));
}

export function getNamePacket() {
  return framePacket(PacketType.Command, 0, CommandNumber.GetAdvertisingNameHarvard, Uint8Array.from([0x00]));
}

export function versionInfoPacket() {
  return framePacket(PacketType.Command, 0, CommandNumber.ReportVersionInfo, Uint8Array.from([0x00]));
}

export function getBatteryLevelPacket() {
  return framePacket(PacketType.Command, 0, CommandNumber.GetBatteryLevel, Uint8Array.from([0x00]));
}

export function getBodyLocationAndStatusPacket() {
  return framePacket(PacketType.Command, 0, CommandNumber.GetBodyLocationAndStatus, Uint8Array.from([0x00]));
}

export function toggleRealtimeHrPacket(enable: boolean) {
  return framePacket(PacketType.Command, 0, CommandNumber.ToggleRealtimeHr, Uint8Array.from([enable ? 0x01 : 0x00]));
}

export function toggleR7DataCollectionPacket(enable: boolean) {
  return framePacket(
    PacketType.Command,
    0,
    CommandNumber.ToggleR7DataCollection,
    Uint8Array.from([enable ? 0x01 : 0x00]),
  );
}

export function setAlarmPacket(unixSeconds: number) {
  const payload = new Uint8Array(9);
  payload[0] = 0x01;
  payload[1] = unixSeconds & 0xff;
  payload[2] = (unixSeconds >> 8) & 0xff;
  payload[3] = (unixSeconds >> 16) & 0xff;
  payload[4] = (unixSeconds >> 24) & 0xff;
  return framePacket(PacketType.Command, 0, CommandNumber.SetAlarmTime, payload);
}

export function disableAlarmPacket() {
  return framePacket(PacketType.Command, 0, CommandNumber.DisableAlarm, Uint8Array.from([0x00]));
}

export function enterHighFrequencySyncPacket() {
  return framePacket(PacketType.Command, 0, CommandNumber.EnterHighFreqSync);
}

export function exitHighFrequencySyncPacket() {
  return framePacket(PacketType.Command, 0, CommandNumber.ExitHighFreqSync);
}

export function historyStartPacket() {
  return framePacket(PacketType.Command, 0, CommandNumber.SendHistoricalData, Uint8Array.from([0x00]));
}

export function historyEndPacket(cursor: number) {
  const payload = new Uint8Array(9);
  payload[0] = 0x01;
  payload[1] = cursor & 0xff;
  payload[2] = (cursor >> 8) & 0xff;
  payload[3] = (cursor >> 16) & 0xff;
  payload[4] = (cursor >> 24) & 0xff;
  return framePacket(PacketType.Command, 0, CommandNumber.HistoricalDataResult, payload);
}

export class PacketAssembler {
  private buffer = new Uint8Array();

  push(chunk: Uint8Array) {
    this.buffer = concatBytes(this.buffer, chunk);
    const packets: FramedPacket[] = [];

    while (this.buffer.length >= 8) {
      if (this.buffer[0] !== 0xaa) {
        this.buffer = this.buffer.slice(1);
        continue;
      }

      const expectedHeaderCrc = this.buffer[3];
      const actualHeaderCrc = crc8(this.buffer.slice(1, 3));
      if (expectedHeaderCrc !== actualHeaderCrc) {
        this.buffer = this.buffer.slice(1);
        continue;
      }

      const length = readU16LE(this.buffer, 1);
      const frameLength = 1 + 2 + 1 + length;
      if (this.buffer.length < frameLength) {
        break;
      }

      const frame = this.buffer.slice(0, frameLength);
      this.buffer = this.buffer.slice(frameLength);
      const inner = frame.slice(4, frame.length - 4);
      const expectedCrc = readU32LE(frame, frame.length - 4);
      const actualCrc = crc32(inner);
      if (expectedCrc !== actualCrc) {
        continue;
      }

      const packetType = inner[0] as PacketType;
      packets.push({
        packetType,
        seq: inner[1],
        cmd: inner[2],
        data: inner.slice(3),
      });
    }

    return packets;
  }
}

function parseHistoryPacket(packet: FramedPacket): HistoryReadingPacket {
  const bytes = packet.data;

  if (bytes.length >= 1288) {
    const unix = readU32LE(bytes, 4) * 1000;
    const bpm = bytes[14];
    const rrCount = bytes[15];
    const rr: number[] = [];

    for (let index = 0; index < rrCount; index += 1) {
      const value = readU16LE(bytes, 16 + index * 2);
      if (value !== 0) {
        rr.push(value);
      }
    }

    const N_SAMPLES_IMU = 100;

    return {
      unix,
      bpm,
      rr,
      sensorData: null,
      imuSampleCount: N_SAMPLES_IMU,
    };
  }

  if ((packet.seq === 12 || packet.seq === 24) && bytes.length >= 77) {
    const unix = readU32LE(bytes, 4) * 1000;
    const bpm = bytes[14];
    const rrCount = bytes[15];
    const rr: number[] = [];
    for (let index = 0; index < Math.min(rrCount, 4); index += 1) {
      const value = readU16LE(bytes, 16 + index * 2);
      if (value !== 0) {
        rr.push(value);
      }
    }

    return {
      unix,
      bpm,
      rr,
      sensorData: {
        ppg_green: readU16LE(bytes, 26),
        ppg_red_ir: readU16LE(bytes, 28),
        spo2_red: readU16LE(bytes, 61),
        spo2_ir: readU16LE(bytes, 63),
        skin_temp_raw: readU16LE(bytes, 65),
        ambient_light: readU16LE(bytes, 67),
        led_drive_1: readU16LE(bytes, 69),
        led_drive_2: readU16LE(bytes, 71),
        resp_rate_raw: readU16LE(bytes, 73),
        signal_quality: readU16LE(bytes, 75),
        skin_contact: bytes[48],
        accel_gravity: [
          readF32LE(bytes, 33),
          readF32LE(bytes, 37),
          readF32LE(bytes, 41),
        ],
      },
      imuSampleCount: 0,
    };
  }

  const unix = readU32LE(bytes, 4) * 1000;
  const bpm = bytes[14];
  const rrCount = bytes[15];
  const rr: number[] = [];
  for (let index = 0; index < 4; index += 1) {
    const value = readU16LE(bytes, 16 + index * 2);
    if (value !== 0) {
      rr.push(value);
    }
  }

  return {
    unix,
    bpm,
    rr: rr.slice(0, rrCount),
    sensorData: null,
    imuSampleCount: 0,
  };
}

function parseMetadataPacket(packet: FramedPacket): MetadataPacket {
  const unix = readU32LE(packet.data, 0);
  const data = packet.data.length >= 10 ? readU32LE(packet.data, 10) : readU32LE(packet.data, 4);
  return {
    kind: packet.cmd as MetadataType,
    unix,
    data,
  };
}

function parseVersionResponse(packet: FramedPacket): VersionInfoPacket {
  const bytes = packet.data;
  const offset = 3;
  const harvard = [0, 4, 8, 12].map((value) => readU32LE(bytes, offset + value)).join('.');
  const boylston = [16, 20, 24, 28].map((value) => readU32LE(bytes, offset + value)).join('.');
  return { harvard, boylston };
}

function normalizeDeviceNameBytes(bytes: Uint8Array) {
  const visibleBytes: number[] = [];
  for (const byte of bytes) {
    if (byte === 0) {
      break;
    }
    visibleBytes.push(byte);
  }

  if (visibleBytes.length === 0) {
    return null;
  }

  const name = String.fromCharCode(...visibleBytes).trim();
  if (!name || [...name].some((character) => character <= '\u001f' || character === '\u007f')) {
    return null;
  }

  return name;
}

export function decodeDeviceNamePayload(payload: Uint8Array) {
  const direct = normalizeDeviceNameBytes(payload);
  if (direct) {
    return direct;
  }

  if (payload[0] === 0x00) {
    const withoutPrefix = normalizeDeviceNameBytes(payload.slice(1));
    if (withoutPrefix) {
      return withoutPrefix;
    }
  }

  const declaredLength = payload[0] ?? 0;
  if (declaredLength > 0 && payload.length > declaredLength) {
    const fromLength = normalizeDeviceNameBytes(payload.slice(1, 1 + declaredLength));
    if (fromLength) {
      return fromLength;
    }
  }

  const firstVisibleIndex = payload.findIndex((byte) => byte !== 0 && byte >= 0x20 && byte !== 0x7f);
  if (firstVisibleIndex >= 0) {
    return normalizeDeviceNameBytes(payload.slice(firstVisibleIndex));
  }

  return null;
}

export function decodeBatteryLevelPayload(payload: Uint8Array): BatteryLevelPacket | null {
  if (payload.length < 4) {
    return null;
  }

  const chargeTenthsPercent = readU16LE(payload, 2);
  return {
    command: CommandNumber.GetBatteryLevel,
    chargeTenthsPercent,
    percent: Math.max(0, Math.min(100, Math.round(chargeTenthsPercent / 10))),
  };
}

export function decodeBodyStatusPayload(payload: Uint8Array): BodyStatusPacket | null {
  if (payload.length < 3) {
    return null;
  }

  const rawStatus = payload[2];
  if (rawStatus !== 0 && rawStatus !== 1) {
    return null;
  }

  return {
    command: CommandNumber.GetBodyLocationAndStatus,
    rawStatus,
    bodyStatus: rawStatus === 1 ? 'on-body' : 'off-body',
  };
}

export function decodeBatteryEventPayload(payload: Uint8Array) {
  if (payload.length < 24) {
    return null;
  }

  const bodyLength = readU16LE(payload, 2);
  const body = payload.slice(4);
  if (body.length < 20 || body.length !== bodyLength) {
    return null;
  }

  const chargeTenthsPercent = readU16LE(body, 1);
  return {
    chargeTenthsPercent,
    percent: Math.max(0, Math.min(100, Math.round(chargeTenthsPercent / 10))),
  };
}

function parseEventPacket(packet: FramedPacket): ParsedNotification {
  if (packet.data.length < 5) {
    return { type: 'unknown' };
  }

  const unix = readU32LE(packet.data, 1) * 1000;
  const payload = packet.data.slice(5);

  if (packet.cmd === EventNumber.BatteryLevel) {
    const battery = decodeBatteryEventPayload(payload);
    if (battery) {
      return {
        type: 'event',
        event: {
          event: EventNumber.BatteryLevel,
          unix,
          chargeTenthsPercent: battery.chargeTenthsPercent,
          percent: battery.percent,
        },
      };
    }
  }

  if (
    packet.cmd === EventNumber.External5vOn ||
    packet.cmd === EventNumber.External5vOff ||
    packet.cmd === EventNumber.ChargingOn ||
    packet.cmd === EventNumber.ChargingOff
  ) {
    return {
      type: 'event',
      event: {
        event: packet.cmd,
        unix,
        chargingStatus:
          packet.cmd === EventNumber.External5vOn || packet.cmd === EventNumber.ChargingOn
            ? 'charging'
            : 'not_charging',
      },
    };
  }

  if (packet.cmd === EventNumber.WristOn || packet.cmd === EventNumber.WristOff) {
    return {
      type: 'event',
      event: {
        event: packet.cmd,
        unix,
        bodyStatus: packet.cmd === EventNumber.WristOn ? 'on-body' : 'off-body',
      },
    };
  }

  if (
    packet.cmd === EventNumber.DoubleTap ||
    packet.cmd === EventNumber.ExtendedBatteryInformation ||
    packet.cmd === EventNumber.HighFreqSyncPrompt
  ) {
    return {
      type: 'event',
      event: {
        event: packet.cmd,
        unix,
      },
    };
  }

  if (
    packet.cmd === EventNumber.StrapDrivenAlarmSet ||
    packet.cmd === EventNumber.StrapDrivenAlarmExecuted ||
    packet.cmd === EventNumber.AppDrivenAlarmExecuted ||
    packet.cmd === EventNumber.StrapDrivenAlarmDisabled
  ) {
    return {
      type: 'event',
      event: {
        event: packet.cmd,
        unix,
      },
    };
  }

  return { type: 'unknown' };
}

function parseRealtimeHeartRatePacket(packet: FramedPacket): ParsedNotification {
  if (packet.data.length < 6) {
    return { type: 'unknown' };
  }

  const unix = readU32LE(Uint8Array.from([packet.cmd, packet.data[0], packet.data[1], packet.data[2]]), 0) * 1000;
  return {
    type: 'realtimeHr',
    heartRate: {
      unix,
      bpm: packet.data[5],
    },
  };
}

export function parseNotification(packet: FramedPacket): ParsedNotification {
  if (packet.packetType === PacketType.HistoricalData) {
    return {
      type: 'history',
      reading: parseHistoryPacket(packet),
    };
  }

  if (packet.packetType === PacketType.Metadata) {
    return {
      type: 'metadata',
      metadata: parseMetadataPacket(packet),
    };
  }

  if (packet.packetType === PacketType.Event) {
    return parseEventPacket(packet);
  }

  if (packet.packetType === PacketType.RealtimeData) {
    return parseRealtimeHeartRatePacket(packet);
  }

  if (packet.packetType === PacketType.CommandResponse) {
    if (packet.cmd === CommandNumber.GetBatteryLevel) {
      const battery = decodeBatteryLevelPayload(packet.data);
      if (battery) {
        return {
          type: 'battery',
          battery,
        };
      }
    }

    if (packet.cmd === CommandNumber.GetBodyLocationAndStatus) {
      const body = decodeBodyStatusPayload(packet.data);
      if (body) {
        return {
          type: 'bodyStatus',
          body,
        };
      }
    }

    if (packet.cmd === CommandNumber.ReportVersionInfo) {
      return {
        type: 'version',
        version: parseVersionResponse(packet),
      };
    }

    if (
      packet.cmd === CommandNumber.GetAdvertisingNameHarvard ||
      packet.cmd === CommandNumber.GetAdvertisingName
    ) {
      const name = decodeDeviceNamePayload(packet.data);
      if (name) {
        return {
          type: 'deviceName',
          device: {
            command: packet.cmd,
            name,
          },
        };
      }
    }

    return {
      type: 'command',
      response: {
        command: packet.cmd,
        payload: packet.data,
      },
    };
  }

  return { type: 'unknown' };
}
