use chrono::Utc;

use crate::{
    WearablePacket,
    constants::{CommandNumber, PacketType},
    error::WearableError,
};

impl WearablePacket {
    pub fn enter_high_freq_sync() -> WearablePacket {
        WearablePacket::new(
            PacketType::Command,
            0,
            CommandNumber::EnterHighFreqSync.as_u8(),
            vec![],
        )
    }

    pub fn exit_high_freq_sync() -> WearablePacket {
        WearablePacket::new(
            PacketType::Command,
            0,
            CommandNumber::ExitHighFreqSync.as_u8(),
            vec![],
        )
    }

    pub fn history_start() -> WearablePacket {
        WearablePacket::new(
            PacketType::Command,
            0,
            CommandNumber::SendHistoricalData.as_u8(),
            vec![0x00],
        )
    }

    pub fn hello_harvard() -> WearablePacket {
        WearablePacket::new(
            PacketType::Command,
            0,
            CommandNumber::GetHelloHarvard.as_u8(),
            vec![0x00],
        )
    }

    pub fn get_name() -> WearablePacket {
        WearablePacket::new(
            PacketType::Command,
            0,
            CommandNumber::GetAdvertisingNameHarvard.as_u8(),
            vec![0x00],
        )
    }

    pub fn get_name_modern() -> WearablePacket {
        WearablePacket::new(
            PacketType::Command,
            0,
            CommandNumber::GetAdvertisingName.as_u8(),
            vec![0x00],
        )
    }

    pub fn set_name(name: &str) -> Result<WearablePacket, WearableError> {
        const HARVARD_NAME_BUFFER_LEN: usize = 11;

        let name_bytes = Self::validated_name_bytes(name)?;
        if name_bytes.len() + 1 > HARVARD_NAME_BUFFER_LEN {
            return Err(WearableError::InvalidData);
        }

        let mut payload = vec![0x00, 0x01];
        payload.extend_from_slice(&name_bytes);
        payload.push(0x00);
        payload.resize(2 + HARVARD_NAME_BUFFER_LEN, 0x00);

        Ok(WearablePacket::new(
            PacketType::Command,
            0,
            CommandNumber::SetAdvertisingNameHarvard.as_u8(),
            payload,
        ))
    }

    pub fn set_name_modern(name: &str) -> Result<WearablePacket, WearableError> {
        let name_bytes = Self::validated_name_bytes(name)?;
        let mut payload = name_bytes;
        payload.push(0x00);

        Ok(WearablePacket::new(
            PacketType::Command,
            0,
            CommandNumber::SetAdvertisingName.as_u8(),
            payload,
        ))
    }

    fn validated_name_bytes(name: &str) -> Result<Vec<u8>, WearableError> {
        if name.is_empty()
            || name
                .bytes()
                .any(|byte| byte == 0 || byte.is_ascii_control())
        {
            return Err(WearableError::InvalidData);
        }

        Ok(name.as_bytes().to_vec())
    }

    pub fn set_time() -> Result<WearablePacket, WearableError> {
        let mut data = vec![];
        let current_time =
            u32::try_from(Utc::now().timestamp()).map_err(|_| WearableError::Overflow)?;
        data.extend_from_slice(&current_time.to_le_bytes());
        data.append(&mut vec![0, 0, 0, 0, 0]); // padding
        Ok(WearablePacket::new(
            PacketType::Command,
            0,
            CommandNumber::SetClock.as_u8(),
            data,
        ))
    }

    pub fn history_end(data: u32) -> WearablePacket {
        let mut packet_data = vec![0x01];
        packet_data.extend_from_slice(&data.to_le_bytes());
        packet_data.append(&mut vec![0, 0, 0, 0]); // padding

        WearablePacket::new(
            PacketType::Command,
            0,
            CommandNumber::HistoricalDataResult.as_u8(),
            packet_data,
        )
    }

    pub fn alarm_time(unix: u32) -> WearablePacket {
        let mut data = vec![0x01];
        data.extend_from_slice(&unix.to_le_bytes());
        data.append(&mut vec![0, 0, 0, 0]); // padding
        WearablePacket::new(
            PacketType::Command,
            0,
            CommandNumber::SetAlarmTime.as_u8(),
            data,
        )
    }

    pub fn get_alarm_time() -> WearablePacket {
        WearablePacket::new(
            PacketType::Command,
            0,
            CommandNumber::GetAlarmTime.as_u8(),
            vec![0x00],
        )
    }

    pub fn toggle_imu_mode(value: bool) -> WearablePacket {
        WearablePacket::new(
            PacketType::Command,
            0,
            CommandNumber::ToggleImuMode.as_u8(),
            vec![u8::from(value)],
        )
    }

    pub fn toggle_imu_mode_historical(value: bool) -> WearablePacket {
        WearablePacket::new(
            PacketType::Command,
            0,
            CommandNumber::ToggleImuModeHistorical.as_u8(),
            vec![u8::from(value)],
        )
    }

    pub fn toggle_generic_hr_profile() -> WearablePacket {
        WearablePacket::new(
            PacketType::Command,
            0,
            CommandNumber::ToggleGenericHrProfile.as_u8(),
            vec![0x01],
        )
    }

    pub fn toggle_r7_data_collection() -> WearablePacket {
        WearablePacket::new(
            PacketType::Command,
            0,
            CommandNumber::ToggleR7DataCollection.as_u8(),
            vec![0x01],
        )
    }

    pub fn restart() -> WearablePacket {
        WearablePacket::new(
            PacketType::Command,
            0,
            CommandNumber::RebootStrap.as_u8(),
            vec![0x00],
        )
    }

    pub fn erase() -> WearablePacket {
        WearablePacket::new(
            PacketType::Command,
            0,
            CommandNumber::ForceTrim.as_u8(),
            vec![0xfe, 0xfe, 0xfe, 0xfe, 0xfe, 0xfe, 0xfe, 0xfe, 0x00],
        )
    }

    pub fn version() -> WearablePacket {
        WearablePacket::new(
            PacketType::Command,
            0,
            CommandNumber::ReportVersionInfo.as_u8(),
            vec![0x00],
        )
    }

    pub fn get_battery_level() -> WearablePacket {
        WearablePacket::new(
            PacketType::Command,
            0,
            CommandNumber::GetBatteryLevel.as_u8(),
            vec![0x00],
        )
    }

    pub fn get_body_location_and_status() -> WearablePacket {
        WearablePacket::new(
            PacketType::Command,
            0,
            CommandNumber::GetBodyLocationAndStatus.as_u8(),
            vec![0x00],
        )
    }

    pub fn get_extended_battery_info() -> WearablePacket {
        WearablePacket::new(
            PacketType::Command,
            0,
            CommandNumber::GetExtendedBatteryInfo.as_u8(),
            vec![0x00],
        )
    }

    pub fn toggle_realtime_hr(enable: bool) -> WearablePacket {
        WearablePacket::new(
            PacketType::Command,
            0,
            CommandNumber::ToggleRealtimeHr.as_u8(),
            vec![u8::from(enable)],
        )
    }

    pub fn enable_optical_data(enable: bool) -> WearablePacket {
        WearablePacket::new(
            PacketType::Command,
            0,
            CommandNumber::EnableOpticalData.as_u8(),
            vec![0x01, u8::from(enable)],
        )
    }

    pub fn toggle_optical_mode(enable: bool) -> WearablePacket {
        WearablePacket::new(
            PacketType::Command,
            0,
            CommandNumber::ToggleOpticalMode.as_u8(),
            vec![0x01, u8::from(enable)],
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn assert_command_packet(packet: &WearablePacket, expected_cmd: CommandNumber) {
        assert_eq!(packet.packet_type, PacketType::Command);
        assert_eq!(packet.cmd, expected_cmd.as_u8());
    }

    fn assert_roundtrip(packet: &WearablePacket) {
        let framed = packet.framed_packet().unwrap();
        let parsed = WearablePacket::from_data(framed).unwrap();
        assert_eq!(parsed.packet_type, packet.packet_type);
        assert_eq!(parsed.cmd, packet.cmd);
        assert_eq!(parsed.data, packet.data);
    }

    #[test]
    fn enter_high_freq_sync_packet() {
        let p = WearablePacket::enter_high_freq_sync();
        assert_command_packet(&p, CommandNumber::EnterHighFreqSync);
        assert!(p.data.is_empty());
    }

    #[test]
    fn exit_high_freq_sync_packet() {
        let p = WearablePacket::exit_high_freq_sync();
        assert_command_packet(&p, CommandNumber::ExitHighFreqSync);
        assert!(p.data.is_empty());
    }

    #[test]
    fn history_start_packet() {
        let p = WearablePacket::history_start();
        assert_command_packet(&p, CommandNumber::SendHistoricalData);
        assert_eq!(p.data, vec![0x00]);
        assert_roundtrip(&p);
    }

    #[test]
    fn hello_harvard_packet() {
        let p = WearablePacket::hello_harvard();
        assert_command_packet(&p, CommandNumber::GetHelloHarvard);
        assert_roundtrip(&p);
    }

    #[test]
    fn version_packet() {
        let p = WearablePacket::version();
        assert_command_packet(&p, CommandNumber::ReportVersionInfo);
        assert_roundtrip(&p);
    }

    #[test]
    fn battery_packets() {
        let p = WearablePacket::get_battery_level();
        assert_command_packet(&p, CommandNumber::GetBatteryLevel);
        assert_roundtrip(&p);

        let p = WearablePacket::get_body_location_and_status();
        assert_command_packet(&p, CommandNumber::GetBodyLocationAndStatus);
        assert_roundtrip(&p);

        let p = WearablePacket::get_extended_battery_info();
        assert_command_packet(&p, CommandNumber::GetExtendedBatteryInfo);
        assert_roundtrip(&p);
    }

    #[test]
    fn toggle_imu_mode_on_off() {
        let on = WearablePacket::toggle_imu_mode(true);
        assert_eq!(on.data, vec![1]);
        assert_roundtrip(&on);

        let off = WearablePacket::toggle_imu_mode(false);
        assert_eq!(off.data, vec![0]);
        assert_roundtrip(&off);
    }

    #[test]
    fn toggle_realtime_hr_on_off() {
        let on = WearablePacket::toggle_realtime_hr(true);
        assert_command_packet(&on, CommandNumber::ToggleRealtimeHr);
        assert_eq!(on.data, vec![1]);
        assert_roundtrip(&on);

        let off = WearablePacket::toggle_realtime_hr(false);
        assert_eq!(off.data, vec![0]);
        assert_roundtrip(&off);
    }

    #[test]
    fn history_end_encodes_data() {
        let p = WearablePacket::history_end(0x12345678);
        assert_command_packet(&p, CommandNumber::HistoricalDataResult);
        // First byte is 0x01, then LE u32
        assert_eq!(p.data[0], 0x01);
        assert_eq!(&p.data[1..5], &0x12345678_u32.to_le_bytes());
        assert_roundtrip(&p);
    }

    #[test]
    fn erase_packet() {
        let p = WearablePacket::erase();
        assert_command_packet(&p, CommandNumber::ForceTrim);
        assert_eq!(
            p.data,
            vec![0xfe, 0xfe, 0xfe, 0xfe, 0xfe, 0xfe, 0xfe, 0xfe, 0x00]
        );
        assert_roundtrip(&p);
    }

    #[test]
    fn restart_packet() {
        let p = WearablePacket::restart();
        assert_command_packet(&p, CommandNumber::RebootStrap);
        assert_roundtrip(&p);
    }

    #[test]
    fn set_time_packet() {
        let p = WearablePacket::set_time().unwrap();
        assert_command_packet(&p, CommandNumber::SetClock);
        assert_eq!(p.data.len(), 9); // 4 bytes time + 5 bytes padding
        assert_roundtrip(&p);
    }

    #[test]
    fn get_name_packet() {
        let p = WearablePacket::get_name();
        assert_command_packet(&p, CommandNumber::GetAdvertisingNameHarvard);
        assert_roundtrip(&p);
    }

    #[test]
    fn get_name_modern_packet() {
        let p = WearablePacket::get_name_modern();
        assert_command_packet(&p, CommandNumber::GetAdvertisingName);
        assert_roundtrip(&p);
    }

    #[test]
    fn set_name_packet() {
        let p = WearablePacket::set_name("BTWEARABLE").unwrap();
        assert_command_packet(&p, CommandNumber::SetAdvertisingNameHarvard);
        assert_eq!(p.data, b"\x00\x01BTWEARABLE\x00");
        assert_roundtrip(&p);
    }

    #[test]
    fn set_name_rejects_invalid_input() {
        assert!(WearablePacket::set_name("").is_err());
        assert!(WearablePacket::set_name("bad\0name").is_err());
        assert!(WearablePacket::set_name("bad\nname").is_err());
        assert!(WearablePacket::set_name("ABCDEFGHIJK").is_err());
    }

    #[test]
    fn set_name_modern_packet() {
        let p = WearablePacket::set_name_modern("BTWEARABLE").unwrap();
        assert_command_packet(&p, CommandNumber::SetAdvertisingName);
        assert_eq!(p.data, b"BTWEARABLE\x00");
        assert_roundtrip(&p);
    }

    #[test]
    fn alarm_time_packet() {
        let p = WearablePacket::alarm_time(1700000000);
        assert_command_packet(&p, CommandNumber::SetAlarmTime);
        assert_eq!(p.data[0], 0x01);
        assert_eq!(&p.data[1..5], &1700000000_u32.to_le_bytes());
        assert_roundtrip(&p);
    }

    #[test]
    fn get_alarm_time_packet() {
        let p = WearablePacket::get_alarm_time();
        assert_command_packet(&p, CommandNumber::GetAlarmTime);
        assert_eq!(p.data, vec![0x00]);
        assert_roundtrip(&p);
    }

    #[test]
    fn enable_optical_data_on_off() {
        let on = WearablePacket::enable_optical_data(true);
        assert_command_packet(&on, CommandNumber::EnableOpticalData);
        assert_eq!(on.data, vec![0x01, 0x01]);
        assert_roundtrip(&on);

        let off = WearablePacket::enable_optical_data(false);
        assert_eq!(off.data, vec![0x01, 0x00]);
        assert_roundtrip(&off);
    }

    #[test]
    fn toggle_optical_mode_on_off() {
        let on = WearablePacket::toggle_optical_mode(true);
        assert_command_packet(&on, CommandNumber::ToggleOpticalMode);
        assert_eq!(on.data, vec![0x01, 0x01]);
        assert_roundtrip(&on);

        let off = WearablePacket::toggle_optical_mode(false);
        assert_eq!(off.data, vec![0x01, 0x00]);
        assert_roundtrip(&off);
    }
}
