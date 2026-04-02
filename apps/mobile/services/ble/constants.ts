export const WEARABLE_SERVICE_UUID = '61080001-8d6d-82b8-614a-1c8cb0f8dcc6';
export const CMD_TO_STRAP_UUID = '61080002-8d6d-82b8-614a-1c8cb0f8dcc6';
export const CMD_FROM_STRAP_UUID = '61080003-8d6d-82b8-614a-1c8cb0f8dcc6';
export const EVENTS_FROM_STRAP_UUID = '61080004-8d6d-82b8-614a-1c8cb0f8dcc6';
export const DATA_FROM_STRAP_UUID = '61080005-8d6d-82b8-614a-1c8cb0f8dcc6';
export const MEMFAULT_UUID = '61080007-8d6d-82b8-614a-1c8cb0f8dcc6';

export enum PacketType {
  Command = 35,
  CommandResponse = 36,
  RealtimeData = 40,
  HistoricalData = 47,
  Event = 48,
  Metadata = 49,
  ConsoleLogs = 50,
}

export enum MetadataType {
  HistoryStart = 1,
  HistoryEnd = 2,
  HistoryComplete = 3,
}

export enum CommandNumber {
  SetClock = 10,
  SendHistoricalData = 22,
  HistoricalDataResult = 23,
  ReportVersionInfo = 7,
  GetHelloHarvard = 35,
  SetAlarmTime = 66,
  GetAlarmTime = 67,
  DisableAlarm = 69,
  GetAdvertisingNameHarvard = 76,
  GetAdvertisingName = 141,
  EnterHighFreqSync = 96,
  ExitHighFreqSync = 97,
}
