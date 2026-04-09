import { CommandNumber, EventNumber, MetadataType, PacketType } from '@/services/ble/constants';
import { PacketAssembler, decodeBatteryEventPayload, decodeBatteryLevelPayload, decodeBodyStatusPayload, decodeDeviceNamePayload, disableAlarmPacket, framePacket, getBatteryLevelPacket, getBodyLocationAndStatusPacket, parseNotification, setAlarmPacket, toggleR7DataCollectionPacket, toggleRealtimeHrPacket } from '@/services/ble/codec';

function writeU16LE(bytes: Uint8Array, offset: number, value: number) {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >> 8) & 0xff;
}

function writeU32LE(bytes: Uint8Array, offset: number, value: number) {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >> 8) & 0xff;
  bytes[offset + 2] = (value >> 16) & 0xff;
  bytes[offset + 3] = (value >> 24) & 0xff;
}

function writeF32LE(bytes: Uint8Array, offset: number, value: number) {
  const view = new DataView(bytes.buffer);
  view.setFloat32(offset, value, true);
}

function asciiBytes(value: string) {
  return Uint8Array.from(value, (character) => character.charCodeAt(0));
}

describe('BLE codec', () => {
  it('assembles framed packets from chunked bytes', () => {
    const payload = Uint8Array.from([0xde, 0xad, 0xbe, 0xef]);
    const frame = framePacket(PacketType.Command, 7, CommandNumber.SetClock, payload);
    const assembler = new PacketAssembler();

    const packets = [
      ...assembler.push(frame.slice(0, 5)),
      ...assembler.push(frame.slice(5)),
    ];

    expect(packets).toHaveLength(1);
    expect(packets[0]).toEqual({
      packetType: PacketType.Command,
      seq: 7,
      cmd: CommandNumber.SetClock,
      data: payload,
    });
  });

  it('parses metadata packets with history cursors', () => {
    const metadata = new Uint8Array(14);
    writeU32LE(metadata, 0, 1_710_000_000);
    writeU32LE(metadata, 10, 123_456);

    const parsed = parseNotification({
      packetType: PacketType.Metadata,
      seq: 0,
      cmd: MetadataType.HistoryEnd,
      data: metadata,
    });

    expect(parsed.type).toBe('metadata');
    if (parsed.type !== 'metadata') {
      return;
    }

    expect(parsed.metadata.kind).toBe(MetadataType.HistoryEnd);
    expect(parsed.metadata.unix).toBe(1_710_000_000);
    expect(parsed.metadata.data).toBe(123_456);
  });

  it('parses V24 history packets with sensor data', () => {
    const history = new Uint8Array(77);
    writeU32LE(history, 4, 1_710_000_123);
    history[14] = 62;
    history[15] = 2;
    writeU16LE(history, 16, 820);
    writeU16LE(history, 18, 810);
    writeU16LE(history, 26, 15_500);
    writeF32LE(history, 33, 0.11);
    writeF32LE(history, 37, -0.02);
    writeF32LE(history, 41, 0.98);
    history[48] = 1;
    writeU16LE(history, 61, 5_400);
    writeU16LE(history, 63, 7_800);
    writeU16LE(history, 65, 312);
    writeU16LE(history, 67, 42);
    writeU16LE(history, 69, 12);
    writeU16LE(history, 71, 18);
    writeU16LE(history, 73, 210);
    writeU16LE(history, 75, 99);

    const parsed = parseNotification({
      packetType: PacketType.HistoricalData,
      seq: 24,
      cmd: 0,
      data: history,
    });

    expect(parsed.type).toBe('history');
    if (parsed.type !== 'history') {
      return;
    }

    expect(parsed.reading.unix).toBe(1_710_000_123_000);
    expect(parsed.reading.bpm).toBe(62);
    expect(parsed.reading.rr).toEqual([820, 810]);
    expect(parsed.reading.sensorData).toEqual({
      ppg_green: 15_500,
      ppg_red_ir: 0,
      spo2_red: 5_400,
      spo2_ir: 7_800,
      skin_temp_raw: 312,
      ambient_light: 42,
      led_drive_1: 12,
      led_drive_2: 18,
      resp_rate_raw: 210,
      signal_quality: 99,
      skin_contact: 1,
      accel_gravity: [0.10999999940395355, -0.019999999552965164, 0.9800000190734863],
    });
    expect(parsed.reading.imuSampleCount).toBe(0);
  });

  it('parses IMU history packets into lightweight IMU metadata', () => {
    const history = new Uint8Array(1288);
    writeU32LE(history, 4, 1_710_000_456);
    history[14] = 88;
    history[15] = 2;
    writeU16LE(history, 16, 720);
    writeU16LE(history, 18, 710);

    const parsed = parseNotification({
      packetType: PacketType.HistoricalData,
      seq: 0,
      cmd: 0,
      data: history,
    });

    expect(parsed.type).toBe('history');
    if (parsed.type !== 'history') {
      return;
    }

    expect(parsed.reading.sensorData).toBeNull();
    expect(parsed.reading.rr).toEqual([720, 710]);
    expect(parsed.reading.imuSampleCount).toBe(100);
  });

  it('encodes the strap-side R7 data collection disable command', () => {
    const frame = toggleR7DataCollectionPacket(false);
    const assembler = new PacketAssembler();
    const [packet] = assembler.push(frame);

    expect(packet).toEqual({
      packetType: PacketType.Command,
      seq: 0,
      cmd: CommandNumber.ToggleR7DataCollection,
      data: Uint8Array.from([0x00]),
    });
  });

  it('decodes Harvard device-name payloads', () => {
    expect(
      decodeDeviceNamePayload(Uint8Array.from([0x00, ...asciiBytes('Strap Neo'), 0x00])),
    ).toBe('Strap Neo');

    expect(
      decodeDeviceNamePayload(Uint8Array.from([9, ...asciiBytes('Strap Neo'), 0x00])),
    ).toBe('Strap Neo');
  });

  it('parses device-name command responses', () => {
    const parsed = parseNotification({
      packetType: PacketType.CommandResponse,
      seq: 0,
      cmd: CommandNumber.GetAdvertisingNameHarvard,
      data: Uint8Array.from([0x00, ...asciiBytes('New Strap'), 0x00]),
    });

    expect(parsed).toEqual({
      type: 'deviceName',
      device: {
        command: CommandNumber.GetAdvertisingNameHarvard,
        name: 'New Strap',
      },
    });
  });

  it('decodes battery responses into a whole-number percent', () => {
    const payload = Uint8Array.from([0x00, 0x00, 0x4d, 0x03]);

    expect(decodeBatteryLevelPayload(payload)).toEqual({
      command: CommandNumber.GetBatteryLevel,
      chargeTenthsPercent: 845,
      percent: 85,
    });

    const parsed = parseNotification({
      packetType: PacketType.CommandResponse,
      seq: 0,
      cmd: CommandNumber.GetBatteryLevel,
      data: payload,
    });

    expect(parsed).toEqual({
      type: 'battery',
      battery: {
        command: CommandNumber.GetBatteryLevel,
        chargeTenthsPercent: 845,
        percent: 85,
      },
    });
  });

  it('falls back when battery payloads are too short', () => {
    expect(decodeBatteryLevelPayload(Uint8Array.from([0x00, 0x00, 0x4d]))).toBeNull();

    const parsed = parseNotification({
      packetType: PacketType.CommandResponse,
      seq: 0,
      cmd: CommandNumber.GetBatteryLevel,
      data: Uint8Array.from([0x00, 0x00, 0x4d]),
    });

    expect(parsed).toEqual({
      type: 'command',
      response: {
        command: CommandNumber.GetBatteryLevel,
        payload: Uint8Array.from([0x00, 0x00, 0x4d]),
      },
    });
  });

  it('decodes body-status command responses', () => {
    const payload = Uint8Array.from([0x00, 0x00, 0x01]);

    expect(decodeBodyStatusPayload(payload)).toEqual({
      command: CommandNumber.GetBodyLocationAndStatus,
      rawStatus: 1,
      bodyStatus: 'on-body',
    });

    const parsed = parseNotification({
      packetType: PacketType.CommandResponse,
      seq: 0,
      cmd: CommandNumber.GetBodyLocationAndStatus,
      data: payload,
    });

    expect(parsed).toEqual({
      type: 'bodyStatus',
      body: {
        command: CommandNumber.GetBodyLocationAndStatus,
        rawStatus: 1,
        bodyStatus: 'on-body',
      },
    });
  });

  it('parses useful device events', () => {
    const batteryPayload = new Uint8Array(24);
    writeU16LE(batteryPayload, 2, 20);
    batteryPayload[4] = 0x01;
    writeU16LE(batteryPayload, 5, 845);
    const eventData = new Uint8Array(1 + 4 + batteryPayload.length);
    eventData[0] = 0x00;
    writeU32LE(eventData, 1, 1_710_000_000);
    eventData.set(batteryPayload, 5);

    const simpleEventData = new Uint8Array(5);
    simpleEventData[0] = 0x00;
    writeU32LE(simpleEventData, 1, 1_710_000_000);

    expect(decodeBatteryEventPayload(batteryPayload)).toEqual({
      chargeTenthsPercent: 845,
      percent: 85,
    });

    expect(parseNotification({
      packetType: PacketType.Event,
      seq: 0,
      cmd: EventNumber.BatteryLevel,
      data: eventData,
    })).toEqual({
      type: 'event',
      event: {
        event: EventNumber.BatteryLevel,
        unix: 1_710_000_000_000,
        chargeTenthsPercent: 845,
        percent: 85,
      },
    });

    expect(parseNotification({
      packetType: PacketType.Event,
      seq: 0,
      cmd: EventNumber.ChargingOn,
      data: simpleEventData,
    })).toEqual({
      type: 'event',
      event: {
        event: EventNumber.ChargingOn,
        unix: 1_710_000_000_000,
        chargingStatus: 'charging',
      },
    });

    expect(parseNotification({
      packetType: PacketType.Event,
      seq: 0,
      cmd: EventNumber.WristOff,
      data: simpleEventData,
    })).toEqual({
      type: 'event',
      event: {
        event: EventNumber.WristOff,
        unix: 1_710_000_000_000,
        bodyStatus: 'off-body',
      },
    });

    expect(parseNotification({
      packetType: PacketType.Event,
      seq: 0,
      cmd: EventNumber.StrapDrivenAlarmExecuted,
      data: simpleEventData,
    })).toEqual({
      type: 'event',
      event: {
        event: EventNumber.StrapDrivenAlarmExecuted,
        unix: 1_710_000_000_000,
      },
    });
  });

  it('parses realtime heart-rate packets', () => {
    const parsed = parseNotification({
      packetType: PacketType.RealtimeData,
      seq: 0,
      cmd: 0x78,
      data: Uint8Array.from([0x56, 0x34, 0x12, 0x34, 0x12, 72]),
    });

    expect(parsed).toEqual({
      type: 'realtimeHr',
      heartRate: {
        unix: 0x12345678 * 1000,
        bpm: 72,
      },
    });
  });

  it('falls back when realtime heart-rate payloads are too short', () => {
    const parsed = parseNotification({
      packetType: PacketType.RealtimeData,
      seq: 0,
      cmd: 0x78,
      data: Uint8Array.from([0x56, 0x34, 0x12, 0x34, 0x12]),
    });

    expect(parsed).toEqual({
      type: 'unknown',
    });
  });

  it('builds alarm and realtime heart-rate command packets', () => {
    const batteryFrame = getBatteryLevelPacket();
    const bodyFrame = getBodyLocationAndStatusPacket();
    const setFrame = setAlarmPacket(1_710_000_123);
    const disableFrame = disableAlarmPacket();
    const realtimeFrame = toggleRealtimeHrPacket(true);
    const assembler = new PacketAssembler();

    const [batteryPacket] = assembler.push(batteryFrame);
    const [bodyPacket] = assembler.push(bodyFrame);
    const [setPacket] = assembler.push(setFrame);
    const [disablePacket] = assembler.push(disableFrame);
    const [realtimePacket] = assembler.push(realtimeFrame);

    expect(batteryPacket.cmd).toBe(CommandNumber.GetBatteryLevel);
    expect(batteryPacket.data).toEqual(Uint8Array.from([0x00]));
    expect(bodyPacket.cmd).toBe(CommandNumber.GetBodyLocationAndStatus);
    expect(bodyPacket.data).toEqual(Uint8Array.from([0x00]));
    expect(setPacket.cmd).toBe(CommandNumber.SetAlarmTime);
    expect(setPacket.data.slice(0, 5)).toEqual(Uint8Array.from([0x01, 0xfb, 0x87, 0xec, 0x65]));
    expect(disablePacket.cmd).toBe(CommandNumber.DisableAlarm);
    expect(disablePacket.data).toEqual(Uint8Array.from([0x00]));
    expect(realtimePacket.cmd).toBe(CommandNumber.ToggleRealtimeHr);
    expect(realtimePacket.data).toEqual(Uint8Array.from([0x01]));
  });
});
