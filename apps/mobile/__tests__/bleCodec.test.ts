import { CommandNumber, MetadataType, PacketType } from '@/services/ble/constants';
import { PacketAssembler, framePacket, parseNotification } from '@/services/ble/codec';

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
  });
});
